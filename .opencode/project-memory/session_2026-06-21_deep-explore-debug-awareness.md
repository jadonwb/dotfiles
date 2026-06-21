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

---

### Continuation: 2026-06-21 — Anti-Spin Guardrails

#### Summary
Added hard structural guardrails to deep-explore to prevent endless spinning: reduced step cap from 45→25, added 7-file hard limit, added "Stop or continue?" decision to every read, strengthened Stop Condition with MUST language and 3 explicit exit triggers. Added orchestrator rule to route incomplete deep-explore results to `[debug]` instead of re-launching.

#### Changes
- `deep-explore.md` — +33/-15: steps 45→25, 7-file limit in Phase 1, stop/continue in Phase 2, HARD RULES stop condition
- `orchestrate.md` — +4/-0: new bullet — incomplete deep-explore → produce `[debug]` task

#### Review Findings
- Low: Phase 2 "5+ files" line lacked debug cross-reference → fixed (added `(or suggest a [debug] task per Phase 1)`)
- Informational: edge case noted where debug may be asked to do pure reading — no fix needed

#### Design Decisions
- Flash model rejected after research — architecture correctly assigns pro to all reasoning roles
- Three-layer defense: (1) 25-step hard cap, (2) 7-file hard limit, (3) MUST-stop at ~15 steps with debug escape hatch

---

### Continuation: 2026-06-21 — Coder Removal + Anti-Spin Walkback

#### Summary
Removed the coder agent entirely — execute now applies all file edits directly via the `edit` tool. Emphasized debug delegation for test/build failures. Added Brief Quality Checklist to orchestrator to prevent lax Briefs. Added no-auto-commit rules (execute and orchestrator both know to wait for user to mention committing). Walked back deep-explore's aggressive HARD RULES/MUST language that was scaring agents into using quick-search instead.

#### Changes
- `coder.md` — +1: `disable: true`
- `execute.md` — major rewrite: all 19 coder references removed, direct editing flow, debug emphasis, no-auto-commit rule
- `orchestrate.md` — Brief Quality Checklist (7 items), coder refs removed, no-auto-commit note
- `deep-explore.md` — softened: removed HARD RULES, MUST, Three hard exit triggers, per-read Stop/continue. Kept debug awareness, steps:30, reasoning_effort:low
- `review.md` — fixed 2 stale coder references

#### Design Decisions
- Coder removed because the indirection (execute→coder→edit) added latency without benefit for this workflow
- Anti-spin walkback: the aggressive language worked TOO well — agents stopped using deep-explore entirely. Softer guidance preserves focus without avoidance
- Commit policy: agents stage freely but only commit when user explicitly says "commit" or equivalent
