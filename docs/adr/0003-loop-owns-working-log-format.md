# Loop formats its own working log for the Companion TUI

Every agent step (coder, rework, reviewer, and the extra-review sessions) already
flows through a Sandcastle stream callback in the loop
(`createLivelockWatchdogStreamCallback`), which sees each `toolCall`/text event.
The loop reuses that interception point to write a **purpose-built, human-readable
working log per agent step** — thinking text as lines, tool calls as compact
`→ tool(args)` lines — to a file the status snapshot points at via
`activeLogPath`. The Working-log pane just tails that file.

## Considered options

- **Tail Sandcastle's native file log as-is.** Rejected: its on-disk format is
  opaque and possibly verbose/JSON, and today only coder/rework set an explicit
  log path — reviewer and extra-review runs would show nothing.
- **Tail Sandcastle's native log but have the TUI parse/prettify it.** Rejected:
  puts format knowledge (and version coupling to Sandcastle internals) in the
  TUI, the component least able to influence that format.

## Consequences

- The loop, not Sandcastle, owns the working-log format, so it is stable across
  Sandcastle upgrades and identical for every agent kind.
- A fresh working log per agent step makes the "clear on agent change" rule
  trivial: a new agent step means a new file to tail.
- This intentionally duplicates some of what Sandcastle's own logging captures;
  the loop's file is a presentation artifact for the TUI, not the system of
  record. Metrics (`runs.jsonl`) and any Sandcastle logs remain separate.
