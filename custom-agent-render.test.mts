import assert from "node:assert/strict";
import { test } from "node:test";

import { renderSlimMessage } from "./custom-agent-render.mts";

test("renderSlimMessage substitutes placeholders in the rendered message", () => {
  assert.equal(renderSlimMessage("#{{N}} {{T}}", { N: "5", T: "Title" }), "#5 Title");
});

test("renderSlimMessage replaces repeated placeholders and preserves literal command substitutions", () => {
  const template = [
    "Base: {{BASE}}",
    "Range: !`git log {{BASE}}..HEAD --oneline`",
    "Again: {{BASE}}",
  ].join("\n");

  assert.equal(
    renderSlimMessage(template, { BASE: "origin/prd-001" }),
    [
      "Base: origin/prd-001",
      "Range: !`git log origin/prd-001..HEAD --oneline`",
      "Again: origin/prd-001",
    ].join("\n"),
  );
});

test("renderSlimMessage preserves mustache syntax inside substituted values", () => {
  assert.equal(
    renderSlimMessage("Body:\n{{BODY}}", {
      BODY: "Keep literal {{EXAMPLE}} text from the issue body.",
    }),
    "Body:\nKeep literal {{EXAMPLE}} text from the issue body.",
  );
});

test("renderSlimMessage throws when a placeholder remains unsubstituted", () => {
  assert.throws(
    () => renderSlimMessage("Missing {{MISSING}}", {}),
    /MISSING/,
  );
});
