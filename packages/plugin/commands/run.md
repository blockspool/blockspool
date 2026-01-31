---
name: run
description: Run BlockSpool — scouts, plans, executes, and PRs improvements continuously
arguments:
  - name: hours
    description: Time budget for multi-cycle runs (e.g. hours=4). Omit for a single cycle.
    required: false
  - name: formula
    description: Formula to use (e.g. security-audit, test-coverage, cleanup)
    required: false
  - name: cycles
    description: Number of scout→execute cycles (default: 1)
    required: false
  - name: deep
    description: Enable deep architectural review mode
    required: false
---

Start a BlockSpool session. By default runs one cycle: scout → execute tickets → PR → done.
Pass `cycles=3` for multiple rounds or `hours=4` for time-based runs.

## Setup

1. Call `blockspool_start_session` with the provided arguments.
2. After receiving the response, write `.blockspool/loop-state.json` with:
   ```json
   { "run_id": "<run_id>", "session_id": "<session_id>", "phase": "SCOUT" }
   ```
   This file is read by the Stop hook to prevent premature exit.

## Main Loop

3. Call `blockspool_advance` to get the next action.
4. Execute whatever the advance response tells you to do (scout, plan, code, test, git).
5. Report results back via `blockspool_ingest_event`.
6. Update `.blockspool/loop-state.json` with the current phase after each advance.
7. Repeat until advance returns `next_action: "STOP"`.

## Rules

- Always follow the constraints returned by advance (allowed_paths, denied_paths, max_lines).
- Always output structured XML blocks when requested (`<proposals>`, `<commit-plan>`, `<ticket-result>`).
- The Stop hook will block premature exit while the session is active.
- When the session ends, delete `.blockspool/loop-state.json`.
