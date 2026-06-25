---
agent: execute
subtask: true
model: deepseek/deepseek-v4-flash
return:
  - Report results for each step. Note any failures. If a step failed, report
    which step and the error. Do NOT retry without explicit instruction.
---

# EXECUTE GENERAL TASKS

Execute the series of steps below sequentially.

## PROCEDURE

- Execute each step in order. Report results as you go.
- If a step fails, STOP and report the failure. Do NOT retry unless told to.
- Capture all output as instructed.

**Output**:

```
## [run] Complete

**Steps**: [N completed / N total]
**Results**:
- Step 1: [what happened, with output if relevant]
- Step 2: [what happened, with output if relevant]
...
**Failed** (if any):
- Step X: [what failed and the error]
```

## CONTEXT

$ARGUMENTS
