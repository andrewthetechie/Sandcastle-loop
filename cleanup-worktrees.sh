#!/usr/bin/env bash
#
# cleanup-worktrees.sh — remove leftover sandcastle worktrees that eat disk.
#
# run-prd.mts / run-prd-extra-reviews.mts create managed git worktrees under
# <repo>/.sandcastle/worktrees/ and normally remove them in sandbox.close().
# When the loop crashes or is killed those worktrees leak and pile up, which is
# what filled the VM disk.
#
# This enumerates registered worktrees via `git worktree list`, keeps only the
# managed ones (path under .sandcastle/worktrees/), and removes them. It also
# sweeps orphaned directories git no longer tracks and prunes worktree admin
# files.
#
# Safe by default:
#   - skips worktrees with uncommitted tracked changes (override: --include-dirty)
#   - skips the worktree you're currently standing in
#   - prompts before deleting (override: --yes)
#   - --dry-run shows what would happen and changes nothing
#
# Stop the loop before running, OR use --age-minutes to avoid touching the
# worktree the running loop is currently using.
#
# Usage:
#   ./cleanup-worktrees.sh [--dry-run] [--yes] [--age-minutes N]
#                          [--include-dirty] [--prune-branches]
#
# Examples:
#   ./cleanup-worktrees.sh --dry-run            # preview only
#   ./cleanup-worktrees.sh --yes                # remove all managed worktrees
#   ./cleanup-worktrees.sh --age-minutes 60     # only ones idle > 1h (loop-safe)
#   ./cleanup-worktrees.sh --yes --prune-branches

set -euo pipefail

DRY_RUN=0
ASSUME_YES=0
AGE_MINUTES=0
INCLUDE_DIRTY=0
PRUNE_BRANCHES=0

usage() {
  sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1 ;;
    -y|--yes) ASSUME_YES=1 ;;
    --age-minutes)
      shift
      AGE_MINUTES="${1:-}"
      case "$AGE_MINUTES" in
        ''|*[!0-9]*) echo "error: --age-minutes needs a non-negative integer" >&2; exit 2 ;;
      esac
      ;;
    --include-dirty) INCLUDE_DIRTY=1 ;;
    --prune-branches) PRUNE_BRANCHES=1 ;;
    -h|--help) usage 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage 2 ;;
  esac
  shift
done

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "error: not inside a git repository" >&2
  exit 1
fi

# Resolve the main repo root (parent of the common .git dir) so we can sweep
# orphaned directories even when none are registered as worktrees anymore.
common_git=$(git rev-parse --git-common-dir)
case "$common_git" in
  /*) ;;
  *) common_git="$(pwd)/$common_git" ;;
esac
repo_root=$(cd "$common_git/.." && pwd)
worktrees_root="$repo_root/.sandcastle/worktrees"

current_toplevel=$(git rev-parse --show-toplevel 2>/dev/null || echo "")
main_branch=$(git -C "$repo_root" rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
now=$(date +%s)

# --- collect managed worktrees ------------------------------------------------

SEL_PATHS=()
SEL_BRANCHES=()
SEL_SIZES_K=()
SEL_NOTES=()
total_k=0

consider() {
  local path="$1" branch="$2"
  [ -n "$path" ] || return 0
  case "$path" in
    */.sandcastle/worktrees/*) ;;
    *) return 0 ;;  # not a managed worktree
  esac

  if [ "$path" = "$current_toplevel" ]; then
    echo "  skip (current worktree): $path"
    return 0
  fi

  # Age gate (mtime of the worktree dir; heuristic but loop-safe).
  local mtime idle_min=999999
  mtime=$(date -r "$path" +%s 2>/dev/null || stat -c %Y "$path" 2>/dev/null || echo "")
  if [ -n "$mtime" ]; then
    idle_min=$(( (now - mtime) / 60 ))
  fi
  if [ "$AGE_MINUTES" -gt 0 ] && [ "$idle_min" -lt "$AGE_MINUTES" ]; then
    echo "  skip (idle ${idle_min}m < ${AGE_MINUTES}m): $branch"
    return 0
  fi

  # Dirty gate (tracked changes only — untracked build junk shouldn't protect).
  local dirty="clean"
  if [ -d "$path" ]; then
    if [ -n "$(git -C "$path" status --porcelain --untracked-files=no 2>/dev/null)" ]; then
      dirty="DIRTY"
    fi
  else
    dirty="missing-dir"
  fi
  if [ "$dirty" = "DIRTY" ] && [ "$INCLUDE_DIRTY" -ne 1 ]; then
    echo "  skip (uncommitted changes, use --include-dirty): $branch"
    return 0
  fi

  local size_k=0
  if [ -d "$path" ]; then
    size_k=$(du -sk "$path" 2>/dev/null | awk '{print $1}')
    [ -n "$size_k" ] || size_k=0
  fi

  SEL_PATHS+=("$path")
  SEL_BRANCHES+=("$branch")
  SEL_SIZES_K+=("$size_k")
  SEL_NOTES+=("${dirty}, idle ${idle_min}m")
  total_k=$(( total_k + size_k ))
}

cur_path=""
cur_branch="(detached)"
while IFS= read -r line; do
  case "$line" in
    "worktree "*) cur_path="${line#worktree }" ;;
    "branch "*) cur_branch="${line#branch }"; cur_branch="${cur_branch#refs/heads/}" ;;
    "detached") cur_branch="(detached)" ;;
    "") consider "$cur_path" "$cur_branch"; cur_path=""; cur_branch="(detached)" ;;
  esac
done < <(git worktree list --porcelain)
consider "$cur_path" "$cur_branch"  # final record (no trailing blank)

# --- find orphaned directories (not registered as worktrees) ------------------

ORPHANS=()
if [ -d "$worktrees_root" ]; then
  # Normalize both sides to physical paths: `git worktree list` reports
  # symlink-resolved paths (e.g. /private/var on macOS) while a glob keeps the
  # logical path, and a mismatch would wrongly flag a live worktree as orphan.
  registered_phys=""
  while IFS= read -r wp; do
    [ -n "$wp" ] || continue
    [ -d "$wp" ] && wp=$(cd "$wp" && pwd -P)
    registered_phys+="$wp"$'\n'
  done < <(git worktree list --porcelain | sed -n 's/^worktree //p')

  for d in "$worktrees_root"/*; do
    [ -d "$d" ] || continue
    abs=$(cd "$d" && pwd -P)
    if ! printf '%s' "$registered_phys" | grep -Fxq "$abs"; then
      ORPHANS+=("$abs")
    fi
  done
fi

# --- report -------------------------------------------------------------------

human() { awk -v k="$1" 'BEGIN{ s="KMGT"; v=k; i=1; while (v>=1024 && i<4){v/=1024;i++} printf "%.1f%s", v, substr(s,i,1) }'; }

if [ "${#SEL_PATHS[@]}" -eq 0 ] && [ "${#ORPHANS[@]}" -eq 0 ]; then
  echo "Nothing to clean: no managed worktrees under $worktrees_root"
  git worktree prune
  exit 0
fi

echo ""
echo "Managed worktrees to remove (${#SEL_PATHS[@]}):"
for i in "${!SEL_PATHS[@]}"; do
  printf "  [%7s] %-32s (%s)\n    %s\n" \
    "$(human "${SEL_SIZES_K[$i]}")" "${SEL_BRANCHES[$i]}" "${SEL_NOTES[$i]}" "${SEL_PATHS[$i]}"
done

if [ "${#ORPHANS[@]}" -gt 0 ]; then
  echo ""
  echo "Orphaned directories to delete (${#ORPHANS[@]}):"
  for d in "${ORPHANS[@]}"; do
    ok=$(du -sk "$d" 2>/dev/null | awk '{print $1}'); [ -n "$ok" ] || ok=0
    total_k=$(( total_k + ok ))
    printf "  [%7s] %s\n" "$(human "$ok")" "$d"
  done
fi

echo ""
echo "Total reclaimable: ~$(human "$total_k")"

if [ "$DRY_RUN" -eq 1 ]; then
  echo ""
  echo "(dry run — nothing deleted)"
  exit 0
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  echo ""
  printf "Proceed with deletion? [y/N] "
  read -r reply </dev/tty || reply=""
  case "$reply" in
    y|Y|yes|YES) ;;
    *) echo "aborted."; exit 0 ;;
  esac
fi

# --- remove -------------------------------------------------------------------

echo ""
for i in "${!SEL_PATHS[@]}"; do
  path="${SEL_PATHS[$i]}"
  branch="${SEL_BRANCHES[$i]}"
  echo "removing worktree: $path"
  if ! git worktree remove --force "$path" 2>/dev/null; then
    echo "  git worktree remove failed; rm -rf fallback"
    rm -rf "$path"
  fi

  if [ "$PRUNE_BRANCHES" -eq 1 ] && [ -n "$branch" ] && [ "$branch" != "(detached)" ] \
     && [ "$branch" != "$main_branch" ]; then
    if git -C "$repo_root" branch -D "$branch" 2>/dev/null; then
      echo "  deleted local branch: $branch"
    fi
  fi
done

for d in "${ORPHANS[@]}"; do
  echo "deleting orphan dir: $d"
  rm -rf "$d"
done

git worktree prune
echo ""
echo "Done. Reclaimed ~$(human "$total_k"). Run 'git worktree list' to verify."
