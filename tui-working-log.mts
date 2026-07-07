/**
 * Pure formatter for the loop-owned working log (ADR 0003). It converts the
 * Sandcastle agent stream events the loop already intercepts into human-readable
 * lines: thinking/text becomes its non-empty lines, a `toolCall` becomes a
 * compact `→ tool(args)` line, and everything else (tool results, raw frames,
 * malformed events) formats to nothing. It never throws — mirrors the defensive
 * contract of `toolCallObservationFromStreamEvent`.
 */
export function formatWorkingLogLines(event: unknown): string[] {
  if (!isRecord(event)) return [];

  if (event.type === "toolCall") {
    const { name, formattedArgs } = event;
    if (typeof name !== "string") return [];
    const args = typeof formattedArgs === "string" ? formattedArgs : "";
    return [`→ ${name}(${args})`];
  }

  const text = extractText(event);
  if (text === null) return [];
  return text
    .split("\n")
    .map((line) => line.replace(/\s+$/u, ""))
    .filter((line) => line.trim().length > 0);
}

function extractText(event: Record<string, unknown>): string | null {
  if (typeof event.message === "string") return event.message;
  if (typeof event.text === "string") return event.text;
  if (typeof event.content === "string") return event.content;
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
