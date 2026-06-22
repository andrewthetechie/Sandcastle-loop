#!/usr/bin/env python3
"""
Post-hoc metrics rollup for the PRD-driven sandcastle loop.

Reads opencode's SQLite DB and the .sandcastle/logs/ directory to produce
per-issue and per-PRD token usage rollups. Sandcastle's native usage surface
is undefined for opencode, so we go straight to opencode's session store.

Sessions are mapped to (issue, stage, round) by:
  1. Stage classification by model (strix/qwen -> coder, zai/glm -> reviewer)
  2. Time correlation against the mtimes of `.sandcastle/logs/*.log` files,
     whose names encode prd/issue/stage/round
  3. Sub-sessions (e.g. `@explore` subagent) are summed under their root via
     the `parent_id` chain

Usage:
  python3 .sandcastle/metrics.py                # rollup across all PRDs
  python3 .sandcastle/metrics.py --prd 2        # one PRD
  python3 .sandcastle/metrics.py --issue 47     # one issue
  python3 .sandcastle/metrics.py --detail       # per-round breakdown
"""

import argparse
import json
import re
import sqlite3
import subprocess
from collections import defaultdict
from pathlib import Path

OPENCODE_DB = Path.home() / ".local/share/opencode/opencode.db"
LOG_DIR = Path.home() / "lawncare-saas/.sandcastle/logs"
RUN_METRICS_FILES = [
    Path(__file__).resolve().parent / "metrics/runs.jsonl",
    Path.cwd() / ".sandcastle/metrics/runs.jsonl",
]

# Max seconds between session creation and the matching log file's mtime.
# Sessions live for many minutes; log mtime updates throughout.
ROUND_WINDOW_SECONDS = 1800

LOG_NAME_RE = re.compile(
    r"^prd-(\d+)-issue-(\d+)-(coder|reviewer)--\d+-r(\d+)\.log$"
)

EXPLICIT_RUN_STAGES = ("coder", "rework", "reviewer")


def parse_log_name(name):
    m = LOG_NAME_RE.match(name)
    if not m:
        return None
    return {
        "prd": int(m.group(1)),
        "issue": int(m.group(2)),
        "stage": m.group(3),
        "round": int(m.group(4)),
    }


def load_log_entries():
    entries = []
    for p in LOG_DIR.glob("*.log"):
        meta = parse_log_name(p.name)
        if meta is None:
            continue
        meta["mtime_ms"] = int(p.stat().st_mtime * 1000)
        entries.append(meta)
    return entries


def model_info(model_json):
    try:
        m = json.loads(model_json)
        return {
            "provider": m.get("providerID", "?"),
            "model": m.get("modelID") or m.get("id") or "",
            "raw": model_json or "",
        }
    except Exception:
        return {"provider": "?", "model": "", "raw": model_json or ""}


def model_provider(model_json):
    return model_info(model_json)["provider"]


def stage_for(provider):
    if provider in ("strix", "spark"):
        return "coder"
    if provider in ("zai-coding-plan",):
        return "reviewer"
    return None


def load_sessions(db):
    cur = db.cursor()
    rows = cur.execute(
        "select id, parent_id, model, title, "
        "tokens_input, tokens_output, tokens_reasoning, "
        "tokens_cache_read, tokens_cache_write, time_created "
        "from session"
    ).fetchall()
    sessions = {}
    for r in rows:
        info = model_info(r[2])
        sessions[r[0]] = {
            "id": r[0],
            "parent_id": r[1],
            "provider": info["provider"],
            "model": info["model"],
            "model_raw": info["raw"],
            "title": r[3],
            "tokens_input": r[4] or 0,
            "tokens_output": r[5] or 0,
            "tokens_reasoning": r[6] or 0,
            "tokens_cache_read": r[7] or 0,
            "tokens_cache_write": r[8] or 0,
            "time_created": r[9],
        }
    return sessions


def sum_subtree(sessions, root_id):
    children = defaultdict(list)
    for s in sessions.values():
        if s["parent_id"]:
            children[s["parent_id"]].append(s["id"])
    totals = {"input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0}
    stack = [root_id]
    while stack:
        sid = stack.pop()
        s = sessions[sid]
        totals["input"] += s["tokens_input"]
        totals["output"] += s["tokens_output"]
        totals["reasoning"] += s["tokens_reasoning"]
        totals["cache_read"] += s["tokens_cache_read"]
        totals["cache_write"] += s["tokens_cache_write"]
        stack.extend(children.get(sid, []))
    return totals


def correlate(sessions, logs):
    """Map each root session to a log entry (prd, issue, stage, round)."""
    mapping = {}
    for s in sessions.values():
        if s["parent_id"] is not None:
            continue  # not a root
        stage = stage_for(s["provider"])
        if stage is None:
            continue
        sess_t = s["time_created"]
        best = None
        best_delta = None
        for e in logs:
            if e["stage"] != stage:
                continue
            delta = e["mtime_ms"] - sess_t
            if delta < 0 or delta > ROUND_WINDOW_SECONDS * 1000:
                continue
            if best_delta is None or delta < best_delta:
                best = e
                best_delta = delta
        if best is not None:
            mapping[s["id"]] = best
    return mapping


def parse_int(value):
    try:
        return int(value)
    except Exception:
        return None


def load_recorded_runs(paths=RUN_METRICS_FILES):
    runs = []
    seen_paths = set()
    for path in paths:
        path = path.resolve()
        if path in seen_paths:
            continue
        seen_paths.add(path)
        if not path.exists():
            continue
        with path.open("r", encoding="utf8") as f:
            for line_no, line in enumerate(f, 1):
                line = line.strip()
                if not line:
                    continue
                try:
                    record = json.loads(line)
                except json.JSONDecodeError:
                    print(f"Skipping malformed metrics record at {path}:{line_no}")
                    continue
                if record.get("kind") != "sandcastle_agent_run":
                    continue
                prd = parse_int(record.get("prd"))
                issue = parse_int(record.get("issue"))
                round_no = parse_int(record.get("round"))
                runs.append({
                    **record,
                    "prd_int": prd,
                    "issue_int": issue,
                    "round_int": round_no,
                    "started_ms": parse_int(record.get("started_ms")),
                    "ended_ms": parse_int(record.get("ended_ms")),
                    "elapsed_ms": parse_int(record.get("elapsed_ms")),
                })
    return runs


def load_records_of_kind(kind, paths=RUN_METRICS_FILES):
    out = []
    seen = set()
    for path in paths:
        path = path.resolve()
        if path in seen:
            continue
        seen.add(path)
        if not path.exists():
            continue
        with path.open("r", encoding="utf8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if rec.get("kind") == kind:
                    out.append(rec)
    return out


def provider_for_model(model):
    if not model:
        return None
    return str(model).split("/", 1)[0]


def session_matches_run(s, run):
    provider = provider_for_model(run.get("model"))
    if provider and s["provider"] == provider:
        return True
    model = str(run.get("model") or "")
    return bool(model and model in s.get("model_raw", ""))


def correlate_recorded_runs(sessions, runs):
    """Map explicit loop run records to opencode root sessions for token totals."""
    roots = [
        s for s in sessions.values()
        if s["parent_id"] is None
    ]
    roots.sort(key=lambda s: s["time_created"] or 0)
    assigned = set()
    mapping = {}

    for run in sorted(runs, key=lambda r: r.get("started_ms") or 0):
        start = run.get("started_ms")
        end = run.get("ended_ms")
        if start is None or end is None:
            continue
        candidates = []
        # Allow a small clock/launch skew around the measured host run.
        min_t = start - 60_000
        max_t = end + 60_000
        for s in roots:
            if s["id"] in assigned:
                continue
            created = s["time_created"]
            if created is None or created < min_t or created > max_t:
                continue
            if not session_matches_run(s, run):
                continue
            candidates.append(s)
        if not candidates:
            continue
        # Prefer sessions created after the host call started, then closest
        # to start. This avoids stealing a previous run's still-open window.
        candidates.sort(
            key=lambda s: (
                0 if s["time_created"] >= start else 1,
                abs(s["time_created"] - start),
            )
        )
        best = candidates[0]
        assigned.add(best["id"])
        mapping[run["run_id"]] = best["id"]
    return mapping


def empty_totals():
    return {"input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0}


def new_round_rollup():
    return defaultdict(empty_totals)


def new_issue_rollup():
    return {
        "coder_total": 0,
        "rework_total": 0,
        "reviewer_total": 0,
        "coder_rounds": set(),
        "rework_rounds": set(),
        "reviewer_rounds": set(),
    }


def new_prd_rollup():
    return {
        "issues": set(),
        "coder_total": 0,
        "rework_total": 0,
        "reviewer_total": 0,
        "coder_rounds": 0,
        "rework_rounds": 0,
        "reviewer_rounds": 0,
        "elapsed_s": 0.0,
    }


def rollup_token_total(d):
    return d["coder_total"] + d["rework_total"] + d["reviewer_total"]


def filter_explicit_runs(runs, prd_filter=None, issue_filter=None):
    """Keep explicit loop agent runs for coder, rework, and reviewer stages."""
    return [
        r for r in runs
        if r.get("stage") in EXPLICIT_RUN_STAGES
        and r.get("prd_int") is not None
        and r.get("issue_int") is not None
        and r.get("round_int") is not None
        and (prd_filter is None or r["prd_int"] == prd_filter)
        and (issue_filter is None or r["issue_int"] == issue_filter)
    ]


def build_rollups_from_round_rollup(round_rollup, issue_elapsed_s=None):
    """Build per-issue and per-PRD rollups from round-level token totals."""
    if issue_elapsed_s is None:
        issue_elapsed_s = {}

    issue_rollup = defaultdict(new_issue_rollup)
    for (prd, issue, stage, rnd), r in round_rollup.items():
        d = issue_rollup[(prd, issue)]
        d[f"{stage}_total"] += r["input"] + r["output"] + r["reasoning"]
        d[f"{stage}_rounds"].add(rnd)

    prd_rollup = defaultdict(new_prd_rollup)
    for (prd, issue), d in issue_rollup.items():
        p = prd_rollup[prd]
        p["issues"].add(issue)
        p["coder_total"] += d["coder_total"]
        p["rework_total"] += d["rework_total"]
        p["reviewer_total"] += d["reviewer_total"]
        p["coder_rounds"] += len(d["coder_rounds"])
        p["rework_rounds"] += len(d["rework_rounds"])
        p["reviewer_rounds"] += len(d["reviewer_rounds"])
        p["elapsed_s"] += issue_elapsed_s.get((prd, issue), 0.0)

    return issue_rollup, prd_rollup


def fmt_elapsed(seconds):
    if seconds is None or seconds <= 0:
        return "-"
    if seconds < 60:
        return f"{int(seconds)}s"
    if seconds < 3600:
        return f"{int(seconds // 60)}m{int(seconds % 60):02d}s"
    return f"{int(seconds // 3600)}h{int((seconds % 3600) // 60):02d}m"


def fmt_tpm(tokens, seconds):
    if seconds is None or seconds <= 0:
        return "-"
    return f"{int(tokens / (seconds / 60)):,}"


STUCK_PATTERNS = [
    ("blocked", "Coder signaled blocked"),
    ("validation_failed", "Validation failed"),
    ("no_commits", "No commits produced"),
    ("needs_human_review", "Reviewer flagged human review"),
    ("review_rejected", "Reviewer requested changes"),
]


def categorize_stuck(comment_body):
    for label, marker in STUCK_PATTERNS:
        if marker in comment_body:
            return label
    return "other"


def fetch_stuck_reasons(prd_filter):
    """For each issue labeled agent-stuck (optionally PRD-filtered), find the
    latest 'Agent gave up after' comment and categorize it by its content.
    Returns dict[issue_number] = {reason, snippet}.
    """
    args = [
        "gh", "issue", "list",
        "--label", "agent-stuck",
        "--json", "number,labels",
        "--state", "all",
        "--limit", "200",
    ]
    out = subprocess.run(args, capture_output=True, text=True, check=True).stdout
    issues = json.loads(out)
    reasons = {}
    for issue in issues:
        labels = {l["name"] for l in issue.get("labels", [])}
        if prd_filter is not None:
            label = f"prd-{prd_filter:03d}"
            if label not in labels:
                continue
        n = issue["number"]
        cv = subprocess.run(
            ["gh", "issue", "view", str(n), "--json", "comments"],
            capture_output=True, text=True, check=True,
        ).stdout
        comments = json.loads(cv).get("comments", [])
        for c in reversed(comments):
            body = c.get("body", "")
            if body.startswith("Agent gave up after"):
                reasons[n] = {
                    "reason": categorize_stuck(body),
                    "snippet": body[:300].replace("\n", " "),
                }
                break
    return reasons


def print_validation_rollup(prd_filter, issue_filter):
    recs = load_records_of_kind("sandcastle_validation_run")
    per_issue = defaultdict(float)
    per_prd = defaultdict(float)
    per_cmd = defaultdict(lambda: [0.0, 0])  # [seconds, runs]
    found = False
    for r in recs:
        prd = parse_int(r.get("prd"))
        issue = parse_int(r.get("issue"))
        if prd_filter is not None and prd != prd_filter:
            continue
        if issue_filter is not None and issue != issue_filter:
            continue
        found = True
        secs = (parse_int(r.get("elapsed_ms")) or 0) / 1000.0
        per_prd[prd] += secs
        if issue is not None:
            per_issue[(prd, issue)] += secs
        cmd = r.get("command", "?")
        per_cmd[cmd][0] += secs
        per_cmd[cmd][1] += 1
    if not found:
        return
    print()
    print("Validation time per command:")
    print(f"{'Command':<40}{'Runs':>8}{'Total':>10}")
    print("-" * 58)
    for cmd in sorted(per_cmd.keys(), key=lambda c: -per_cmd[c][0]):
        secs, runs = per_cmd[cmd]
        print(f"{cmd[:40]:<40}{runs:>8}{fmt_elapsed(secs):>10}")
    print()
    print("Validation time per issue:")
    print(f"{'PRD':<5}{'Issue':<8}{'Validation':>12}")
    print("-" * 25)
    for (prd, issue) in sorted(per_issue.keys()):
        print(f"{prd:<5}{issue:<8}{fmt_elapsed(per_issue[(prd, issue)]):>12}")
    print()
    print("Validation time per PRD:")
    print(f"{'PRD':<5}{'Validation':>12}")
    print("-" * 17)
    for prd in sorted(per_prd.keys()):
        print(f"{prd:<5}{fmt_elapsed(per_prd[prd]):>12}")


def print_outcome_rollup(prd_filter, issue_filter):
    recs = load_records_of_kind("sandcastle_issue_outcome")
    rows = []
    by_outcome = defaultdict(int)
    for r in recs:
        prd = parse_int(r.get("prd"))
        issue = parse_int(r.get("issue"))
        if prd_filter is not None and prd != prd_filter:
            continue
        if issue_filter is not None and issue != issue_filter:
            continue
        outcome = r.get("outcome", "?")
        rounds = parse_int(r.get("rounds_used")) or 0
        rows.append((prd, issue, outcome, rounds))
        by_outcome[outcome] += 1
    if not rows:
        return
    print()
    print("Issue outcomes:")
    print(f"{'PRD':<5}{'Issue':<8}{'Outcome':<24}{'Rounds':>8}")
    print("-" * 45)
    for (prd, issue, outcome, rounds) in sorted(rows):
        print(f"{prd:<5}{issue:<8}{outcome:<24}{rounds:>8}")
    print()
    print("Outcome totals:")
    for outcome in sorted(by_outcome.keys()):
        print(f"  {outcome:<24}{by_outcome[outcome]:>5}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--prd", type=int)
    ap.add_argument("--issue", type=int)
    ap.add_argument("--detail", action="store_true", help="per-round breakdown")
    ap.add_argument(
        "--stuck", action="store_true",
        help="fetch agent-stuck issue comments via gh and categorize reasons (slow)",
    )
    args = ap.parse_args()

    db = sqlite3.connect(str(OPENCODE_DB))
    sessions = load_sessions(db)
    logs = load_log_entries()
    if not logs:
        logs = []

    recorded_runs = filter_explicit_runs(
        load_recorded_runs(),
        prd_filter=args.prd,
        issue_filter=args.issue,
    )

    use_recorded_runs = bool(recorded_runs)

    # rollups keyed by (prd, issue, stage, round) and (prd, issue) and (prd,)
    round_rollup = new_round_rollup()

    # Per-issue elapsed = sum of per-agent elapsed. Doing it this way avoids
    # double-counting idle gaps between retry attempts (an issue retried days
    # apart shouldn't count as "ran for days").
    issue_elapsed_s = defaultdict(float)  # (prd, issue) -> seconds
    unmapped_recorded_runs = []

    if use_recorded_runs:
        run_session_mapping = correlate_recorded_runs(sessions, recorded_runs)
        for run in recorded_runs:
            sid = run_session_mapping.get(run["run_id"])
            totals = sum_subtree(sessions, sid) if sid else empty_totals()
            key = (
                run["prd_int"],
                run["issue_int"],
                run["stage"],
                run["round_int"],
            )
            for k, v in totals.items():
                round_rollup[key][k] += v
            elapsed_ms = run.get("elapsed_ms")
            if elapsed_ms and elapsed_ms > 0:
                issue_elapsed_s[(run["prd_int"], run["issue_int"])] += elapsed_ms / 1000.0
            if sid is None:
                unmapped_recorded_runs.append(run)
    else:
        if not logs:
            searched = ", ".join(str(p) for p in RUN_METRICS_FILES)
            print(f"No explicit run metrics found. Searched: {searched}")
            print(f"No log files found in {LOG_DIR}")
            return
        mapping = correlate(sessions, logs)
        for sid, meta in mapping.items():
            if args.prd is not None and meta["prd"] != args.prd:
                continue
            if args.issue is not None and meta["issue"] != args.issue:
                continue
            totals = sum_subtree(sessions, sid)
            key = (meta["prd"], meta["issue"], meta["stage"], meta["round"])
            for k, v in totals.items():
                round_rollup[key][k] += v
            round_elapsed = (meta["mtime_ms"] - sessions[sid]["time_created"]) / 1000.0
            if round_elapsed > 0:
                issue_elapsed_s[(meta["prd"], meta["issue"])] += round_elapsed

    issue_rollup, prd_rollup = build_rollups_from_round_rollup(
        round_rollup, issue_elapsed_s
    )

    # ---- Output ----
    if args.detail:
        print(f"{'PRD':<5}{'Issue':<7}{'Stage':<10}{'Round':<7}{'Input':>12}{'Output':>12}{'Reasoning':>12}")
        print("-" * 65)
        for k in sorted(round_rollup.keys()):
            prd, issue, stage, rnd = k
            r = round_rollup[k]
            print(f"{prd:<5}{issue:<7}{stage:<10}{rnd:<7}{r['input']:>12,}{r['output']:>12,}{r['reasoning']:>12,}")
        print()

    issue_hdr = (
        f"{'PRD':<5}{'Issue':<7}"
        f"{'Coder rds':<11}{'Rework rds':<12}{'Rev rds':<9}"
        f"{'Coder tokens':>14}{'Rework tokens':>14}{'Rev tokens':>14}"
        f"{'Total':>14}{'Elapsed':>10}{'Tok/min':>10}"
    )
    print(issue_hdr)
    print("-" * len(issue_hdr))
    for (prd, issue) in sorted(issue_rollup.keys()):
        d = issue_rollup[(prd, issue)]
        total = rollup_token_total(d)
        elapsed_s = issue_elapsed_s.get((prd, issue)) or None
        print(
            f"{prd:<5}{issue:<7}"
            f"{len(d['coder_rounds']):<11}{len(d['rework_rounds']):<12}{len(d['reviewer_rounds']):<9}"
            f"{d['coder_total']:>14,}{d['rework_total']:>14,}{d['reviewer_total']:>14,}{total:>14,}"
            f"{fmt_elapsed(elapsed_s):>10}{fmt_tpm(total, elapsed_s):>10}"
        )

    print()
    prd_hdr = (
        f"{'PRD':<5}{'Issues':<9}"
        f"{'Coder rds':<11}{'Rework rds':<12}{'Rev rds':<9}"
        f"{'Coder tokens':>14}{'Rework tokens':>14}{'Rev tokens':>14}"
        f"{'Total':>14}{'Elapsed':>10}{'Tok/min':>10}"
    )
    print(prd_hdr)
    print("-" * len(prd_hdr))
    for prd in sorted(prd_rollup.keys()):
        p = prd_rollup[prd]
        total = rollup_token_total(p)
        print(
            f"{prd:<5}{len(p['issues']):<9}"
            f"{p['coder_rounds']:<11}{p['rework_rounds']:<12}{p['reviewer_rounds']:<9}"
            f"{p['coder_total']:>14,}{p['rework_total']:>14,}{p['reviewer_total']:>14,}{total:>14,}"
            f"{fmt_elapsed(p['elapsed_s']):>10}{fmt_tpm(total, p['elapsed_s']):>10}"
        )

    print_validation_rollup(args.prd, args.issue)
    print_outcome_rollup(args.prd, args.issue)

    if args.stuck:
        print()
        print("Fetching agent-stuck reasons via gh... (one call per stuck issue)")
        try:
            reasons = fetch_stuck_reasons(args.prd)
        except subprocess.CalledProcessError as e:
            print(f"  gh call failed: {e.stderr or e}")
            reasons = {}
        if not reasons:
            print("  (no agent-stuck issues found for the selected scope)")
        else:
            by_reason = defaultdict(list)
            for issue_n, info in reasons.items():
                by_reason[info["reason"]].append(issue_n)
            print()
            print(f"{'Reason':<22}{'Count':>6}  Issues")
            print("-" * 70)
            for reason in sorted(by_reason.keys()):
                ns = sorted(by_reason[reason])
                ns_str = ", ".join(f"#{n}" for n in ns)
                print(f"{reason:<22}{len(ns):>6}  {ns_str}")
            # show a per-issue one-liner snippet for context
            print()
            print("Per-issue stuck snippets:")
            for n in sorted(reasons.keys()):
                info = reasons[n]
                print(f"  #{n:<5} [{info['reason']:<20}] {info['snippet'][:160]}")

    if use_recorded_runs:
        if unmapped_recorded_runs:
            print(
                f"\n(Note: {len(unmapped_recorded_runs)} recorded run(s) had exact elapsed time but could not be matched to an opencode session for tokens.)"
            )
    else:
        # Sanity: count unmapped sessions
        mapped_ids = set(mapping.keys())
        unmapped_roots = [
            s for s in sessions.values()
            if s["parent_id"] is None
            and stage_for(s["provider"]) in ("coder", "reviewer")
            and s["id"] not in mapped_ids
        ]
        if unmapped_roots:
            print(f"\n(Note: {len(unmapped_roots)} root coder/reviewer session(s) could not be mapped to a log file — usually because the log file was rotated or the session pre-dates the current logs.)")


if __name__ == "__main__":
    main()
