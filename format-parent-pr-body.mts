export function formatParentPrBody(input: {
  parentNumber: number;
  parentTitle: string;
  children: { number: number; title: string; state: "OPEN" | "CLOSED" }[];
}): string {
  const childList =
    input.children.length > 0
      ? input.children
          .map((c) => `- #${c.number} (${c.state.toLowerCase()}) — ${c.title}`)
          .join("\n")
      : "(no child issues)";
  return [
    `Delivers parent issue #${input.parentNumber}: ${input.parentTitle}`,
    "",
    "### Child issues",
    childList,
    "",
    `Closes #${input.parentNumber}`,
  ].join("\n");
}