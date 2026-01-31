# BlockSpool CLI

Zero-config autonomous coding assistant. Works locally with any git repository.

## Quick Start (5 minutes)

```bash
# Install globally
npm install -g @blockspool/cli

# Navigate to any git repo
cd your-project

# Check prerequisites
blockspool solo doctor

# Initialize (auto-detects QA commands from package.json)
blockspool solo init

# Scan for improvement opportunities
blockspool solo scout .

# Approve proposals (e.g., 1-3)
blockspool solo approve 1-3

# Execute a ticket with Claude
blockspool solo run tkt_abc123

# Or execute and create a PR
blockspool solo run tkt_abc123 --pr
```

## Prerequisites

Run `blockspool solo doctor` to check all prerequisites:

| Requirement | Purpose | Install |
|-------------|---------|---------|
| Node.js 18+ | Runtime | [nodejs.org](https://nodejs.org/) |
| Git | Version control | [git-scm.com](https://git-scm.com/) |
| Claude CLI | Execute tickets | [claude.ai/code](https://claude.ai/code) |
| GitHub CLI | Create PRs (optional) | [cli.github.com](https://cli.github.com/) |

## Commands

### `solo init`
Initialize BlockSpool in your repository. Creates `.blockspool/` directory with:
- `config.json` - Configuration (auto-detects QA commands)
- `state.sqlite` - Local database

### `solo scout [path]`
Scan codebase for improvement opportunities:
- Code quality issues
- Security vulnerabilities
- Performance optimizations
- Test coverage gaps

### `solo approve <selection>`
Convert proposals to tickets. Examples:
- `blockspool solo approve 1` - Approve proposal #1
- `blockspool solo approve 1-3` - Approve proposals 1, 2, and 3
- `blockspool solo approve all` - Approve all proposals

### `solo run <ticketId>`
Execute a ticket using Claude Code CLI:
- Creates a branch for changes
- Runs QA commands (if configured)
- Commits changes
- `--pr` flag creates a GitHub PR

### `solo status`
Show current state:
- Active tickets
- Recent runs
- QA results

### `solo doctor`
Check prerequisites and environment health:
- Git installation
- Claude CLI installation and auth
- GitHub CLI installation and auth
- Node.js version
- SQLite native module
- Directory permissions

### `solo nudge [text...]`
Steer a running auto session with live hints:
- `blockspool solo nudge "focus on auth"` — Add a hint
- `blockspool solo nudge --list` — Show pending hints
- `blockspool solo nudge --clear` — Clear all hints

Hints are consumed in the next scout cycle. In continuous mode, you can also type hints directly into stdin.

### `solo qa`
Run QA commands manually:
- Uses commands from `.blockspool/config.json`
- Records results in database

## Configuration

Configuration lives in `.blockspool/config.json`:

```json
{
  "version": 1,
  "qa": {
    "commands": [
      { "name": "typecheck", "cmd": "npm run typecheck" },
      { "name": "lint", "cmd": "npm run lint" },
      { "name": "test", "cmd": "npm test" }
    ],
    "retry": {
      "enabled": true,
      "maxAttempts": 3
    }
  },
  "spindle": {
    "enabled": true,
    "maxStallIterations": 5,
    "tokenBudgetAbort": 140000
  }
}
```

### QA Commands
Auto-detected from `package.json` during `solo init`:
- `typecheck` / `type-check` - TypeScript checking
- `lint` - Linting
- `test` - Testing
- `build` - Build verification

### Spindle Loop Detection
Prevents runaway agent execution:
- **Oscillation**: Detects add→remove→add patterns
- **Stalling**: Stops after N iterations without changes
- **Repetition**: Catches repeated output patterns
- **Token Budget**: Enforces context limits

## Push Safety

BlockSpool records your `origin` remote URL when you run `solo init`.
Every push and PR creation validates the current origin still matches.
SSH and HTTPS URLs for the same repo are treated as equivalent.

If your origin changes (e.g., you switch from HTTPS to SSH), re-initialize:

    blockspool solo init --force

Or edit `.blockspool/config.json` directly:

    { "allowedRemote": "git@github.com:you/your-repo.git" }

## Exit Codes

| Code | Meaning |
|------|---------|
| 0 | Success |
| 1 | General failure |
| 2 | Spindle abort (agent loop detected) |
| 130 | Cancelled (Ctrl+C) |

## Artifacts

Run artifacts are stored in `.blockspool/artifacts/`:
- `runs/` - Run summaries
- `executions/` - Agent output logs
- `diffs/` - Git diff snapshots
- `violations/` - Scope violation details
- `spindle/` - Spindle abort diagnostics

View artifacts with:
```bash
blockspool solo artifacts
blockspool solo artifacts --type runs
```

## License

Apache-2.0
