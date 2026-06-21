# Session: 2026-06-21 — Deep-Explore Debug Awareness
**Status**: active

## Summary
Made deep-explore aware of the `[debug]` task system and lowered its reasoning_effort from `medium` to `low`. Deep-explore can now suggest `[debug]` tasks at checkpoints and at its stop condition — debug suggestion IS now a valid exit condition.

## Goals
- Lower deep-explore `reasoning_effort` from medium to low
- Teach deep-explore the `[debug]` task format and debug agent role
- Integrate debug suggestions into self-checkpoints, stop condition, and report output

## What Was Built
- `dot_config/opencode/agents/deep-explore.md` — Debug System Awareness section, 4th self-checkpoint, extended stop condition, extended Phase 5
- `dot_config/opencode/agents/orchestrate.md` — Fixed stale reasoning_effort reference

## Files Modified
- `dot_config/opencode/agents/deep-explore.md` — +58/-9: lowered reasoning_effort, new Debug System Awareness section, 4th checkpoint question, extended stop condition and Conclude and Report
- `dot_config/opencode/agents/orchestrate.md` — +1/-1: updated deep-explore model description from medium to low reasoning effort

## Key Decisions
- reasoning_effort lowered to `low` (not just guidelines tightened) — slightly less exhaustive but faster, with debug escape hatch compensating for reduced depth
- Debug suggestion recognized as a valid stop condition — deep-explore should NOT continue reading when runtime reproduction would be faster

## Bugs Discovered
- Stale `(medium reasoning effort)` reference in orchestrator's deep-explore description — fixed
- "these three questions" header mismatch after adding 4th checkpoint question — fixed

---

### Orchestrate Notes
User request: make deep-explore aware of the debug system, suggest debug tasks when taking too long, lower thinking to low. Built a Build Brief with 7 precise Find/Replace edits across 2 files. User approved at each phase gate.

### Execute Notes
Applied all 7 edits via coder agent in 2 batches. Review found 2 findings (both trivial) — auto-fixed the stale orchestrator reference and the "three→four questions" mismatch. All changes verified with git diff.

### Review Notes
- HIGH: orchestrator stale reference (fixed)
- LOW: self-checkpoints question count (fixed)
- No non-trivial findings — all auto-fixed

### Coder Observations
- Debug System Awareness section cleanly placed between Your Role and Analysis Methodology
- Cross-reference "the Debug System Awareness section above" in Phase 5 resolves correctly
- orchestrator's model description now consistently says "low reasoning effort"
