---
name: formulas
description: List available BlockSpool formulas (built-in and custom)
---

Call the `blockspool_list_formulas` MCP tool and display the results.

Show each formula with its name, description, categories, and risk tolerance. Format as:

```
## Available Formulas

### Built-in
- **security-audit** — Scan for security vulnerabilities (categories: security)
- **test-coverage** — Improve test coverage (categories: test)
...

### Custom (.blockspool/formulas/)
- **my-formula** — Custom description
...
```

If no custom formulas exist, note that custom formulas can be added to `.blockspool/formulas/`.
