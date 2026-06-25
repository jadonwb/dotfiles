---
agent: execute
subtask: true
model: deepseek/deepseek-v4-flash
return:
  - Review the test results. Note pass/fail. For failures, list each failing
    test with its full error message. Do NOT attempt to fix.
---

# EXECUTE TEST

Run the test command below and report results. Nothing more.

## PROCEDURE

- Run the specified command. Capture full output.
- Report pass/fail with the exact command that was run.
- If failures: list each failing test with its full error message.
- Do NOT fix failures. Do NOT add logging. Do NOT diagnose. Report only.

**Output**:

```
## [test] Results

**Status**: pass / fail
**Command**: [exact command run]
**Output**: [summary, with full error messages for failures]
```

## CONTEXT

$ARGUMENTS
