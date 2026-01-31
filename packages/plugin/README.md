# @blockspool/plugin — Claude Code Plugin

Continuous codebase improvement for Claude Code. Scouts improvements, plans changes, executes code, runs QA, and creates PRs — all within your Claude Code session.

## Installation

Copy the `packages/plugin/` directory into your project, or use `--plugin-dir`:

```bash
claude --plugin-dir /path/to/blockspool/packages/plugin
```

Or add the MCP server directly to your project's `.mcp.json`:

```json
{
  "mcpServers": {
    "blockspool": {
      "command": "npx",
      "args": ["tsx", "/path/to/blockspool/packages/mcp/src/index.ts"],
      "env": {}
    }
  }
}
```

## Commands

### `/blockspool:run`

Start an improvement session. Scouts the codebase, creates tickets, executes changes, and creates PRs.

```
/blockspool:run hours=2 formula=security-audit
/blockspool:run deep=true
/blockspool:run formula=test-coverage
```

**Arguments:**
| Name | Description | Default |
|------|-------------|---------|
| `hours` | Time budget | unlimited |
| `formula` | Recipe name | none |
| `deep` | Architectural review mode | false |

### `/blockspool:status`

Show current session state: phase, budget, tickets completed, spindle risk.

### `/blockspool:nudge`

Send a hint to guide the next scout cycle.

```
/blockspool:nudge hint="focus on authentication module"
/blockspool:nudge hint="skip test files, focus on SQL injection"
```

### `/blockspool:cancel`

Gracefully end the current session. Displays summary.

## Auth Note

The plugin uses Claude Code's own authentication — no API key is needed. However, if `ANTHROPIC_API_KEY` is set in your environment, Claude Code will prefer it over your Pro/Max subscription. This can result in unexpected API charges.

If you intend to use your subscription, make sure `ANTHROPIC_API_KEY` is **not** set when running Claude Code with the plugin.

## How It Works

1. **Stop hook** prevents Claude Code from exiting while a session is active
2. **PreToolUse hook** blocks file writes outside the ticket's allowed scope
3. **MCP tools** provide the state machine: `advance` → execute → `ingest_event` → repeat
4. **Formulas** customize what the scout looks for
5. **Spindle** detects loops and aborts stuck agents

## Hooks

| Hook | Purpose |
|------|---------|
| `Stop` | Blocks premature exit during active sessions |
| `PreToolUse` | Enforces scope policy on Write/Edit operations |

## Files

```
packages/plugin/
├── .claude-plugin/plugin.json   # Plugin manifest
├── .mcp.json                    # MCP server config
├── commands/
│   ├── auto.md                  # /blockspool:run
│   ├── status.md                # /blockspool:status
│   ├── nudge.md                 # /blockspool:nudge
│   └── cancel.md                # /blockspool:cancel
├── hooks/hooks.json             # Hook registration
└── scripts/hook-driver.js       # Stop + PreToolUse hook logic
```
