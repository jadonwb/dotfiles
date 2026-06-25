---
agent: search
subtask: true
model: deepseek/deepseek-v4-pro
return:
  - Examine the research findings above. Synthesize the key conclusions and
    present them to the user with evidence from the provided files. State your
    confidence level (high/medium/low) and propose concrete next steps based on
    the findings.
---

# DEEP RESEARCH

Read EVERY file in the dossier below. Do NOT skip any.

## PROCEDURE

- Load each file with `read`. Use `grep` aggressively to trace call chains,
  symbol definitions, and cross-file references.
- Use `git log` or `git show` ONLY if version history illuminates the question.
- Map data flow end-to-end. Identify every assumption and every downstream
  effect of the proposed change.
- Stay dossier-bound. Self-discover a missing dependency ONLY if you cannot
  answer without it — and ONLY as a last resort.
- Take up to 40 steps. Do NOT pad — stop when you can answer fully.

**Output**:

```
## Research Answer: [question]

**Answer**: [concise, direct answer — no hedging]
**Evidence**: [specific file:line references with reasoning]
**Confidence**: high / medium / low — [brief justification]
**Impact summary** (if applicable):
- File A: [exactly what breaks and why]
- File B: [exactly what breaks and why]
```

## CONTEXT

$ARGUMENTS
