---
agent: execute
subtask: true
model: deepseek/deepseek-v4-pro
return:
  - Review the debug diagnosis. Evaluate root cause. Check test results. If
    unresolved after 3 cycles, surface to the user for a decision.
---

FAILURE DIAGNOSIS. Debug the issue below using the debug cycle. Maximum 3
cycles. Do NOT loop beyond 3. REVERT any change that doesn't work.

**Cycle (repeat up to 3 times)**:

1. PLAN LOGGING: Identify key decision points in the failure path. Use
   `/verify-string` to confirm exact strings where logging will be inserted.
2. ADD LOGGING: Create Find/Replace pairs for each logging insertion. Delegate
   ALL edits to workers.
3. BUILD AND TEST: Run the reproduction command. Capture full output.
4. READ OUTPUT: Trace failure through logs. Identify where expected behavior
   diverges from actual.
5. DIAGNOSE: Form a hypothesis. For simple failures, reason directly. For
   complex multi-file failures, invoke the researcher.
6. PLAN FIX: Use `/verify-string` to confirm exact strings at the fix site.
   Create Find/Replace pairs. Delegate ALL fix edits to workers.
7. REMOVE LOGGING: Create Find/Replace pairs to revert ALL logging from step 2.
   Delegate to workers.
8. RE-TEST: Run reproduction again. If fixed → report. If not → next cycle.

**If a fix makes things worse or doesn't make sense**: REVERT it immediately.
Create reverse Find/Replace pairs and delegate to workers. Log the revert in
your report. Then re-diagnose.

**After 3 cycles unresolved**: STOP. Report what you tried in each cycle. Do NOT
continue.

**Output**:

```
## [debug] Diagnosis

**Root cause**: [explanation]
**Fix**: [file:line — what was changed, Find/Replace applied]
**Test result**: [pass/fail — before and after]
**Cycles used**: [N of 3]
**Temporary logging removed**: yes
**Reverted attempts**: [any fixes that were reverted and why]
```

$ARGUMENTS
