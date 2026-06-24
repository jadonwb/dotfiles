---
agent: execute
subtask: true
model: deepseek/deepseek-v4-pro
return:
  - Review the edit results above. Confirm all expected files changed via git
    diff. If any Find strings failed, note the specific mismatches and their
    locations.
---

BUILD BRIEF EXECUTION. The task below contains Find/Replace edits. Delegate ALL
edits to workers. Never apply edits directly except as noted below.

**Worker delegation rules**:

- Parse the Build Brief. Extract every `[edit]` task with its file path, Find
  string, and Replace string.
- Delegate EVERY edit to a worker. One worker per file.
- Workers for DIFFERENT files: launch in PARALLEL.
- Workers for the SAME file (batched): run SEQUENTIALLY. Cap at 5 per worker.
- Workers expect EXACT Find/Replace pairs. Pass them verbatim from the Brief.

**When workers fail (Find string not found)**:

- Diagnose the mismatch yourself. Compare the Find string against the actual
  file content.
- For a SINGLE-LINE fix (the file drifted trivially): apply it directly. Report
  what you changed.
- For ANYTHING beyond a single line: STOP. Report the mismatch to the
  orchestrator. Do NOT guess.

**After ALL edits apply**:

- Run `git diff --stat`. Confirm every expected file changed.
- Report immediately. Do NOT run tests. Do NOT run extra checks.

**Output**:

```
## [edit] Complete

**Files modified**: [count]
**Method**: workers (N workers, N files)

| File | Lines | Worker |
|------|-------|--------|
| path/to/file | +N/-M | worker name |
```

$ARGUMENTS
