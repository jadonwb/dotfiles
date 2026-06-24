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
