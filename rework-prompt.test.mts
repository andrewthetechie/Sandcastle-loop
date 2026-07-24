import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SYSTEM_PROMPT_PATH = "./rework-agent-system-prompt-prd.md";
const USER_PROMPT_PATH = "./rework-user-prompt-prd.md";
const COMBINED_PROMPT_PATH = "./rework-prompt-prd.md";

const EXPECTED_SYSTEM_PROMPT = [
  "Your previous attempt was rejected. The findings in your message are your entire scope. Apply the smallest fix for each finding, commit, and stop.",
  "",
  "Do not write narration before your first tool call. Begin with `read` or `edit`.",
  "",
  "## Scope",
  "",
  "In-scope files = the set cited in the findings' `file` fields.",
  "",
  "For each finding:",
  "- Open the cited file and line, read ~10 lines of context.",
  "- Apply the smallest change that satisfies the finding's `remediation`.",
  "- If `remediation` is unclear, implement only what the `problem` description directly requires.",
  "",
  "Do not:",
  "- Inspect or edit files outside the in-scope set.",
  "- Refactor, rename, or restructure beyond what a finding explicitly requires.",
  "- Fix related issues noticed while addressing a finding.",
  "- Rewrite the feature instead of applying the reviewer-requested fix.",
  "- Add tests unless a finding asks for them.",
  "- Delegate to sub-agents or start hidden helpers.",
  "- Change dependency manifests except for the missing-dependency rule below.",
  "- Delete or rewrite an existing import to silence an unresolved-module error.",
  "",
  "## Output",
  "",
  "- Edit only the files cited in findings.",
  "- Run targeted validation only when a cheap confirmation command is obvious.",
  '- `git add <files>` then `git commit -m "<message>"` — mandatory; the host only sees committed history.',
  "- Verify: `git log -1 --stat` must show your fix; `git status -s` must be empty.",
  "",
  "## Missing dependency",
  "",
  "If validation shows an unresolved import, install the missing package. Do not delete or rewrite the import.",
  "",
  "1. Detect the package manager from manifest files; use its native add command.",
  "2. Use the exact package name from the error.",
  "3. Dev dependency if the importer is test code; runtime otherwise.",
  "4. Do not pin a version.",
  "5. Install one package at a time; re-run the failing command before committing.",
  "",
  "## Host-only database validation",
  "",
  "Full PostgreSQL validation runs on the host, not here. Never run `pg-ensure`, `pg_ctl`, `postgres`, `docker`, `sudo`, `su`, or `alembic upgrade`. Make only the source or test change the feedback indicates; the host reruns the full gate after your commit.",
  "",
  "## Completion",
  "",
  "When `git log -1 --stat` shows your fix and `git status -s` is empty, emit:",
  "",
  "<promise>COMPLETE</promise>",
  "",
  "If a finding cannot be addressed without editing outside scope, leave it unaddressed, commit any in-scope fixes, and emit `<promise>COMPLETE</promise>`. The reviewer sees the remaining issue next round.",
  "",
  "If every finding requires out-of-scope edits, or findings are mutually contradictory:",
  "1. Commit any partial in-scope fixes (or nothing).",
  "2. `<blocked>one or two sentences explaining why progress is impossible in scope</blocked>`",
  "3. `<promise>COMPLETE</promise>`",
  "",
  "Expanding scope to satisfy a finding is worse than leaving it unfixed.",
  "",
  "If the cited findings are already satisfied on the current branch:",
  "1. Commit nothing.",
  "2. `<already_satisfied>one or two sentences citing existing files or behavior</already_satisfied>`",
  "3. `<promise>COMPLETE</promise>`",
  "",
].join("\n");

const EXPECTED_USER_PROMPT = [
  "# Task: fix findings for issue #{{ISSUE_NUMBER}} — {{ISSUE_TITLE}}",
  "",
  "## Findings to address",
  "",
  "{{REVIEW_FEEDBACK}}",
  "",
  "## Reference: issue body",
  "",
  "<issue-body>",
  "",
  "{{ISSUE_BODY}}",
  "",
  "</issue-body>",
  "",
].join("\n");

test("rework agent system prompt contains only the static rework instructions", () => {
  const systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf8");

  assert.equal(systemPrompt, EXPECTED_SYSTEM_PROMPT);
  assert.match(systemPrompt, /## Scope/);
  assert.match(systemPrompt, /## Output/);
  assert.match(systemPrompt, /## Completion/);
  assert.match(systemPrompt, /## Missing dependency/);
  assert.doesNotMatch(systemPrompt, /\{\{/);
  assert.doesNotMatch(systemPrompt, /# Findings to address/);
});

test("rework agent treats PostgreSQL validation as host-only", () => {
  const systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf8");

  assert.match(systemPrompt, /Host-only database validation/);
  assert.match(systemPrompt, /Never run .*pg-ensure.*pg_ctl.*alembic upgrade/i);
  assert.match(systemPrompt, /host reruns the full gate/i);
});

test("rework user prompt contains only the slim findings and issue-body template", () => {
  const userPrompt = readFileSync(USER_PROMPT_PATH, "utf8");

  assert.equal(userPrompt, EXPECTED_USER_PROMPT);
  assert.match(userPrompt, /\{\{ISSUE_NUMBER\}\}/);
  assert.match(userPrompt, /\{\{ISSUE_TITLE\}\}/);
  assert.match(userPrompt, /\{\{REVIEW_FEEDBACK\}\}/);
  assert.match(userPrompt, /\{\{ISSUE_BODY\}\}/);
  assert.doesNotMatch(userPrompt, /\{\{PRD_BODY\}\}/);
  assert.doesNotMatch(userPrompt, /\{\{ISSUE_COMMENTS\}\}/);
  assert.doesNotMatch(userPrompt, /<prd>/);
});

test("legacy combined rework prompt omits bulky PRD and comments context", () => {
  const combinedPrompt = readFileSync(COMBINED_PROMPT_PATH, "utf8");

  assert.match(combinedPrompt, /\{\{ISSUE_NUMBER\}\}/);
  assert.match(combinedPrompt, /\{\{ISSUE_TITLE\}\}/);
  assert.match(combinedPrompt, /\{\{REVIEW_FEEDBACK\}\}/);
  assert.match(combinedPrompt, /\{\{ISSUE_BODY\}\}/);
  assert.doesNotMatch(combinedPrompt, /\{\{PRD_BODY\}\}/);
  assert.doesNotMatch(combinedPrompt, /\{\{ISSUE_COMMENTS\}\}/);
  assert.doesNotMatch(combinedPrompt, /<prd>/);
  assert.doesNotMatch(combinedPrompt, /<issue-comments>/);
});
