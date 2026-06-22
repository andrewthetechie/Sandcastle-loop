export const CUSTOM_AGENT_ARGV_LIMIT_BYTES = 120_000;

export type ArgvSizeCheck =
  | { ok: true; bytes: number }
  | { ok: false; bytes: number; error: string };

export function enforceArgvSizeLimit(
  message: string,
  limitBytes: number = CUSTOM_AGENT_ARGV_LIMIT_BYTES,
): ArgvSizeCheck {
  const bytes = Buffer.byteLength(message, "utf8");
  if (bytes <= limitBytes) {
    return { ok: true, bytes };
  }

  return {
    ok: false,
    bytes,
    error: [
      "## Rendered agent message too large",
      "",
      `The rendered message is ${bytes} bytes, above the ${limitBytes} byte command-line limit.`,
      "These PRD issues are expected to be small. Reduce the issue body / diff scope so the message fits, then retry.",
    ].join("\n"),
  };
}
