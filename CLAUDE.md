# BlockSpool - Claude Guide

## What is BlockSpool?

BlockSpool is an autonomous coding tool that scouts your codebase for improvements, executes them in parallel, and creates PRs — all running locally with zero external infrastructure.

## Solo Mode

```bash
blockspool solo init                          # Authorize repo + initialize SQLite database
blockspool solo init --yes                    # Skip confirmation (CI/scripting)
blockspool solo init --repo <url>             # Explicit remote, skip prompt
blockspool solo repos                         # List authorized repos
blockspool solo repos --remove user/repo      # Deauthorize a repo
blockspool solo auto                          # Scout + fix + PR (eco mode, sonnet scout)
blockspool solo auto --hours 8 --batch-size 30  # Run overnight with milestone PRs
blockspool solo auto --continuous             # Run until stopped (Ctrl+C)
blockspool solo auto --no-eco --scout-deep    # Full opus run (scout + execute)
blockspool solo nudge "focus on auth"         # Steer a running session
```

### Features

- **SQLite** backend (no external database needed)
- **Eco mode** (default) — routes trivial/simple tickets to sonnet, moderate/complex to opus
- **Auto-learning** — records failures, injects lessons into future scout cycles
- **AI merge resolution** — resolves merge conflicts with Claude before blocking tickets
- **Draft PRs** with single commits
- **Deduplication** to avoid recreating similar work
- **Trust ladder** (safe categories by default)
- **Formulas** for repeatable recipes: `--formula security-audit`
- **Deep mode** (`--deep`) for architectural/structural review
- **Impact scoring** — proposals ranked by `impact x confidence`
- **Spindle** loop detection prevents runaway agents
- **Parallel** execution (default: 3-5 concurrent tickets, adaptive)
- **Milestone mode** (`--batch-size N`) — batches N tickets into one milestone PR
- **Wave scheduling** — conflict-aware partitioning prevents merge conflicts
- **Scope enforcement** — each ticket sandboxed to `allowed_paths` with auto-expansion
- **Rebase-retry** — rebases ticket branch on merge conflict, retries before blocking
- **Balanced continuous mode** — deep architectural scan every 5 cycles
- **Live steering** (`solo nudge`) — add hints mid-run, consumed in next scout cycle

### Model Routing

Eco mode is **on by default** — saves 30-50% on API costs with no quality loss on simple tasks.

| Flag | Effect |
|------|--------|
| *(default)* | Eco mode: trivial/simple → sonnet, moderate/complex → opus. Scout uses sonnet. |
| `--no-eco` | Force opus for all ticket execution |
| `--model sonnet` | Force sonnet for all ticket execution |
| `--model opus` | Force opus for all ticket execution (same as `--no-eco`) |
| `--scout-deep` | Use opus for the scout phase (default: sonnet) |
| `--no-eco --scout-deep` | Full opus run — maximum quality, maximum cost |

### `solo init` Flags

| Flag | Default | Description |
|------|---------|-------------|
| `-f, --force` | off | Reinitialize even if already initialized |
| `-y, --yes` | off | Skip confirmation prompt |
| `--repo <url>` | auto-detect | Set the authorized remote URL (implies `--yes`) |

### All `solo auto` Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--dry-run` | off | Show what would be done without making changes |
| `--scope <path>` | `src` | Directory to scout (rotates in continuous mode) |
| `--max-prs <n>` | 3 (20 continuous) | Maximum PRs to create |
| `--min-confidence <n>` | 70 | Minimum confidence for auto-approve |
| `--aggressive` | off | Include more categories (security fixes, etc.) |
| `--no-draft` | draft | Create regular PRs instead of drafts |
| `--yes` | off | Skip confirmation prompt |
| `--minutes <n>` | — | Run for N minutes (enables continuous mode) |
| `--hours <n>` | — | Run for N hours (enables continuous mode) |
| `--continuous` | off | Run continuously until stopped or PR limit reached |
| `-v, --verbose` | off | Show detailed output |
| `--branch <name>` | current | Target branch |
| `--parallel <n>` | 3 (adaptive) | Number of concurrent tickets |
| `--formula <name>` | — | Use a predefined formula |
| `--deep` | off | Deep architectural review (shortcut for `--formula deep`) |
| `--batch-size <n>` | off | Milestone mode: merge N tickets into one PR |
| `--no-eco` | eco on | Disable eco mode (use opus for all tickets) |
| `--model <name>` | auto | Override model for all tickets (`sonnet` or `opus`) |
| `--scout-deep` | off | Use opus for scout phase |

## How It Works

```
blockspool solo auto --hours 4
```

1. **Scout** — scans your codebase for improvement opportunities
2. **Filter** — applies trust ladder, deduplication, confidence thresholds
3. **Execute** — runs tickets in parallel using Claude Code CLI in isolated worktrees
4. **QA** — runs your test/lint commands to verify changes
5. **PR** — creates draft PRs (or merges to milestone branch)
6. **Repeat** — next cycle scouts again, sees prior work

## File Structure

```
packages/
├── cli/          # CLI application (blockspool solo)
│   ├── src/
│   │   ├── commands/   # Command modules (solo-auto, solo-exec, etc.)
│   │   ├── lib/        # Core logic (auto, hints, formulas, spindle, etc.)
│   │   ├── tui/        # Terminal UI
│   │   └── test/       # Tests
├── core/         # Core types, scout, and utilities
│   ├── src/
│   │   ├── scout/      # Scout prompt, parser, runner
│   │   ├── repos/      # Data access (tickets, projects, runs)
│   │   ├── services/   # Scout service, QA
│   │   ├── db/         # Database adapter interface
│   │   ├── exec/       # Claude CLI execution
│   │   └── utils/      # ID generation, JSON parsing
└── sqlite/       # SQLite database adapter
```

## TOS Compliance

BlockSpool uses the **official Claude Code CLI** on the user's own machine with their own credentials. This is the same as running `claude` in a shell script or CI pipeline — explicitly permitted.

- Each user uses their own API key/subscription
- No credentials are shared, proxied, or stored
- BlockSpool is a workflow tool, not an AI service

## Key Commands

```bash
# Run tests
npm test

# Type check
npm run typecheck

# Lint
npm run lint
```

## Concepts Glossary

| Term | Definition |
|------|------------|
| **Auto** | The main execution mode. Scouts, proposes, executes, and PRs improvements autonomously. |
| **Scout** | The discovery phase. Scans code to find improvement opportunities. |
| **Ticket** | A unit of work. Created from a proposal, executed in isolation. |
| **Proposal** | A candidate improvement found by scouting. Becomes a ticket when approved. |
| **Formula** | A recipe for what to scout for. Built-ins: `security-audit`, `test-coverage`, `type-safety`, `cleanup`, `docs`, `deep`. User-defined formulas live in `.blockspool/formulas/`. |
| **Deep** | Built-in formula (`--deep`) for principal-engineer-style architectural review. Auto-staggered every 5th cycle in continuous mode. |
| **Impact Score** | 1-10 rating of how much a proposal matters. Proposals ranked by `impact x confidence`. |
| **Spindle** | Loop detection system. Detects when an agent is spinning without progress and aborts. |
| **Worktree** | An isolated git checkout where a ticket executes. Enables parallel execution. |
| **Hint / Nudge** | Live guidance for a running auto session. Added via `solo nudge "text"` or stdin, consumed in the next scout cycle. |
| **Eco Mode** | Default model routing. Routes trivial/simple tickets to sonnet, moderate/complex to opus. Disable with `--no-eco`. |
| **Learning** | A lesson recorded from a failed ticket. Injected into future scout prompts to avoid repeating mistakes. |
| **AI Merge Resolution** | When merge + rebase both fail, Claude resolves conflict markers before giving up. Runs automatically in milestone mode. |
| **Repo Registry** | Global list of authorized repos at `~/.blockspool/allowed-repos.json`. Managed via `solo init` (authorize) and `solo repos` (list/remove). |
