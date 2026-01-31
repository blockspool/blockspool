# BlockSpool vs The Field

How BlockSpool compares to other autonomous coding tools.

---

## The Landscape

Autonomous coding tools fall into three categories:

1. **Orchestrators** — Coordinate multiple agents on tasks (Gas Town, Claude Flow)
2. **Issue-to-PR engines** — Convert issues into PRs (Factory, Sweep, Devin)
3. **Improvement engines** — Continuously scout and improve codebases (BlockSpool)

BlockSpool is purpose-built for category 3: unattended, overnight codebase improvement with cost control and safety guarantees.

---

## Feature Matrix

| Feature | BlockSpool | Gas Town | Factory.ai | Devin | Sweep | Claude Flow |
|---|---|---|---|---|---|---|
| **Primary use** | Overnight improvement runs | Multi-agent orchestration | Issue-to-PR automation | AI software engineer | Simple issue fixes | Agent swarm coordination |
| **Unattended operation** | Yes (designed for it) | Partial (can run unattended, best with steering) | Yes | Yes | Yes | Yes |
| **Eco model routing** | Yes (auto sonnet/opus by complexity) | No | N/A | N/A | N/A | No |
| **Auto-learning from failures** | Yes (records + injects into future scouts) | No | Unknown | Unknown | No | No |
| **AI merge conflict resolution** | Yes (Claude resolves conflicts before blocking) | No | No | N/A | N/A | No |
| **Milestone batching** | Yes (`--batch-size`) | Partial (checkpoints) | No | No | No | No |
| **Parallel execution** | 3-5 adaptive | 20-30 agents | Multiple droids | Single | Single | Swarm |
| **Conflict-aware scheduling** | Yes (wave partitioning) | No | No | N/A | N/A | No |
| **Scope enforcement** | Yes (allowed/forbidden paths) | No | Ticket-scoped | Task-scoped | Issue-scoped | No |
| **Scope auto-expansion** | Yes (root configs, cross-package, siblings) | No | No | No | No | No |
| **Deduplication** | Yes (title similarity + branch matching) | No | Unknown | Unknown | Unknown | No |
| **Trust ladder** | Yes (safe/aggressive categories) | Informal (conceptual stages) | Approval workflows | Human review | PR review | No |
| **Formulas** | Yes (built-in + custom YAML) | Yes (TOML-based) | No | No | No | No |
| **Deep architectural review** | Yes (`--deep`) | No | No | Partial | No | No |
| **Impact scoring** | Yes (impact x confidence) | No | No | No | No | No |
| **Loop detection** | Yes (Spindle) | No | Unknown | Unknown | No | No |
| **Multi-runtime** | No (Claude Code CLI) | Yes (Claude, Codex, Aider, custom) | Proprietary | Proprietary | GitHub Actions | Claude Code |
| **Open source** | Yes (Apache 2.0) | Yes | No | No | Partial | Yes |
| **Install** | `npm install -g` | `brew install` / `go install` | SaaS | SaaS | GitHub App | `npm install` |

---

## Design Trade-offs

Different tools make different trade-offs. Here's how BlockSpool's approach differs:

### Cost Efficiency

BlockSpool optimizes for **cost per improvement** through:

1. **Eco model routing** (default) — Routes trivial/simple tickets to sonnet, moderate/complex to opus. Scout uses sonnet by default. Use `--no-eco --scout-deep` for full opus if cost isn't a concern.

2. **Focused scope** — Each ticket is sandboxed to specific files. The agent works on a narrow slice, not the whole codebase.

3. **Smart filtering** — Scout finds 20 proposals, dedup removes duplicates, trust ladder filters to high-confidence work.

4. **Milestone batching** — Scout scans the milestone branch, seeing prior work. No wasted cycles rediscovering things already fixed.

5. **Wave scheduling** — Conflicting tickets run sequentially instead of failing and retrying.

6. **Scope expansion** — Instead of failing on edge cases (root config, cross-package import), the system auto-expands and retries.

7. **Adaptive parallelism** — Runs 5 simple tickets in parallel but only 2 complex ones.

8. **Auto-learning** — Records why tickets fail and avoids proposing similar work in future cycles.

### Parallelism vs. Precision

Gas Town runs 20-30 agents in parallel, optimizing for throughput on large, well-defined tasks (e.g., migrating 500 files). BlockSpool runs 3-5 agents with scope enforcement and conflict-aware scheduling, optimizing for overnight unattended operation where safety matters more than speed.

Both are valid approaches for different use cases.

---

## Gas Town

[Gas Town](https://github.com/steveyegge/gastown) by Steve Yegge is a multi-agent workspace manager written in Go.

**Strengths:**
- High parallelism (20-30 agents)
- Multi-runtime support (Claude Code, Codex, Aider, custom)
- Git-native persistence (Beads system, survives crashes)
- Kubernetes operator for cloud deployment
- TOML-based task definitions

**Different trade-offs than BlockSpool:**
- Optimized for large defined tasks vs. continuous scouting
- Higher parallelism but no conflict-aware scheduling
- Multi-runtime flexibility but no per-ticket scope enforcement
- Higher throughput, higher cost per run

**When to use Gas Town:** You have a large, well-defined task (e.g., migrate 500 files from framework A to B) and want maximum parallelism.

**When to use BlockSpool:** You want continuous, unattended improvement of your codebase overnight with cost control and safety guarantees.

---

## Other Tools

### Factory.ai
Enterprise SaaS that assigns "droids" to GitHub issues. Good for teams with existing issue workflows. Not open source. Reacts to issues rather than proactively finding improvements.

### Devin (Cognition Labs)
AI software engineer that handles complete projects from planning to deployment. Subscription-based pricing. Single-agent. Good for greenfield tasks rather than continuous improvement.

### Sweep.dev
Lightweight GitHub app that turns issues into PRs for minor fixes. Free tier available. Single-agent, no scouting, no milestone batching. Good for simple, well-defined fixes.

### CodeRabbit / Qodo PR-Agent
Code review tools, not code generation. They review PRs, not create them. Complementary to BlockSpool — use CodeRabbit to review BlockSpool's PRs.

### Claude Flow
Open-source multi-agent framework for Claude Code. More of a building block than a product — provides coordination primitives without scope enforcement, dedup, or milestone batching.

---

## BlockSpool's Niche

BlockSpool is built for **unattended overnight improvement runs**.

It combines:
- Autonomous scouting (finds work to do)
- Eco model routing (cost-efficient by default)
- Auto-learning (avoids repeating failures)
- AI merge conflict resolution (fewer blocked tickets)
- Milestone batching (coherent PRs)
- Safety guarantees (scope enforcement, trust ladder, dedup)
- Zero configuration (`npm install` + `init` + `auto`)
