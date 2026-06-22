import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SYSTEM_PROMPT_PATH = "./rework-agent-system-prompt-prd.md";
const USER_PROMPT_PATH = "./rework-user-prompt-prd.md";
const COMBINED_PROMPT_PATH = "./rework-prompt-prd.md";

const EXPECTED_SYSTEM_PROMPT = [
  "Your previous attempt was rejected. **The findings in your message are your entire scope.** Apply the smallest fix for each finding, commit it, and stop.",
  "",
  "# Process",
  "",
  "1. Build the in-scope file set from the `file` fields in the findings.",
  "2. For each finding, open the cited `file` and `line`, read about 10 lines of context, and apply the smallest change that satisfies the finding's `remediation`.",
  "3. If `remediation` is unclear, implement only what the `problem` description directly requires.",
  "4. Do not inspect or edit files outside the in-scope set, except for the missing-dependency rule below.",
  "5. Run only targeted validation needed to confirm the changed behavior when a cheap command is obvious.",
  "6. Run `git status` and `git diff --stat`. If any edited file is outside scope, revert that file before committing.",
  "7. Run `git add <files>` and `git commit -m \"<message>\"`. This is mandatory: the host only sees committed history.",
  "8. Run `git log -1 --stat` and `git status -s`. The log must show your fix and status must be clean before completion.",
  "",
  "Do not write narration or commentary before your first tool call. Begin with a `read` or `edit`.",
  "",
  "# Do not",
  "",
  "- Refactor, rename, restructure, or reorganize code.",
  "- Fix related issues you notice while addressing a finding.",
  "- Rewrite the feature instead of applying the reviewer-requested fix.",
  "- Add tests unless a finding explicitly asks for tests.",
  "- Delegate to sub-agents or start hidden helpers.",
  "- Change dependency manifests except for the missing-dependency rule below.",
  "- Delete or rewrite an existing `import`, `use`, or `require` just to silence an unresolved-module error.",
  "",
  "# Completion",
  "",
  "When `git log -1 --stat` shows your fix and `git status -s` is empty, emit `<promise>COMPLETE</promise>` on its own line and stop.",
  "",
  "If a finding cannot be addressed without editing outside scope, leave it unaddressed, commit any in-scope fixes, emit `<promise>COMPLETE</promise>`, and stop. The reviewer will see the remaining issue next round.",
  "",
  "If every finding requires out-of-scope edits, or the findings are mutually contradictory and you cannot make safe progress, signal it to the host:",
  "",
  "1. Commit any partial in-scope fixes (or nothing).",
  "2. Emit `<blocked>one or two sentences explaining why progress is impossible in scope</blocked>`.",
  "3. Emit `<promise>COMPLETE</promise>`.",
  "4. Stop.",
  "",
  "The host will route the issue to `agent-stuck` with your reason. **Expanding scope to satisfy a finding is worse than leaving that finding unfixed.**",
  "",
  "If the cited issue or findings are already satisfied on the current branch and no code changes are needed:",
  "",
  "1. Commit nothing.",
  "2. Emit `<already_satisfied>one or two sentences citing the existing files or behavior that already satisfy the issue</already_satisfied>`.",
  "3. Emit `<promise>COMPLETE</promise>`.",
  "4. Stop.",
  "",
  "## Missing dependency - install it, don't work around it",
  "",
  "If the reviewer feedback or your validation shows an unresolved import / `use` / `require` / module reference, add the missing package to the project's dependency manifest. **Install it; do not delete or rewrite the import.** This is the only legitimate dependency-manifest edit during rework.",
  "",
  "Common shapes across ecosystems:",
  "",
  "- TS/JS: `Cannot find module '<pkg>'`, `Failed to resolve import \"<pkg>\"`, `error TS2307`",
  "- Python: `ModuleNotFoundError: No module named '<pkg>'`, `ImportError: ...`",
  "- Rust: `` unresolved import `<crate>` ``, `could not find … in the registry`",
  "- Go: `no required module provides package <pkg>`, `cannot find package`",
  "- Ruby: `LoadError: cannot load such file -- <gem>`",
  "- Java/JVM: `package <pkg> does not exist`",
  "",
  "Rules:",
  "",
  "1. Detect the package manager from the manifest files (`package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`, `Gemfile`, etc.) and use its native add command so the lockfile updates correctly.",
  "2. Use the exact package/crate/module name from the error.",
  "3. Put it in the dev/test dependency section if the importer is test code (path or filename contains `test`/`spec`/`__tests__`, or it is the project's test setup file). Otherwise put it in the runtime dependencies. Skip this split if the ecosystem doesn't have one (e.g., Go modules).",
  "4. Do not pin a specific version.",
  "5. Install one package at a time, only for missing-import errors the reviewer's findings (or validation feedback) actually surface.",
  "6. Re-run the failing validation command yourself to confirm it's resolved before committing.",
  "",
].join("\n");

const EXPECTED_USER_PROMPT = [
  "# Rework - issue #{{ISSUE_NUMBER}}: {{ISSUE_TITLE}}",
  "",
  "# Findings to address",
  "",
  "{{REVIEW_FEEDBACK}}",
  "",
  "# Reference: issue body",
  "",
  "<issue-body>",
  "",
  "{{ISSUE_BODY}}",
  "",
  "</issue-body>",
  "",
  "",
].join("\n");

test("rework agent system prompt contains only the static rework instructions", () => {
  const systemPrompt = readFileSync(SYSTEM_PROMPT_PATH, "utf8");

  assert.equal(systemPrompt, EXPECTED_SYSTEM_PROMPT);
  assert.match(systemPrompt, /# Process/);
  assert.match(systemPrompt, /# Do not/);
  assert.match(systemPrompt, /# Completion/);
  assert.match(systemPrompt, /## Missing dependency/);
  assert.doesNotMatch(systemPrompt, /\{\{/);
  assert.doesNotMatch(systemPrompt, /# Findings to address/);
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
