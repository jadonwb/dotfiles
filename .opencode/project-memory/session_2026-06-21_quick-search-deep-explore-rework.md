# Session: 2026-06-21 — Quick-Search & Deep-Explore Rework

**Status**: active

## Summary

Reworked quick-search and deep-explore subagent roles to reduce cost and latency. Quick-search broadened from "simple lookups" to "first responder" handling all initial investigation, mapping, and surface-level Q&A. Deep-explore converted from a self-indexing Phase 0-5 investigator to a dossier-based reasoning specialist that arrives with exact file paths, reads only what it's told, and focuses purely on multi-file reasoning. Orchestrator and execute agents updated to match.

## Goals

- Broaden quick-search scope to include module mapping, structural summaries, function inventories, and surface-level Q&A (not just 1-3 line lookups)
- Convert deep-explore to dossier-based model: remove self-indexing, remove quick-search subagent permission, cap at 25 steps, add 3-read hard limit
- Update orchestrator delegation strategy: exhaust quick-search first, deep-explore as SPECIAL CASE only
- Update execute agent language to match new roles
- Reduce deep-explore wall-clock time and token cost

## What Was Built

- **quick-search as FIRST RESPONDER** — `dot_config/opencode/agents/quick-search.md` (18 steps, Flash model, produces structured summaries, `**Scope boundary**:` flag for depth limits)
- **deep-explore as dossier-based specialist** — `dot_config/opencode/agents/deep-explore.md` (25 steps, V4 Pro, no quick-search access, 3-read limit, output-early-and-often cycle)
- **Orchestrator delegation rework** — `dot_config/opencode/agents/orchestrate.md` (quick-search = PRIMARY DEFAULT, deep-explore = SPECIAL CASE, Parallel Wave removed, trigger keywords updated, Hard Rules strengthened)
- **Execute alignment** — `dot_config/opencode/agents/execute.md` (deep-explore described as dossier-based, constraints aligned with step 8)

## Files Modified

- `dot_config/opencode/agents/quick-search.md` — frontmatter, Your Role, Output Style, Step Budget (92 lines net change)
- `dot_config/opencode/agents/deep-explore.md` — frontmatter, intro, Your Role, removed Phase 0-5/Debug Awareness/Subagent Usage/Repo Cloning, new How You Work/Step Budget, new Tool Usage, new Output Style (274→180 lines, -94 net)
- `dot_config/opencode/agents/orchestrate.md` — Subagent Team, Combined Strategy, Trigger Keywords, Hard Rules, Tool Usage Rules (150 line changes)
- `dot_config/opencode/agents/execute.md` — Constraints, Step 8 (14 line changes)
- `.opencode/project-memory/session_2026-06-21_deep-explore-debug-awareness.md` — marked completed (superseded)
- `.opencode/project-memory/session_2026-06-21_debug-agent-memory-review.md` — marked completed

## Key Decisions

- **Cut quick-search entirely from deep-explore permissions** — deep-explore no longer launches subagents. If it needs more info, it surfaces a "dossier gap" in its report.
- **25 steps (down from 30)** — deep-explore focuses on reasoning, not discovery
- **3-read hard limit** — after 3 files, must produce output before reading more
- **Output early and often** — deep-explore produces findings after each file, not just at the end
- **Parallel Wave pattern removed** — orchestrator never launches deep-explore alongside quick-search
- **Trigger keywords shifted to quick-search** — most keywords (explain, how, research, investigate) now trigger quick-search first, with escalation only when needed

## Bugs Discovered

- **orchestrate Tool Usage Rules contradiction** — lines 423-426 still told orchestrator to "let deep-explore explore beyond exact boundaries," contradicting the new dossier-based Hard Rules. Fixed.
- **execute Constraints/Step 8 contradiction** — Constraints said "surface to orchestrator, don't invoke deep-explore" while Step 8 said "invoke deep-explore with dossier." Resolved by aligning Constraints to match Step 8 (invoke with dossier is allowed).

---

### Orchestrate Notes

The user iterated on the design in real-time during this orchestrate session — the core architecture emerged from a collaborative discussion. Key design insights:
- The orchestrator should do ALL surface-level investigation via quick-search and hand deep-explore a complete dossier
- deep-explore's value is reasoning/synthesis, not discovery — making it search is wasteful
- "Output early and often" is a mechanical enforcement against spiral behavior
- The 3-read hard limit prevents the most common deep-explore failure mode (endless reading)

### Execute Notes

All 13 planned edits + 4 review-fix edits applied cleanly across 6 files. Total: +276/-322 lines. No test infrastructure exists for this dotfile repo — verification was structural (grep checks for description, step counts, permission blocks, label changes). The `[cleanup]` task for deep-explore (deleting 164 lines of old methodology) was the largest single edit and succeeded on first attempt with a large Find/Replace. The review agent found 2 critical/high contradictions and 2 medium session-file issues — all were trivial line-level fixes applied immediately.

### Review Notes

5 findings total:
1. **CRITICAL — orchestrate Tool Usage Rules** (line 425): "let deep-explore explore beyond exact boundaries" contradicted new dossier-based Hard Rules. Fixed by splitting guidance into quick-search (exploratory) vs deep-explore (dossier-only).
2. **HIGH — execute Constraints vs Step 8**: Constraints said "surface to orchestrator, don't invoke deep-explore" but Step 8 said "invoke with dossier." Fixed by aligning Constraints to allow invoke-with-dossier.
3. **MEDIUM — superseded session file**: `session_2026-06-21_deep-explore-debug-awareness.md` marked completed with superseded note.
4. **MEDIUM — completed session file**: `session_2026-06-21_debug-agent-memory-review.md` marked completed.
5. **LOW — orchestrate Tool Usage Rules guidance**: Addressed alongside finding #1 (split guidance by agent).

All findings auto-fixed. No design changes needed.
