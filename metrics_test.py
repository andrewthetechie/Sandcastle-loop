#!/usr/bin/env python3
"""Fixture-backed tests for metrics.py rework attribution."""

import unittest
from pathlib import Path

import metrics

FIXTURE = (
    Path(__file__).resolve().parent
    / "test/fixtures/metrics/rework-attribution-runs.jsonl"
)


def round_totals(input_tokens=0, output_tokens=0, reasoning_tokens=0):
    return {
        "input": input_tokens,
        "output": output_tokens,
        "reasoning": reasoning_tokens,
        "cache_read": 0,
        "cache_write": 0,
    }


class ReworkAttributionTest(unittest.TestCase):
    def test_fixture_includes_rework_and_excludes_other_stages(self):
        runs = metrics.load_recorded_runs([FIXTURE])
        filtered = metrics.filter_explicit_runs(runs)

        stages = {r["stage"] for r in filtered}
        self.assertEqual(stages, {"coder", "rework", "reviewer"})
        self.assertEqual(len(filtered), 3)

        run_ids = {r["run_id"] for r in filtered}
        self.assertIn("fixture-rework-r2", run_ids)
        self.assertNotIn("fixture-code-quality", run_ids)

    def test_rollups_keep_rework_separate_from_coder(self):
        round_rollup = metrics.new_round_rollup()
        round_rollup[(3, 19, "coder", 1)] = round_totals(100, 10, 5)
        round_rollup[(3, 19, "rework", 2)] = round_totals(200, 20, 10)
        round_rollup[(3, 19, "reviewer", 2)] = round_totals(50, 5, 0)

        issue_rollup, prd_rollup = metrics.build_rollups_from_round_rollup(
            round_rollup
        )
        issue = issue_rollup[(3, 19)]
        prd = prd_rollup[3]

        self.assertEqual(issue["coder_total"], 115)
        self.assertEqual(issue["rework_total"], 230)
        self.assertEqual(issue["reviewer_total"], 55)
        self.assertEqual(metrics.rollup_token_total(issue), 400)

        self.assertEqual(len(issue["coder_rounds"]), 1)
        self.assertEqual(len(issue["rework_rounds"]), 1)
        self.assertEqual(len(issue["reviewer_rounds"]), 1)

        self.assertEqual(prd["coder_total"], 115)
        self.assertEqual(prd["rework_total"], 230)
        self.assertEqual(prd["reviewer_total"], 55)
        self.assertEqual(prd["coder_rounds"], 1)
        self.assertEqual(prd["rework_rounds"], 1)
        self.assertEqual(prd["reviewer_rounds"], 1)
        self.assertEqual(metrics.rollup_token_total(prd), 400)

    def test_rework_not_counted_as_coder(self):
        """Regression guard: rework tokens must not inflate coder totals."""
        round_rollup = metrics.new_round_rollup()
        round_rollup[(3, 19, "coder", 1)] = round_totals(1000, 0, 0)
        round_rollup[(3, 19, "rework", 2)] = round_totals(500, 0, 0)

        issue_rollup, _ = metrics.build_rollups_from_round_rollup(round_rollup)
        issue = issue_rollup[(3, 19)]

        self.assertEqual(issue["coder_total"], 1000)
        self.assertEqual(issue["rework_total"], 500)
        self.assertNotEqual(issue["coder_total"], 1500)


if __name__ == "__main__":
    unittest.main()
