# Session: Agentic Workflow Restructure — 2026-06-24

## Summary
Implemented all 7 fixes from `fixes_we_need_to_make.md`, restructuring the orchestrator's 6-phase protocol into a per-task implementation cycle with file-based Brief.

## Files Modified
- **`agents/orchestrate.md`** (+92/-153) — Major restructure:
  - Removed auto memory-review from Phase 1 (user-requested only)
  - Replaced Loop Completion with Implement + Compress steps (per-task execution)
  - Deleted old Phase 5 (Detail) and Phase 6 (Invoke Edit) sections entirely
  - Restructured After Execute Completes for per-task code-review
  - Updated compression timing from "beginning of next task" to "end of cycle"
  - Removed `[debug]` from Brief format template
  - Updated Build Confirmation Signals and Prompt Format Conventions for file-based Brief

- **`commands/execute-edit.md`** (+5/-4) — Redirected execute agent to read `.opencode/brief.md` instead of expecting inline Brief

- **`commands/code-review.md`** (+6/-3) — Review agent reads `.opencode/brief.md` first to understand intended changes

- **`agents/execute.md`** (+2/-4) — Replaced stale `quick`/`scout`/`research`/`verify` tool permissions with `task: { search: allow, researcher: allow }`

- **`commands/execute-debug.md`** (+16/-11) — Replaced standalone tool references with `task(search, "quick", ...)` dispatch syntax

- **`.opencode/brief.md`** — New empty file for file-based Brief storage (reused per task)

## Key Decisions
1. **Implementation Cycle**: Each task goes Survey → Discuss → Propose → Implement (Brief → user approve → execute → code-review → compress) → next task. No more monolithic Brief at the end.
2. **File-based Brief**: Brief written to `.opencode/brief.md` via `task(execute, "edit", ...)`, user reviews file, then execute agent reads file. File reused/overwritten per task, emptied after session.
3. **Brief is pure Find/Replace**: `[debug]` tasks removed from Brief format. Debug is separate `task(execute, "debug", ...)` for broken/regression scenarios.
4. **Memory review is manual**: Removed auto-trigger from Phase 1. User must explicitly request.
5. **Compression at cycle end**: Compress after successful implementation cycle and user confirmation, not at beginning of next task.
6. **Session memory before compression**: Write session memory before final compression.

## Deferred Tasks
- Update `plan-review.md` if plan-review is used pre-dispatch with file-based Brief
- Consider stronger debug emphasis in `execute-debug.md` for broken/regression scenarios
