---
agent: execute
subtask: true
model: deepseek/deepseek-v4-pro
return:
  - Review the edit results above. Confirm all expected files changed. If any
    Find strings failed, note the specific mismatches and their locations.
---

# EXECUTE BRIEF EDITS.

Call get_brief_path for the brief filepath, then read that file to retrieve the Build Brief, then execute all
Find/Replace edits within. Delegate ALL edits to workers. Never apply edits
directly except as noted below.

## PROCEDURE

**Worker delegation rules**:

- Call get_brief_path for the brief filepath. Read that file. Parse the Build Brief. Extract every `[edit]` task
  with its file path, Find string, and Replace string.
- Delegate all edits to a worker.
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

**Output**:

```
## [edit] Complete

**Files modified**: [count]
**Method**: workers (N workers, N files)

| File | Lines | Worker |
|------|-------|--------|
| path/to/file | +N/-M | worker name |
```

## CONTEXT

$ARGUMENTS
