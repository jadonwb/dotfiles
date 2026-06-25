---
agent: execute
subtask: true
model: deepseek/deepseek-v4-flash
return:
  - Review the write result above. Confirm the file was written correctly and
    report to the orchestrator with the file path and size.
---

# EXECUTE FULL FILE WRITE

Write the provided content to the specified file path. Do NOT read existing
files. Do NOT delegate to workers. Just write the file.

## PROCEDURE

- Extract the target file path and content from the prompt.
- Create parent directories if they do not exist (`mkdir -p`).
- Write the content EXACTLY as provided. No transformations, no formatting
  changes.
- Confirm the write by checking the file exists and reporting its size in bytes.
- If the write fails (permissions, disk space, etc.), report the exact error.

**Output**:

```
## [write] Complete

**File**: [absolute path]
**Size**: [bytes]
```

## CONTEXT

$ARGUMENTS
