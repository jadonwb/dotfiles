---
agent: search
subtask: true
model: deepseek/deepseek-v4-flash
return:
  - Review the scout report above. Identify the most relevant files for the task
    at hand. If the report is thin or the directory mapping is incomplete, note
    what's missing. If it's sufficient, present the file inventory and propose
    which files to investigate deeper next.
---

MODULE MAPPING. Survey the directories or project scope specified in the task
below. Produce a structural map the orchestrator can navigate.

- Use `glob` FIRST to inventory all relevant files in the target scope. Then
  `read` the top ~30 lines of each to classify them.
- Categorize EVERY file by role: entry point, data structure, config, transport,
  handler, utility, test, etc.
- Identify connections: which files import/use which others. Use `grep` for
  import/include patterns across the scope.
- Move FAST. Read only the bare minimum to categorize. Only scan, do NOT
  deep-read.
- If the scope is large, prioritize by relevance. Flag anything you couldn't
  fully classify.

**Output**:

```
## Scout Report: [scope]

### File Inventory
| File | Role | Description |
|------|------|-------------|

### Connections
- file_a → file_b — [relationship: imports, uses, extends, etc.]

### Unclassified
- [Any files you couldn't fully categorize with a one-line reason]
```

$ARGUMENTS
