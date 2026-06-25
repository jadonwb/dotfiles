---
agent: review
subtask: true
model: deepseek/deepseek-v4-flash
return:
  - Review the plan review findings above. Present critical issues first. For
    each, state the problem, where in the plan it occurs, and the suggested fix.
    If the plan is sound, confirm and move on.
---

# PLAN REVIEW

Review the proposed plan or Build Brief below for issues before execution. Find
problems the orchestrator may have missed.

## PROCEDURE

**What to check**:

1. Stale references: do any Find strings reference deleted or renamed symbols?
   Verify key Find strings against actual file content.
2. Incomplete scope: does the plan touch all files that will be affected? Are
   there downstream files not accounted for?
3. Inconsistent Find/Replace: verify Find strings against target files. Report
   mismatches with the exact text found vs expected.
4. Missing edge cases: are there downstream effects the plan doesn't address?
5. Rollback coverage: does every change group have a rollback path?

**Guidelines**:

- Do NOT re-plan. Do NOT suggest alternative approaches. Find problems only.
- Verify Find strings against actual files. Report mismatches precisely.
- If the plan is sound, say so clearly and stop. Do not invent issues.
- 20 steps max. Focus on highest-impact problems first.

**Output**:

```
## [plan-review] Report

### Issues Found

#### Critical
- [file:line in plan] — [problem] → fix: [suggestion]

#### High
- [file:line in plan] — [problem] → fix: [suggestion]

#### Medium
- [file:line in plan] — [problem] → fix: [suggestion]

### Verified
- [items confirmed correct]

### Assessment
[Sound / Needs revision — one-line reason]
```

## CONTEXT

$ARGUMENTS
