---
agent: review
subtask: true
model: deepseek/deepseek-v4-flash
return:
  - Review the documentation audit above. Note every factual mismatch — what the
    docs claim vs what the code actually does. Prioritize the most critical
    discrepancies.
---

# DOCUMENTATION AUDIT

Compare the documentation below against the actual code. Find factual mismatches
and claims in the docs that don't match reality.

## PROCEDURE

**Methodology**:

1. Read the documentation file(s) specified in the task.
2. Extract every factual claim: function signatures, file paths, config keys,
   behavior descriptions, code examples.
3. For each claim, verify against the actual source code. Read the relevant
   files.
4. Report mismatches: what the doc says vs what the code actually does.

**Guidelines**:

- Only check claims you can verify. Do not speculate.
- Focus on FACTUAL mismatches: wrong paths, wrong signatures, outdated examples,
  missing/removed features still documented.
- Do NOT review code quality or suggest improvements.
- 20 steps max. If scope is too large, prioritize the most critical docs.

**Output**:

```
## [docs-review] Audit Report

### Mismatches Found
- `doc_file:line` — doc claims: [X], code actually: [Y] → fix: [suggestion]

### Verified
- [claims that were confirmed correct]

### Could Not Verify
- [claims that couldn't be checked within step limit, with reason]
```

## CONTEXT

$ARGUMENTS
