---
name: nudge
description: Send a hint to guide the current PromptWheel session
argument-hint: "<hint text>"
---

Call the `promptwheel_nudge` MCP tool with `$ARGUMENTS` as the hint text.

The hint will be consumed in the next scout cycle and appended to the scout prompt.
Examples: "focus on auth module", "skip test files", "look for SQL injection".

## Drill Directives

If the user asks to pause, resume, or disable drill mode, these are NOT regular hints.
Instead, write a directive hint to `.promptwheel/hints.json`:

- `drill:pause` — Pause drill mode
- `drill:resume` — Resume drill mode
- `drill:disable` — Disable drill for the session

Use the hints file directly since the MCP nudge tool does not support directives.
