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

# Max seconds between session creation and the matching log file's mtime.
# Sessions live for many minutes; log mtime updates throughout.
ROUND_WINDOW_SECONDS = 1800

LOG_NAME_RE = re.compile(
    r"^prd-(\d+)-issue-(\d+)-(coder|reviewer)--\d+-r(\d+)\.log$"
)


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


def model_provider(model_json):
    try:
        m = json.loads(model_json)
        return m.get("providerID", "?")
    except Exception:
        return "?"


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
        sessions[r[0]] = {
            "id": r[0],
            "parent_id": r[1],
            "provider": model_provider(r[2]),
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
        print(f"No log files found in {LOG_DIR}")
        return
    mapping = correlate(sessions, logs)

    # rollups keyed by (prd, issue, stage, round) and (prd, issue) and (prd,)
    round_rollup = defaultdict(lambda: {"input": 0, "output": 0, "reasoning": 0, "cache_read": 0, "cache_write": 0})

    # Per-issue elapsed = sum of per-round elapsed. Doing it this way avoids
    # double-counting idle gaps between retry attempts (an issue retried days
    # apart shouldn't count as "ran for days").
    issue_elapsed_s = defaultdict(float)  # (prd, issue) -> seconds

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

    # Per-issue
    issue_rollup = defaultdict(lambda: {
        "coder_total": 0, "reviewer_total": 0,
        "coder_rounds": set(), "reviewer_rounds": set(),
    })
    for (prd, issue, stage, rnd), r in round_rollup.items():
        d = issue_rollup[(prd, issue)]
        d[f"{stage}_total"] += r["input"] + r["output"] + r["reasoning"]
        d[f"{stage}_rounds"].add(rnd)

    # Per-PRD
    prd_rollup = defaultdict(lambda: {
        "issues": set(), "coder_total": 0, "reviewer_total": 0,
        "coder_rounds": 0, "reviewer_rounds": 0,
        "elapsed_s": 0.0,
    })
    for (prd, issue), d in issue_rollup.items():
        p = prd_rollup[prd]
        p["issues"].add(issue)
        p["coder_total"] += d["coder_total"]
        p["reviewer_total"] += d["reviewer_total"]
        p["coder_rounds"] += len(d["coder_rounds"])
        p["reviewer_rounds"] += len(d["reviewer_rounds"])
        p["elapsed_s"] += issue_elapsed_s.get((prd, issue), 0.0)

    # ---- Output ----
    if args.detail:
        print(f"{'PRD':<5}{'Issue':<7}{'Stage':<10}{'Round':<7}{'Input':>12}{'Output':>12}{'Reasoning':>12}")
        print("-" * 65)
        for k in sorted(round_rollup.keys()):
            prd, issue, stage, rnd = k
            r = round_rollup[k]
            print(f"{prd:<5}{issue:<7}{stage:<10}{rnd:<7}{r['input']:>12,}{r['output']:>12,}{r['reasoning']:>12,}")
        print()

    print(f"{'PRD':<5}{'Issue':<7}{'Coder rds':<11}{'Rev rds':<9}{'Coder tokens':>14}{'Rev tokens':>14}{'Total':>14}{'Elapsed':>10}{'Tok/min':>10}")
    print("-" * 98)
    for (prd, issue) in sorted(issue_rollup.keys()):
        d = issue_rollup[(prd, issue)]
        total = d["coder_total"] + d["reviewer_total"]
        elapsed_s = issue_elapsed_s.get((prd, issue)) or None
        print(
            f"{prd:<5}{issue:<7}"
            f"{len(d['coder_rounds']):<11}{len(d['reviewer_rounds']):<9}"
            f"{d['coder_total']:>14,}{d['reviewer_total']:>14,}{total:>14,}"
            f"{fmt_elapsed(elapsed_s):>10}{fmt_tpm(total, elapsed_s):>10}"
        )

    print()
    print(f"{'PRD':<5}{'Issues':<9}{'Coder rds':<11}{'Rev rds':<9}{'Coder tokens':>14}{'Rev tokens':>14}{'Total':>14}{'Elapsed':>10}{'Tok/min':>10}")
    print("-" * 100)
    for prd in sorted(prd_rollup.keys()):
        p = prd_rollup[prd]
        total = p["coder_total"] + p["reviewer_total"]
        print(
            f"{prd:<5}{len(p['issues']):<9}{p['coder_rounds']:<11}{p['reviewer_rounds']:<9}"
            f"{p['coder_total']:>14,}{p['reviewer_total']:>14,}{total:>14,}"
            f"{fmt_elapsed(p['elapsed_s']):>10}{fmt_tpm(total, p['elapsed_s']):>10}"
        )

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
