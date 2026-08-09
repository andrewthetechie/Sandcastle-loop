import assert from "node:assert/strict";
import { test } from "node:test";
import { formatParentPrBody } from "./format-parent-pr-body.mts";

test("formatParentPrBody includes Closes reference and parent info", () => {
  const body = formatParentPrBody({
    parentNumber: 42,
    parentTitle: "Add login page",
    children: [
      { number: 43, title: "Add form component", state: "CLOSED" },
      { number: 44, title: "Add validation", state: "CLOSED" },
    ],
  });
  assert.match(body, /Closes #42/);
  assert.match(body, /Delivers parent issue #42: Add login page/);
  assert.match(body, /### Child issues/);
  assert.match(body, /#43 \(closed\) — Add form component/);
  assert.match(body, /#44 \(closed\) — Add validation/);
});

test("formatParentPrBody handles no children", () => {
  const body = formatParentPrBody({
    parentNumber: 99,
    parentTitle: "Cleanup old configs",
    children: [],
  });
  assert.match(body, /\(no child issues\)/);
  assert.match(body, /Closes #99/);
});

test("formatParentPrBody lists OPEN children with open state", () => {
  const body = formatParentPrBody({
    parentNumber: 7,
    parentTitle: "Refactor auth",
    children: [
      { number: 8, title: "Add token refresh", state: "OPEN" },
      { number: 9, title: "Update middleware", state: "CLOSED" },
    ],
  });
  assert.match(body, /#8 \(open\) — Add token refresh/);
  assert.match(body, /#9 \(closed\) — Update middleware/);
  assert.match(body, /Closes #7/);
});

test("formatParentPrBody is multiline with blank-line separators", () => {
  const body = formatParentPrBody({
    parentNumber: 1,
    parentTitle: "Init project",
    children: [{ number: 2, title: "Scaffold", state: "CLOSED" }],
  });
  const lines = body.split("\n");
  // Should have at least 6 lines: delivers line, blank, child header, child list, blank, closes
  assert.ok(lines.length >= 6);
  // Verify blank line before child issues section
  const childHeaderIdx = lines.findIndex((l) => l === "### Child issues");
  assert.ok(childHeaderIdx > 0);
  assert.equal(lines[childHeaderIdx - 1], "");
  // Verify blank line before closes
  const closesIdx = lines.findIndex((l) => l.startsWith("Closes #"));
  assert.ok(closesIdx > childHeaderIdx);
  assert.equal(lines[closesIdx - 1], "");
});