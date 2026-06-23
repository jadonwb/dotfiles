# Session: 2026-06-22 — Agent System Re-architecture

**Status**: completed

## Summary
Re-architected the opencode agent system per 11 requirements. Consolidated from 7 agents (orchestrate, execute, quick-search, deep-explore, debug, review, worker) + 1 plugin (agent-switch-context) down to 5 agents (orchestrate, execute, search, review, worker) with no plugins needed. Orchestrate gained read access, compress rules, and review invocation. Execute became a multi-mode subagent. Review became multi-mode.

## What Was Built

- **T1 Remove agent-switch plugin** — deleted `plugins/agent-switch-context.ts`, removed mode-transition language from orchestrate.md and execute.md, removed plugin from opencode.jsonc
- **T2 Remove debug agent** — deleted `agents/debug.md`, replaced all debug-agent invocations in execute.md and orchestrate.md with direct debug cycle workflow
- **T3 Execute → multi-mode subagent** — rewrote execute.md: mode primary→all, added [edit]/[debug]/[test] modes, removed REVIEW IS MANDATORY, TESTS, Completion Report, Session Wrap-Up sections (~230 lines removed)
- **T4 Review → multi-mode** — restructured review.md with [code]/[docs] modes, replaced all execute references with orchestrator, added session memory audit capability
- **T5 Orchestrate rework** — added review: allow permission, multi-mode review agent description, After Execute Completes workflow (review→session-memory→compress), Context Management section replacing Session Wrap-Up, removed all Tab/end-session language, added compress tool rules
- **T6 Audit + cleanup** — verified search.md consistency, confirmed zero stale references across all agent files, removed stale `scout` entry from opencode.jsonc

## Files Modified

- `dot_config/opencode/opencode.jsonc` — removed agent-switch plugin, removed stale scout entry, added dcp plugin
- `dot_config/opencode/agents/orchestrate.md` — major restructure: unified search+review subagents, compress rules, context management, removed Tab/end-session language (507→568 lines)
- `dot_config/opencode/agents/execute.md` — rewritten as multi-mode subagent [edit]/[debug]/[test] (454→270 lines)
- `dot_config/opencode/agents/review.md` — restructured as multi-mode [code]/[docs] (155→220 lines)
- `dot_config/opencode/agents/search.md` — new file replacing quick-search + deep-explore

## Files Deleted

- `dot_config/opencode/plugins/agent-switch-context.ts`
- `dot_config/opencode/agents/debug.md`
- `dot_config/opencode/agents/quick-search.md`
- `dot_config/opencode/agents/deep-explore.md`
- `dot_config/opencode/agents/coder.md` (prior session)

## Deferred Tasks

- `compress` tool availability: verified from DCP README that `@tarquinen/opencode-dcp` injects the `compress` tool, not gated by opencode permissions — always available to all agents
- `[test]` mode in execute.md is a stub — full test-automation workflow planned for future
- Indentation inconsistencies in execute.md (pre-existing) — cosmetic cleanup pass
- Review agent not invokable until opencode restart (config not hot-reloaded)
- Restart opencode after all changes for full effect

---

### Review Notes

- **F1 (Critical, fixed)**: `orchestrate.md:61-62` — Hard constraints prose contradicted YAML permissions. Fixed: updated to list `search`, `review`, `execute` with role descriptions.
- **F2 (Low, fixed)**: `execute.md:159` — Example [edit] task referenced T2 debug agent (stale). Fixed: replaced with generic logging example.
- **F3 (Low, fixed)**: `review.md:106` — Example [code] task referenced T2 debug agent (stale). Fixed: replaced with search agent consolidation example.
- **F4 (Low, deferred)**: `review.md:200-201` — Orphan scan hardcodes deleted agent names. Functionally correct, revisit if list grows.
- **F5 (Low, fixed)**: `orchestrate.md:3` — Description said "subagent" (singular). Fixed: "subagents (search, review, execute)".

## Key Decisions

- **Execute mode: `all`** (not `subagent`) — allows user to invoke execute directly for quick tasks while still being invokable as a subagent by orchestrate
- **compress rule: after confirmed phases** — not around Build Briefs. Compress when a task/phase is confirmed complete and conversation moves on
- **Session memory: execute writes it** — per orchestrate's instruction via [edit] task. One file per planning→implement cycle
- **Review: two separate modes** — [docs] for session start audits, [code] for post-execute change review
- **Worker model retained** — execute delegates multi-file edits to workers; debug cycle edit-heavy steps also delegate to workers
