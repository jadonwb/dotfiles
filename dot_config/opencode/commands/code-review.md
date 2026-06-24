---
agent: review
subtask: true
model: deepseek/deepseek-v4-flash
return:
  - Review the code review findings above. Present any critical or high-severity
    issues to the user first. For each issue, state the file:line, the problem,
    and a suggested fix. If the review is clean, confirm and move on.
---

CODE CHANGE REVIEW. The changed files are specified below. Read them directly
and look for regressions, stale references, and bugs.

- Read each changed file. Focus on the changed sections.
- Look for: stale references (renamed/deleted symbols still referenced), broken
  imports, dead code, logic errors (missing edge cases, inverted conditions).
- If changes touch public interfaces, check callers for compatibility.
- Draft report with all findings. Refine only the top 2-3.
- If no issues found, report and stop. Do NOT keep searching.

**Guidelines**:

- Do NOT review unrelated code. Stay in the specified scope.
- Do NOT suggest stylistic changes. Only report regressions and bugs.
- Do NOT chase every match. 20 steps max.

**Output**:

```
## Review Report

### Summary
[1-2 sentences on what was reviewed and overall assessment]

### Findings

#### Critical (requires attention)
- `file:line` — [issue] → fix: [suggestion]

#### High
- `file:line` — [issue] → fix: [suggestion]

#### Medium
- `file:line` — [issue] → fix: [suggestion]

#### Low (informational)
- `file:line` — [issue] → fix: [suggestion]

### Recommended Actions
1. [Actionable step]
```

$ARGUMENTS
