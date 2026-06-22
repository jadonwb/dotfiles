# Session: 2026-06-21 — Debug Agent, Session Memory & Review Upgrade
**Status**: completed

## Summary
Built a debug subagent for failure diagnosis, redesigned the session memory system from a single file to a per-session directory, upgraded the review agent to V4 Pro, and unified the Brief format to support both [edit] and [debug] task types. Also fixed contradictions and bloat across all agent files from the prior session.

## Goals
- Create debug agent with build/test permissions and minimal edit capability
- Design unified Brief format with [edit] and [debug] task types
- Replace .opencode/last-session.md with .opencode/project-memory/ directory
- Upgrade review agent from V4 Flash to V4 Pro (medium reasoning, 35 steps)
- Fix contradictions (Tool Usage Rules, quick-search output, coder "Build Brief" references)
- Reduce bloat (consolidate safety guardrails, delegation rules, review sections)
- Elevate test emphasis in execute agent

## What Was Built
- Debug agent — `dot_config/opencode/agents/debug.md` (new, 155 lines)
- Unified Brief format — `orchestrate.md` (replaced Build Brief + Debug Brief with single format)
- Session memory system — `orchestrate.md`, `execute.md`, `review.md` (directory-based, status markers)
- Review upgrade — `review.md` (V4 Pro, 35 steps, session memory management)
- Contradiction fixes — `orchestrate.md` (Tool Usage Rules), `quick-search.md` (dual-mode output), `coder.md` ("Build Brief"→"change instructions")
- Bloat reduction — `orchestrate.md` (safety sections consolidated), `execute.md` (Delegation Rules merged, TESTS section added)
- Cross-agent consistency — `deep-explore.md` (quick-search ref updated)

## Files Modified
- `dot_config/opencode/agents/debug.md` — new debug subagent
- `dot_config/opencode/agents/orchestrate.md` — Brief format, session memory, Tool Usage Rules, safety consolidation
- `dot_config/opencode/agents/execute.md` — debug integration, Brief handling, TESTS section, session memory, delegation consolidation
- `dot_config/opencode/agents/review.md` — V4 Pro upgrade, session memory management
- `dot_config/opencode/agents/quick-search.md` — dual-mode output (lookups + file-reading)
- `dot_config/opencode/agents/coder.md` — "Build Brief"→"change instructions"
- `dot_config/opencode/agents/deep-explore.md` — updated quick-search output reference
- `dot_config/opencode/project-memory/` — new directory (this file is the first entry)

## Test Results
- Baseline: N/A (chezmoi dotfile repo, no test suite)
- After: N/A

## Deferred Tasks
- First real usage of debug agent — monitor effectiveness, tune step count and quick-fix rules
- First real usage of session memory — ensure agents correctly read/write to project-memory/
- Commit these changes to chezmoi

## Key Decisions
- Debug agent gets edit: allow for <5-line unblocking fixes (mechanical only)
- Brief format uses [edit] and [debug] task types, processed in order
- Session memory: one file per session, top ~30 lines for fast orientation, Status: active/completed/archived
- Multiple active sessions allowed concurrently
- Review agent manages memory (archive, mark resolved, prune), execute writes, orchestrate reads/suggests

## Bugs Discovered
- orchestrate Tool Usage Rules told it to use grep/glob/read (tools it can't access) — fixed
- quick-search 1-3 line constraint contradicted orchestrator's content-block expectations — fixed
- coder referenced "Build Brief" but receives individual change instructions — fixed
- execute TESTS section routed failures to deep-explore instead of debug — fixed
- review.md body text said "V4 Flash" after frontmatter upgrade — fixed

---

### Orchestrate Notes
Planned the debug agent design (V4 Pro, 30 steps, build/test perms, <5-line edit capability). Designed unified Brief format with [edit]/[debug] task types and natural-language backlinking. Designed session memory system with per-session files, status markers, and agent-specific reading/writing protocols. Upgraded review agent specs. All designs iterated with user through phase gates.

### Execute Notes
Applied 12 initial changes (contradictions + bloat fixes) then 10 additional changes (debug agent + Brief + memory + review upgrade). Created new debug.md file. Created project-memory/ directory. Fixed 5 review findings post-build. Net +270/-253 lines across 7 files. Coder observations surfaced and addressed (stale model references, backtick escaping, HANDOFF marker transition).

### Review Notes
Review (upgraded V4 Pro) found 5 issues — all auto-fixed:
- execute.md:244 TESTS section routed to wrong agent (deep-explore→debug) [FIXED]
- execute.md:167 stale HANDOFF marker [FIXED]
- execute.md:153 missing debug in unexpected-issues guidance [FIXED]
- orchestrate.md:137 "TWO subagents" under-count [FIXED]
- orchestrate.md:95 bug trigger keywords needed debug clarification [FIXED]
Two low-priority informational findings noted (terminology inconsistency, field naming mismatch).

### Coder Observations
- orchestrate.md Phase 6 and trigger table now consistently explain the three-agent system
- execute.md new Session Wrap-Up template is structurally clean with clear top/bottom separation
- review.md archive-by-status preserves history better than archive-by-deletion
- Backtick escaping in JSON strings caused minor issues — resolved with sed
