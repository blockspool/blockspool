# BlockSpool Roadmap

## Current State (v0.2)

Solo mode with SQLite backend — runs locally, creates PRs autonomously.

```bash
blockspool solo init
blockspool solo auto --hours 8 --batch-size 30
```

### Shipped Features

| Feature | Status | Description |
|---------|--------|-------------|
| **Solo mode** | Done | Zero-config local execution with SQLite |
| **Auto (continuous)** | Done | Runs for hours, scouts + executes + PRs |
| **Milestone mode** | Done | `--batch-size N` batches tickets into milestone PRs |
| **Parallel execution** | Done | 3-5 adaptive workers in isolated worktrees |
| **Wave scheduling** | Done | Conflict-aware partitioning avoids merge conflicts |
| **Trust ladder** | Done | Safe/aggressive category filtering |
| **Deduplication** | Done | Title similarity + git branch matching |
| **Formulas** | Done | Built-in + custom YAML recipes |
| **Deep mode** | Done | Architectural review, auto-staggered every 5 cycles |
| **Impact scoring** | Done | Proposals ranked by impact x confidence |
| **Spindle** | Done | Loop detection prevents runaway agents |
| **Scope enforcement** | Done | Allowed/forbidden paths per ticket |
| **Scope expansion** | Done | Auto-expand for root configs, cross-package, siblings |
| **Draft PRs** | Done | Default safe output |
| **Rebase-retry** | Done | Rebases ticket branch on merge conflict, retries |
| **Live steering** | Done | `solo nudge` adds hints consumed by next scout cycle |

---

## Planned Features

### Storage Backends

Currently tickets are stored in SQLite (`.blockspool/state.sqlite`). Future versions will support multiple backends:

| Backend | Status | Use Case |
|---------|--------|----------|
| **SQLite** | Done | Default, zero-config, fast |
| **YAML files** | Planned | Git-trackable, human-editable |
| **GitHub Issues** | Planned | Team visibility, native integration |
| **PostgreSQL** | Planned | Teams/enterprise, shared state |

#### YAML Backend
```bash
blockspool solo init --backend yaml
# Creates .blockspool/tickets/*.yml
# Committable to repo, visible in PRs
```

#### GitHub Issues Backend
```bash
blockspool solo init --backend github-issues
blockspool solo auto --create-issues
# Creates GitHub Issues for found improvements
# Links PRs to issues automatically
```

#### PostgreSQL Backend (Teams)
```bash
blockspool init --backend postgres --url $DATABASE_URL
# Shared state across team members
# Dashboard visibility
```

---

### Trust Ladder Expansion

| Level | Categories | Status |
|-------|------------|--------|
| **Safe** | refactor, test, docs, types, perf | Done |
| **Aggressive** | + security, fix, cleanup | Done |
| **Full** | + deps, migration, config | Planned |
| **Custom** | User-defined allowlist | Planned |

```bash
# Custom trust configuration
blockspool solo auto --allow "refactor,test,security" --block "deps"
```

---

### Output Formats

| Format | Status | Description |
|--------|--------|-------------|
| **Draft PRs** | Done | Default, safe |
| **Regular PRs** | Done | `--no-draft` flag |
| **Local commits** | Planned | No PR, just commits |
| **Patch files** | Planned | Export as .patch |
| **JSON report** | Planned | Machine-readable output |

---

### Scout Enhancements

#### Custom Scout Rules
```yaml
# .blockspool/scout.yml
rules:
  - name: "no-console-log"
    pattern: "console.log"
    category: "cleanup"
    message: "Remove console.log statements"
```

#### Scout Plugins
```bash
blockspool solo scout --plugin eslint    # Use ESLint as scout source
blockspool solo scout --plugin sonarqube # Import SonarQube issues
```

---

### CI/CD Integration

#### GitHub Actions
```yaml
# .github/workflows/blockspool.yml
name: BlockSpool Nightly
on:
  schedule:
    - cron: '0 2 * * *'  # 2am daily

jobs:
  auto:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: blockspool/action@v1
        with:
          hours: 2
          max-prs: 10
          batch-size: 30
          categories: refactor,test,docs
```

---

### Teams Features (Paid)

| Feature | Solo (Free) | Teams (Paid) |
|---------|-------------|--------------|
| SQLite backend | Yes | Yes |
| PostgreSQL backend | No | Yes |
| Dashboard | No | Yes |
| Multi-user coordination | No | Yes |
| Lease management | No | Yes |
| Priority queue | No | Yes |
| Audit logs | No | Yes |

---

## Version Plan

### v0.1 (Current)
- [x] Solo mode with SQLite
- [x] Auto (continuous mode)
- [x] Trust ladder (safe/aggressive)
- [x] Deduplication
- [x] Draft PRs
- [x] Parallel execution (3-5 workers)
- [x] Milestone mode (`--batch-size`)
- [x] Wave scheduling (conflict-aware)
- [x] Formulas (built-in + custom)
- [x] Deep mode (architectural review)
- [x] Impact scoring
- [x] Scope enforcement + expansion
- [x] Spindle loop detection
- [x] Rebase-retry on merge conflicts

### v0.2
- [ ] YAML backend option
- [ ] Custom trust configuration
- [ ] JSON output format
- [ ] Scout plugins (ESLint)

### v0.3
- [ ] GitHub Issues backend
- [ ] GitHub Action
- [ ] Local commits mode (no PR)

### v1.0
- [ ] Teams/PostgreSQL backend
- [ ] Dashboard
- [ ] Multi-user coordination
- [ ] Production hardening

---

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md) for how to help build these features.

Ideas? Open an issue at [github.com/blockspool/blockspool/issues](https://github.com/blockspool/blockspool/issues)
