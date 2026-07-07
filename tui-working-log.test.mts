import assert from "node:assert/strict";
import { test } from "node:test";
import { formatWorkingLogLines } from "./tui-working-log.mts";

test("toolCall event formats to a compact arrow line", () => {
  const lines = formatWorkingLogLines({
    type: "toolCall",
    name: "Bash",
    formattedArgs: "git status -s",
    iteration: 2,
    timestamp: new Date("2026-07-02T12:00:00Z"),
  });
  assert.deepEqual(lines, ["→ Bash(git status -s)"]);
});

test("toolCall with no formatted args renders empty parens", () => {
  const lines = formatWorkingLogLines({ type: "toolCall", name: "Read" });
  assert.deepEqual(lines, ["→ Read()"]);
});

test("text event yields its non-empty, right-trimmed lines", () => {
  const lines = formatWorkingLogLines({
    type: "text",
    message: "Checking status  \n\nNow editing the file   ",
    iteration: 1,
  });
  assert.deepEqual(lines, ["Checking status", "Now editing the file"]);
});

test("text event carried on a text/content field is also formatted", () => {
  assert.deepEqual(
    formatWorkingLogLines({ type: "reasoning", text: "thinking hard" }),
    ["thinking hard"],
  );
  assert.deepEqual(
    formatWorkingLogLines({ type: "message", content: "final answer" }),
    ["final answer"],
  );
});

test("ignored and malformed events format to nothing without throwing", () => {
  const cases: unknown[] = [
    null,
    undefined,
    42,
    "toolCall",
    { type: "raw", line: '{"type":"tool_call"}' },
    { type: "toolResult", output: "ok" },
    { type: "toolCall" },
    { type: "toolCall", name: 1, formattedArgs: "x" },
    { type: "text", message: "   \n  \n" },
    { type: "text" },
  ];
  for (const event of cases) {
    assert.deepEqual(formatWorkingLogLines(event), []);
  }
});
