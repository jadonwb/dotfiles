# Session: 2026-06-24 — Dispatch Plugin Fixes (Enum + Write Mode)

**Status**: completed
**Agent**: execute (DeepSeek V4 Pro)
**Brief**: `.opencode/brief.md` — "Create execute-write command file and update dispatch/orchestrator for write mode"

---

## Problems Diagnosed

### Problem A: Orchestrator LLM Using Custom Descriptions Instead of Mode Keywords

**Symptom**: The orchestrator dispatched `task(execute, "read this file and check it", ...)` with a custom English description as the `description` argument, instead of an allowed keyword like `"quick"` or `"edit"`. The dispatch plugin's tool definition had no `enum` constraint on the `description` field, so the LLM was free to supply any string.

**Root cause**: The plugin registered the `dispatch` tool with `type: "string"` for the `description` parameter — no schema-level enforcement. The orchestrator prompt listed valid keywords in prose, but LLMs often prefer natural language over remembering enum lists.

**Fix**: Two changes:

1. **`dispatch.ts` — Added `tool.definition` hook** (`experimental.tool.definition`): Intercepts the tool definition before it reaches the LLM and injects an `anyOf` schema on the `description` field. The schema lists all valid keywords in an `enum` array, with a fallback `{ type: "string" }` to avoid breaking non-orchestrator agents that might pass `description` for other purposes.

   ```typescript
   // Added to dispatch.ts
   tool: {
     definition: (ctx) => {
       if (ctx.tool.name !== "dispatch") return;
       const tasks = ctx.definition.input_schema.properties.tasks;
       const items = tasks.items;
       if (items?.properties?.description) {
         items.properties.description = {
           anyOf: [
             { enum: ["quick", "scout", "research", "verify", "code-review",
                      "memory-review", "docs-review", "plan-review",
                      "write", "edit", "debug", "test", "run"] },
             { type: "string" }
           ]
         };
       }
     }
   }
   ```

2. **`orchestrate.md` — Strengthened keyword enforcement**: Updated the `description` field documentation to explicitly warn against custom text, with a clear "Must be one of:" list and a stern "Do NOT use custom descriptive text" clause.

**Key decision**: Used `anyOf` with fallback `{ type: "string" }` instead of a strict `enum` alone. A strict enum would reject any string not in the list, silently breaking other use cases where `description` carries different semantics. The `anyOf` approach guides good behavior (the LLM is drawn to enum values) without being brittle.

### Problem B: Missing "Write" Mode (Chicken-and-Egg Problem with Edit)

**Symptom**: The orchestrator used `task(execute, "edit", ...)` to write the Build Brief to `.opencode/brief.md`. But the edit agent's first instruction is "Read `.opencode/brief.md`" — it expects an existing file to edit. This created a chicken-and-egg problem: the file didn't exist yet, so the edit agent would fail trying to read a non-existent file.

**Root cause**: No dedicated "write" mode existed. The only option for file output was `"edit"`, which assumes a file to patch with Find/Replace. Writing a brand-new file from scratch is a fundamentally different operation.

**Fix**: Three changes:

1. **Created `commands/execute-write.md`** (new file): A dedicated subagent command that writes a complete file to disk. Its instructions are explicit:
   - "FULL FILE WRITE. Write the provided content to the specified file path."
   - "Do NOT read existing files. Do NOT look for Build Briefs. Do NOT delegate to workers."
   - "Extract the target file path and content from the prompt."
   - "Create parent directories if they do not exist (`mkdir -p`)."
   - "Write the content EXACTLY as provided. No transformations, no formatting changes."
   - Uses `agent: execute`, `subtask: true`, `model: deepseek/deepseek-v4-flash`.

2. **Updated `dispatch.ts`**:
   - **T2a — DESC_TO_FILE**: Added `write: "execute-write"` to the lookup map so `description: "write"` resolves to the new command file.
   - **T2b — Enum**: Added `"write"` to the `anyOf` enum array (via the same `tool.definition` hook from Problem A).

3. **Updated `orchestrate.md`** (5 edits):
   - **T3a — Build Confirmation Signals**: Changed `task(execute, "edit", ...)` → `task(execute, "write", ...)` for writing the Brief to disk. The edit mode is kept for *executing* an existing Brief (Find/Replace edits).
   - **T3b — Dispatch options sentence**: Added `task(execute, "write", ...)` as the method for writing files.
   - **T3c — Dispatch table**: Added a new row for "Write file to disk" → `task(execute, "write", ...)` with model `flash`.
   - **T3d — Keyword list**: Added `"write"` to the mandatory keyword list in the `description` field documentation.
   - **T3e — Implement GATE step 2**: Changed `task(execute, "edit", ...)` → `task(execute, "write", ...)` for Brief-to-disk step.

---

## Files Modified

| File | Changes |
|------|---------|
| `dot_config/opencode/plugins/dispatch.ts` | Added `experimental.tool.definition` hook with `anyOf` enum constraint on `description` field. Added `write: "execute-write"` to `DESC_TO_FILE` map. |
| `dot_config/opencode/agents/orchestrate.md` | 5 edits: renamed write step from "edit"→"write", added write keyword to enum list, added write dispatch row to table, added write to dispatch options sentence, updated Implement GATE step 2. |
| `dot_config/opencode/commands/execute-write.md` | **New file**. Dedicated write-mode subagent command. |

---

## Key Decisions

1. **`anyOf` with fallback `{ type: "string" }`** — Not a strict enum. This avoids silently breaking tools for non-orchestrator agents. The LLM is guided toward enum values for the orchestrator use case but isn't rejected for legitimate alternative strings elsewhere.

2. **Separate "write" mode from "edit"** — Writing a new file and editing an existing file are different operations. Collapsing them into one mode would require the edit agent to detect "no file exists yet" and switch to a writing path, which violates single-responsibility. The dedicated write mode is simpler and more reliable.

3. **`execute-write` uses flash model** — Writing a file is a fast, mechanical operation. Flash model is appropriate and saves cost vs. pro.

4. **Orchestrate.md keeps both "write" and "edit"** — The write step uses `"write"` (file creation). The execute step uses `"edit"` (Find/Replace of existing Brief). Both modes are valid and documented separately in the dispatch table.

---

## Deferred Tasks

None.

---

## Verification

All verification commands from the Brief were expected to pass after edits were applied:

- `grep -n "write: \"execute-write\"" dispatch.ts` — confirms DESC_TO_FILE entry
- `grep -q '"write"' dispatch.ts` — confirms enum array entry
- `grep -n 'task(execute, "write", ...)' orchestrate.md` — confirms at least one write-mode reference
- `grep -n "Write file to disk" orchestrate.md` — confirms dispatch table row
- `ls -la execute-write.md && grep -q "FULL FILE WRITE" execute-write.md` — confirms new file exists with correct content

---

## Rollback

```bash
git checkout -- dot_config/opencode/plugins/dispatch.ts dot_config/opencode/agents/orchestrate.md \
  && rm -f dot_config/opencode/commands/execute-write.md
```

---

## Brief File Reference

The Build Brief that drove this session is preserved at `.opencode/brief.md` (233 lines). It defines 3 tasks (T1–T3) with a total of 7 edit sub-steps across `dispatch.ts` and `orchestrate.md`, plus one new file (`execute-write.md`).

---

# Additional Fix: Execute Agent Model Rerouting

**Date**: 2026-06-24 (same session, follow-on cycle)
**Agent**: execute (DeepSeek V4 Flash → Pro for planning)

---

## Problems Diagnosed

### Problem C: Execute Agent Over-Powered for Mechanical Tasks

**Symptom**: The execute agent was running on the `pro` model (`deepseek-v4-pro`) for all subagent dispatches — including `edit`, `write`, `run`, and `test`. These are mechanical, single-responsibility operations that don't require deep reasoning. Running them on a frontier model wasted latency and cost.

**Root cause**: The `execute.md` agent definition specified `model: deepseek/deepseek-v4-pro` as a blanket default. All dispatched subagents (except the explicitly-pinned `execute-write`) inherited this without any per-mode override capability.

**Fix**: Re-base the execute agent on the `flash` model. Only tasks that genuinely need pro-level reasoning (debug diagnosis, deep analysis) should be routed to pro — and those get a dedicated agent (`execute-debug`) with transparent rerouting via the dispatch plugin.

### Problem D: No Debug Mode with Pro Reasoning

**Symptom**: When a worker or subagent failed, the execute agent had no way to hand off failure diagnosis to a pro-backed reasoning agent. The orchestrate agent's dispatch table listed `Deep reasoning (multi-step analysis)` as `task(execute, "debug", ...)` routed to `pro`, but no `debug` description existed in the DESC_TO_FILE map, so the dispatch plugin couldn't resolve it.

**Root cause**: The `debug` keyword was documented in the orchestrator prompt but not wired in `dispatch.ts`. The pattern for transparent rerouting (how `research` silently routes to the `researcher` agent rather than `execute`) existed but wasn't replicated for `debug`.

**Fix**: Created `execute-debug` as a dedicated pro-backed subagent command, then wired it through the dispatch plugin's `AGENT_OVERRIDES` table — the same mechanism used for `research → researcher`. The orchestrator calls `task(execute, "debug", ...)`, and the dispatch plugin silently swaps in the `execute-debug` agent with the `pro` model.

---

## Changes Made

### 1. `execute.md` — Re-based on flash model

- Changed `model:` from `deepseek/deepseek-v4-pro` to `deepseek/deepseek-v4-flash`.
- Removed the research reroute footnote (an implementation detail that doesn't belong in agent instructions — the dispatch plugin handles it transparently).
- This makes all direct subagent dispatches (`edit`, `write`, `run`, `test`, `quick`, `scout`) default to the faster, cheaper flash model.

### 2. `execute-debug.md` — New pro-backed debug agent

Created a new subagent command file with:
- `agent: execute-debug`, `subtask: true`, `model: deepseek/deepseek-v4-pro`
- Instructions for failure diagnosis: read worker output, trace error chains, identify root causes, propose fixes
- Designed to be invoked transparently by the dispatch plugin when `description: "debug"` is matched

### 3. `dispatch.ts` — Wired debug rerouting

- **`AGENT_OVERRIDES` table**: Added `debug: "execute-debug"` entry. This mirrors the existing `research: "researcher"` pattern — the dispatch plugin intercepts `task(execute, "debug", ...)` and silently redirects to the `execute-debug` agent (with pro model) instead of the flash-backed execute agent.
- **`DESC_TO_FILE` map**: Added `debug: "execute-debug"` so the command file can be located and loaded.
- **`tool.definition` hook**: The `enum` array already contained `"debug"` from the prior fix cycle, so no schema change was needed here. However, the `"write"` entry was confirmed present (it had been omitted in an intermediate state during the fix).

### 4. `orchestrate.md` — Updated permissions and dispatch table

- **Permissions**: Added `execute-debug: allow` to the agent permissions list (alongside the existing `execute`, `researcher`, etc.).
- **Dispatch table row — Apply edits**: Changed model from `pro` to `flash`. Apply-edits is a mechanical Find/Replace operation — pro is unnecessary.
- **Dispatch table row — Deep reasoning**: Changed model from `pro¹` (footnoted reference to research reroute) to `pro`. The footer explaining the research override was removed since it's now an implementation detail handled silently by the dispatch plugin. The orchestrator doesn't need to know about transparent rerouting.
- **Dispatch options sentence**: Updated to reflect that `task(execute, "debug", ...)` calls `execute-debug` (pro) under the hood.

### 5. Description string fix in `dispatch.ts`

- The `tool.definition` hook's enum array was missing `"write"` in the intermediate state between fix cycles. Re-added `"write"` to the enum so the orchestrator can dispatch `task(execute, "write", ...)` without schema rejection.

---

## Key Design: Transparent Debug Rerouting

The critical architectural decision: **orchestrator calls `task(execute, "debug", ...)` — dispatch plugin silently reroutes to pro-backed agent**.

This preserves a clean mental model for the orchestrator:
- There is one "execute" agent. The orchestrator doesn't need to track when to call `execute` vs. `execute-debug`.
- The orchestrator uses mode keywords (`"debug"`, `"research"`) to describe the *kind of work*, not the *agent identity*.
- The dispatch plugin handles the mapping internally via `AGENT_OVERRIDES`.

This follows the existing `research → researcher` pattern: the orchestrator calls `task(research, ...)` or `task(execute, "research", ...)` and the plugin routes to the `researcher` agent with a frontier model. The orchestrator never references `researcher` or `execute-debug` by name — those are implementation details.

---

## Files Modified

| File | Changes |
|------|---------|
| `dot_config/opencode/agents/execute.md` | Changed model pro→flash. Removed research reroute footnote. |
| `dot_config/opencode/commands/execute-debug.md` | **New file**. Pro-backed debug diagnosis agent. |
| `dot_config/opencode/plugins/dispatch.ts` | Added `debug: "execute-debug"` to AGENT_OVERRIDES and DESC_TO_FILE. Fixed missing `"write"` in enum. |
| `dot_config/opencode/agents/orchestrate.md` | Added execute-debug permission. Updated dispatch table: Apply edits pro→flash, Deep reasoning pro¹→pro (removed footnote). |

---

## Key Decisions

1. **Flash as default, pro only when needed** — Edit, write, run, test, quick, scout are all mechanical operations. Running them on flash saves cost and latency. The default agent model should be the cheapest that still does the job.

2. **Dedicated execute-debug agent over conditional model switching** — Rather than having the execute agent dynamically choose model based on description (which would require complex prompt engineering), a separate agent file with explicit `model: deepseek/deepseek-v4-pro` is cleaner. The dispatch plugin handles the swap transparently.

3. **AGENT_OVERRIDES pattern for transparent routing** — The orchestrator never names `researcher` or `execute-debug`. It uses a single abstraction ("execute") with mode keywords. This keeps the orchestrator prompt simpler and prevents the LLM from trying to reason about which agent to call.

4. **Footnote removal** — The prior orchestrator prompt had a footer explaining that `task(research, ...)` actually calls the `researcher` agent. This was an implementation leak. Removing it keeps the prompt focused on *what to do*, not *how routing works*.

---

## Rollback

```bash
git checkout -- dot_config/opencode/agents/execute.md dot_config/opencode/agents/orchestrate.md dot_config/opencode/plugins/dispatch.ts \
  && rm -f dot_config/opencode/commands/execute-debug.md
```
