---
agent: search
subtask: true
model: deepseek/deepseek-v4-flash
return:
  - Confirm the verification result above. If the string was found at the
    expected location, note the exact line numbers and surrounding context. If
    not found or ambiguous, flag it for the user and suggest what the actual
    text at that location might be.
---

# EXACT STRING VERIFICATION

Find the string in the file. Confirm it. Report it exactly.

## PROCEDURE

- Use `grep` with the EXACT target string. Confirm line numbers. Use `read` for
  surrounding context.
- Use `grep -r` project-wide to count ALL occurrences. Report uniqueness.
- Return the Find string copy-paste ready — no trimming, no reformatting.
- If the string does NOT match: report the ACTUAL text at that location with
  differences highlighted. Do NOT guess. Do NOT approximate.

**Output**:

```
## Verify Result: [file]

**Status**: found / not found / ambiguous
**Find string** (copy-paste ready):
```

[exact text — verbatim, no changes]

```
**Location**: lines [start]-[end]
**Occurrences**: N in file / N in project
**Context**:
```

[3 lines before] [matched lines] [3 lines after]

```

```

## CONTEXT

$ARGUMENTS
