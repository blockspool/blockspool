# BlockSpool

**Autonomous coding swarm that improves your codebase while you focus on what matters.**

BlockSpool scouts your codebase for improvements, executes them in parallel, and batches everything into milestone PRs — all running autonomously for hours.

---

## Quick Start

```bash
# Install (requires Node 18+)
npm install -g @blockspool/cli

# Initialize in your repo
cd your-project
blockspool solo init

# Run overnight with milestone PRs
blockspool solo auto --hours 8 --batch-size 30
```

That's it. Come back to 5 milestone PRs containing 50+ improvements.

---

## What It Does

```
$ blockspool solo auto --hours 4 --batch-size 10

BlockSpool Auto

  Mode: Continuous (Ctrl+C to stop gracefully)
  Time budget: 4 hours (until 6:00 PM)
  Categories: refactor, test, docs, types, perf
  Draft PRs: yes
  Milestone mode: batch size 10

Milestone branch: blockspool/milestone-abc123

[Cycle 1] Scouting src...
  Found 20 improvements, processing 5...
  Conflict-aware scheduling: 2 waves
  Merged to milestone (1/10)
  Merged to milestone (2/10)
  Merged to milestone (3/10)
  Merged to milestone (4/10)
  Merged to milestone (5/10)

[Cycle 3] Scouting packages...
  Found 15 improvements, processing 5...
  Merged to milestone (6/10)
  ...
  Merged to milestone (10/10)

  Milestone PR: https://github.com/you/repo/pull/42
  New milestone branch: blockspool/milestone-def456

Final Summary
  Duration: 4h 2m
  Cycles: 32
  Milestone PRs: 5
  Total tickets merged: 50
```

---

## Key Features

| Feature | Description |
|---------|-------------|
| **Milestone Mode** | Batches N tickets into one PR instead of 50 individual PRs |
| **Parallel Execution** | Runs 3-5 tickets concurrently with adaptive parallelism |
| **Wave Scheduling** | Detects overlapping file paths, serializes conflicting tickets |
| **Scope Enforcement** | Each ticket is sandboxed to specific file paths |
| **Scope Expansion** | Auto-expands for root configs, cross-package, sibling files |
| **Deduplication** | Title similarity + git branch matching prevents duplicates |
| **Trust Ladder** | Safe categories by default (refactor, test, docs, types, perf) |
| **Formulas** | Repeatable recipes: `--formula security-audit`, `--formula test-coverage` |
| **Deep Mode** | Principal-engineer-level architectural review (`--deep`) |
| **Impact Scoring** | Proposals ranked by `impact x confidence`, not confidence alone |
| **Spindle** | Loop detection prevents runaway agents |

---

## How It Works

1. **Scout** — Analyzes your codebase for improvement opportunities
2. **Propose** — Creates tickets with confidence and impact scores
3. **Filter** — Auto-approves based on category, confidence, and dedup
4. **Execute** — Runs Claude Code CLI in isolated git worktrees (parallel)
5. **Merge** — Merges ticket branch into milestone branch (with conflict-aware scheduling)
6. **PR** — Creates one milestone PR per batch

```
Scout ──▶ Filter ──▶ Execute (parallel) ──▶ Merge to milestone ──▶ PR
  │                                                                  │
  └──────────────── next cycle (sees prior work) ◀───────────────────┘
```

### Milestone Mode vs Individual PRs

| | Individual PRs | Milestone Mode |
|---|---|---|
| **PRs created** | 50 PRs for 50 fixes | 5 PRs (10 fixes each) |
| **Review burden** | High (50 reviews) | Low (5 reviews) |
| **Scout accuracy** | Rescans stale code, finds duplicates | Scans milestone branch, sees prior work |
| **Git noise** | 50 branches | 5 branches |

```bash
# Individual PRs (default)
blockspool solo auto --hours 4

# Milestone mode (recommended for long runs)
blockspool solo auto --hours 8 --batch-size 30
```

---

## Commands

### Initialize
```bash
blockspool solo init
```
Creates `.blockspool/` directory with SQLite database. No external services needed.

### Auto (Main Command)
```bash
# Run overnight with milestone PRs
blockspool solo auto --hours 8 --batch-size 30

# Run until stopped (Ctrl+C finalizes partial milestone)
blockspool solo auto --continuous --batch-size 20

# Dry run (show what would happen)
blockspool solo auto --dry-run

# Include more categories
blockspool solo auto --aggressive

# Focus on specific improvements
blockspool solo auto --formula security-audit
blockspool solo auto --formula test-coverage
blockspool solo auto --deep
```

### Other Commands
```bash
# Check prerequisites
blockspool solo doctor

# Manual scout
blockspool solo scout src/

# View status
blockspool solo status

# Run single ticket
blockspool solo run tkt_abc123

# Retry failed ticket (regenerates scope)
blockspool solo retry tkt_abc123

# Steer a running auto session
blockspool solo nudge "focus on auth module"
blockspool solo nudge --list
blockspool solo nudge --clear

# Interactive TUI
blockspool solo tui
```

---

## Formulas

Formulas are repeatable recipes for specific goals:

```bash
blockspool solo auto --formula security-audit   # Focus on vulnerabilities
blockspool solo auto --formula test-coverage     # Add missing tests
blockspool solo auto --formula type-safety       # Improve TypeScript types
blockspool solo auto --formula cleanup           # Dead code, unused imports
blockspool solo auto --formula docs              # Documentation improvements
blockspool solo auto --deep                      # Architectural review
```

Custom formulas live in `.blockspool/formulas/`:

```yaml
# .blockspool/formulas/my-formula.yml
name: my-formula
description: Focus on error handling
prompt: |
  Look for error handling improvements:
  - Missing try/catch blocks
  - Silent error swallowing
  - Unhandled promise rejections
```

---

## Requirements

- **Node.js 18+**
- **Git repository** with GitHub remote
- **Claude Code CLI** installed (`npm i -g @anthropic-ai/claude-code`)

---

## Trust Ladder

BlockSpool uses a trust ladder to control what changes are auto-approved:

| Mode | Categories | Use Case |
|------|------------|----------|
| **Default** | refactor, test, docs, types, perf | Safe overnight runs |
| **Aggressive** | + security, fix, cleanup | When you want more |

```bash
# Default (safe)
blockspool solo auto

# Aggressive (more categories)
blockspool solo auto --aggressive
```

---

## Configuration

Optional `.blockspool/config.json`:

```json
{
  "defaultScope": "src",
  "minConfidence": 70,
  "maxPrsPerRun": 20,
  "draftPrs": true
}
```

---

## How It Compares

See [docs/COMPARISON.md](./docs/COMPARISON.md) for a detailed comparison with Gas Town, Factory.ai, Devin, and others.

**TL;DR:** BlockSpool is the only tool designed for unattended overnight runs with built-in cost control, scope enforcement, and milestone batching. Other tools either require constant steering (Gas Town), are SaaS-only (Factory, Devin), or handle only simple fixes (Sweep).

---

## FAQ

### How is this different from just running Claude Code?

BlockSpool adds:
- **Hours of autonomous operation** (not just one task)
- **Milestone batching** (coherent PRs, not 50 tiny ones)
- **Parallel execution** with conflict-aware scheduling
- **Deduplication** (won't recreate similar work)
- **Trust ladder** (safe categories by default)
- **Scope enforcement** (sandboxes each ticket to specific paths)

### Will it break my code?

- Every change runs through **typecheck and tests** before merging
- All changes are **draft PRs** by default
- Only touches files in scoped directories
- Failed tickets are automatically **blocked**, not merged
- Trust ladder limits to safe categories

### How much does it cost?

BlockSpool is free and open source. It uses your Claude Code subscription or API key. A typical overnight run produces 50+ improvements for roughly $5-15 in API costs depending on codebase size.

### What are formulas?

Formulas are repeatable recipes for specific goals. Run `--formula security-audit` for vulnerabilities, `--formula test-coverage` for tests, or `--deep` for architectural review. You can also write your own.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

## License

Apache 2.0 - See [LICENSE](./LICENSE)

---

<p align="center">
  <b>BlockSpool</b><br>
  <i>Set it. Forget it. Merge the PRs.</i>
</p>
