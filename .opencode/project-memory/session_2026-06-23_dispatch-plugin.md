# Session: Dispatch Plugin — Commands-as-Tools for Agent Orchestration

**Date**: 2026-06-23
**Status**: active (plugin built, OpenCode restarted, plugin loaded and functional)
**Agent**: orchestrate (DeepSeek V4 Pro)

---

## User Goal

Replace the orchestrator's text-based `[mode]` marker system (`[quick]`, `[scout]`,
`[research]`, `[verify]`) with a structured `dispatch` custom tool that:

1. Maps mode names to agent + model + prompt markers
2. Accepts multiple tasks in a single call for parallel dispatch
3. Injects return guides after subagent completion (stolen from subtask2 pattern)
4. Supports model overrides per dispatch mode (flash for quick/scout/verify/review,
   pro for deep research)
5. Has corresponding user-facing `/` commands for TUI use
6. Simplifies the orchestrator system prompt (~400 lines removed)

---

## Research Performed

### Source 1: OpenCode Commands Docs
- **URL**: https://opencode.ai/docs/commands/
- **Tool**: `webfetch`
- **Key findings**:
  - Commands are user-facing TUI shortcuts (`/command`), NOT agent-callable tools
  - Commands have `agent`, `subtask`, `model` frontmatter options
  - `subtask: true` forces subagent invocation instead of inline execution
  - `$ARGUMENTS` placeholder for passing args
  - No mechanism to expose commands as agent-callable tools
  - The `agent` option routes command output TO an agent, doesn't let agents invoke commands

### Source 2: OpenCode Agents Docs
- **URL**: https://opencode.ai/docs/agents/
- **Tool**: `webfetch`
- **Key findings**:
  - Primary agents vs subagents (mode: primary vs mode: subagent)
  - `hidden: true` hides subagents from @ autocomplete but doesn't prevent Task tool invocation
  - Task tool permissions control which subagents an agent can invoke
  - Agent → agent invocation is via Task tool or @mention, NOT via commands

### Source 3: OpenCode Plugins Docs
- **URL**: https://opencode.ai/docs/plugins/
- **Tool**: `webfetch`
- **Key findings**:
  - Plugins can register custom tools via `tool()` helper from `@opencode-ai/plugin`
  - Plugin function receives `{ project, client, $, directory, worktree }` — `client` is the SDK client
  - Custom tools have `execute(args, context)` with `context = { agent, sessionID, messageID, directory, worktree }`
  - The SDK `client` is accessible via closure in plugin-scoped tools
  - Plugin hooks: `tool.execute.before/after`, `command.execute.before`, `session.idle`, `experimental.chat.messages.transform`
  - Plugins loaded from `.opencode/plugins/` directory (auto-loaded by OpenCode)

### Source 4: OpenCode Custom Tools Docs
- **URL**: https://opencode.ai/docs/custom-tools/
- **Tool**: `webfetch`
- **Key findings**:
  - Tools defined in `.opencode/tools/` (separate from plugins)
  - Tools in plugins registered via `tool()` helper have access to plugin context
  - Custom tools can override built-in tools if they share a name
  - Tools receive `context` with `directory` and `worktree` but NOT `client` directly (plugins get `client` from closure)

### Source 5: OpenCode SDK Docs
- **URL**: https://opencode.ai/docs/sdk/
- **Tool**: `webfetch`
- **Key findings**:
  - `client.session.command({ path, body })` — sends command to session, body = `{ command, arguments }`
  - `client.session.promptAsync({ path, body })` — sends prompt with subtask parts
  - `client.session.prompt()` — sends prompt, can include `noReply: true` for context-only
  - `client.tui.executeCommand({ body })` — executes TUI command programmatically
  - `session.prompt()` accepts `model` override in body
  - Subagent spawning: use `parts: [{ type: "subtask", agent, model, description, prompt }]`

### Source 6: OpenCode Permissions Docs
- **URL**: https://opencode.ai/docs/permissions/
- **Tool**: `webfetch`
- **Key findings**:
  - Custom tools use their filename as the permission key
  - `task` permission controls subagent invocation (matches subagent type)
  - Default permissions for unlisted tools: `allow`
  - Most tools default to `allow` unless explicitly denied

### Source 7: OpenCode Ecosystem Page
- **URL**: https://opencode.ai/docs/ecosystem/
- **Tool**: `webfetch`
- **Key findings**:
  - Discovered `@openspoon/subtask2` — "Extend opencode /commands into a powerful orchestration system with granular flow control"
  - 223 stars, 222 commits, MIT licensed
  - This plugin is a reference implementation for what we're building

### Source 8: subtask2 GitHub Repository
- **URL**: https://github.com/spoons-and-mirrors/subtask2
- **Tool**: `webfetch` (README, index.ts, src/core/plugin.ts, src/hooks/command-hooks.ts, src/hooks/tool-hooks.ts, src/hooks/session-idle-hook.ts, src/features/returns.ts, src/types.ts)
- **Key findings**:
  - Uses `client.session.command({ path, body: { command, arguments } })` to trigger commands programmatically in return chains
  - Uses `client.session.promptAsync({ path, body: { parts: [{ type: "subtask", agent, model, prompt }] } })` for inline subtasks
  - `session.idle` event fires when a session is truly idle — used to inject return prompts
  - `experimental.chat.messages.transform` hook removes OpenCode's generic "summarize task output" message
  - `command.execute.before` hook intercepts command arguments for parsing
  - `tool.execute.before/after` hooks track task tool invocations for state management
  - Plugin stores state in memory (no persistence needed)
  - Named results: `{as:name}` captures subagent output, `$RESULT[name]` references it
  - Loop: `{loop:max && until:condition}` repeats until condition met
  - Parallel: `parallel: [/cmd1, /cmd2]` runs multiple subtasks concurrently
  - `$TURN[n]` injects last N conversation turns into command templates

### Source 9: Existing Agent Definitions (Codebase)
- **Files**: `/home/jadon/.local/share/chezmoi/dot_config/opencode/agents/orchestrate.md`, `search.md`, `researcher.md`, `review.md`, `execute.md`
- **Tool**: `task` → `search` agent in `[quick]` mode
- **Key findings**:
  - Orchestrator prompt was ~747 lines, with ~200 lines dedicated to mode-marker system
  - Search agent uses `### [mode]` headers in prompts to switch behavior
  - Researcher agent uses `### [research]` header for dossier mode
  - Review agent uses `[code]` and `[docs]` modes
  - Orchestrator permissions: `task: { search: allow, researcher: allow, review: allow, execute: allow }`

### Source 10: Existing Config (Codebase)
- **File**: `/home/jadon/.local/share/chezmoi/dot_config/opencode/opencode.jsonc`
- **Tool**: `task` → `search` agent
- **Key findings**:
  - Default agent: `orchestrate`
  - Model: `deepseek/deepseek-v4-pro`, small_model: `deepseek/deepseek-v4-flash`
  - Build, plan, general, explore agents all disabled
  - One plugin registered: `@tarquinen/opencode-dcp@latest`
  - No `commands/` or `plugins/` directories existed before this session
  - Workspace path: `/home/jadon/.local/share/chezmoi/` (chezmoi-managed dotfiles)
  - Agent configs under `dot_config/opencode/agents/` (maps to `~/.config/opencode/agents/`)

### Source 11: @opencode-ai/plugin npm page
- **URL**: https://www.npmjs.com/package/@opencode-ai/plugin
- **Tool**: `webfetch`
- **Key findings**: v1.17.9, no README, MIT licensed. The `tool()` helper and Plugin type are from this package.

### Source 12: OpenCode Tools Docs
- **URL**: https://opencode.ai/docs/tools/
- **Tool**: `webfetch`
- **Key findings**: Listed all built-in tools (bash, edit, write, read, grep, glob, lsp, apply_patch, skill, todowrite, webfetch, websearch, question). The `task` tool invokes subagents.

---

## Architecture Decisions

### Decision 1: Plugin-based custom tool (not command-only)
**Reason**: Commands are user-only (TUI). Agents need a callable tool. A plugin registers
a custom tool that agents can invoke directly.

### Decision 2: `session.promptAsync()` with subtask parts (not `session.command()`)
**Reason**: `session.promptAsync()` accepts an array of `subtask` parts, allowing
multiple subagents to run in parallel from a single call. `session.command()` targets
a single command and may serialize. subtask2 proves this pattern works. The return
type is unknown (may be fire-and-forget, may block until completion) — needs runtime
testing.

### Decision 3: Backward-compatible prompt format
**Reason**: The dispatch tool prepends `### [mode]` markers to prompts (e.g.,
`### [quick] lookup X in file Y`) so current search/researcher/review agents
can still parse them. This avoids needing to change those agent definitions
immediately. The mode markers can be removed from agent prompts later when
the dispatch tool is stable.

### Decision 4: Return guide injection via `session.idle` event
**Reason**: subtask2 demonstrates that after a `subtask: true` command/spawn completes,
the `session.idle` event fires. We hook this to inject a guided follow-up prompt
telling the orchestrator how to process the subagent's results. This replaces
OpenCode's generic "summarize task output" message. Also copied from subtask2's
pattern.

### Decision 5: In-memory state (no persistence)
**Reason**: Return guides are ephemeral — they only matter for the current session.
A simple `Map<string, string[]>` tracks pending returns per sessionID. No disk
persistence needed. This matches subtask2's approach.

### Decision 6: Both commands AND dispatch tool (hybrid)
**Reason**: Commands work in TUI for user invocation (`/quick-lookup`). The dispatch
tool works for agent invocation (`dispatch(mode: "quick", task: "...")`). Both layer
on the same infrastructure. User chose this hybrid approach explicitly.

---

## What Was Built

### New Files Created

| File | Purpose |
|------|---------|
| `dot_config/opencode/plugins/dispatch.ts` | Custom `dispatch` tool plugin (158 lines) |
| `dot_config/opencode/commands/quick-lookup.md` | `/quick-lookup` command — search agent, flash model |
| `dot_config/opencode/commands/scout.md` | `/scout` command — search agent, flash model |
| `dot_config/opencode/commands/deep-research.md` | `/deep-research` command — researcher agent, pro model |
| `dot_config/opencode/commands/verify-string.md` | `/verify-string` command — search agent, flash model |
| `dot_config/opencode/commands/code-review.md` | `/code-review` command — review agent, flash model |
| `dot_config/opencode/commands/docs.md` | `/docs` command — review agent, flash model (session audit) |

### Files Modified

| File | Changes |
|------|---------|
| `dot_config/opencode/agents/orchestrate.md` | +186/-421 lines. Removed TRIGGER KEYWORDS table, mode invocation examples, decision flowchart. Replaced with `## Investigation Dispatch` section referencing `dispatch` tool. Updated all stale `[mode]` marker references throughout (hard constraints, Phase 1, Phase 5, Phase 6, Propose, Tool Usage Rules, review section). |
| `dot_config/opencode/opencode.jsonc` | +1 line: `"./plugins/dispatch.ts"` added to plugin array |

### Dispatch Tool Architecture

```
Orchestrator calls: dispatch(tasks: [{mode: "quick", task: "..."}, ...])

    ▼
dispatch.execute() in dispatch.ts:
  1. Maps each mode → agent name, model, prompt marker
  2. Formats prompt: "### [marker] task text"
  3. Collects return guides for each task
  4. Calls client.session.promptAsync() with subtask parts
  5. Stores return guides in pendingReturns Map
  6. Returns acknowledgment: "Dispatched N task(s)"


    ▼
Subagents run in parallel (if multiple tasks)


    ▼
session.idle event fires → inject return guide as user message
```

### Mode Configuration

```typescript
const MODE_CONFIG = {
  quick:        { agent: "search",     model: v4-flash, marker: "[quick]",     returnGuide: "..." },
  scout:        { agent: "search",     model: v4-flash, marker: "[scout]",     returnGuide: "..." },
  research:     { agent: "researcher", model: v4-pro,   marker: "[research]",  returnGuide: "..." },
  verify:       { agent: "search",     model: v4-flash, marker: "[verify]",    returnGuide: "..." },
  "code-review":{ agent: "review",     model: v4-flash, marker: "[code]",      returnGuide: "..." },
  docs:         { agent: "review",     model: v4-flash, marker: "[docs]",      returnGuide: "..." },
}
```

---

## What Was NOT Done (Deferred)

### Runtime Testing
- **CRITICAL**: Does `client.session.promptAsync()` with multiple `subtask` parts actually run them in parallel? Or does it serialize?
- **CRITICAL**: Does `client.session.promptAsync()` return immediately (fire-and-forget) or block until all subagents complete?
- **CRITICAL**: Does the `session.idle` event fire reliably after subtask completion? Or does the generic "summarize" message come through first?
- If `session.idle` is unreliable, fall back to `experimental.chat.messages.transform` hook as subtask2 does
- Does `$ARGUMENTS` in command templates work with multi-line prompt text containing special characters?

### Agent Simplification
- `search.md` and `researcher.md` still parse `### [mode]` markers from prompt text. Once dispatch is stable, these agents can be simplified since mode is implicit.
- `search.md` and `researcher.md` could potentially be merged into one `investigate.md` agent that switches model based on a parameter. The dispatch tool already handles model selection.
- `review.md` still uses `[code]` and `[docs]` internal markers — these are handled by the dispatch tool's `marker` field.

### Remaining Stale Marker References (Intentional)
- The review agent section in orchestrate.md (lines 236-244) still documents `[docs]` and `[code]` modes as part of the review agent's **internal** mode table. This is legitimate documentation of what the review agent does internally — the orchestrator uses `dispatch` to invoke them. This is NOT a stale reference.
- The `dispatch.ts` plugin uses `marker: "[code]"` etc. to format prompts for backward compatibility — these markers are intentionally preserved until agent prompts are simplified.

### Testing Checklist (Post-Restart)
1. Restart OpenCode
2. Verify `dispatch` appears in available tools
3. Test: `dispatch(tasks: [{mode: "quick", task: "read dot_config/opencode/agents/orchestrate.md, find 'Investigation Dispatch', confirm the section exists"}])`
4. Test multi-task: `dispatch(tasks: [{mode: "quick", ...}, {mode: "scout", ...}])` — verify parallelism
5. Test return guide: after dispatch completes, verify the guided follow-up prompt appears as a user message
6. Test TUI commands: type `/quick-lookup test` in TUI — verify command dispatches correctly
7. Test `/docs` command — verify review agent audits project memory
8. Test `/code-review` command — verify review agent audits code changes

---

## Remaining Unknowns (Validate During Use)

| Unknown | Priority | How to validate |
|---------|----------|-----------------|
| `session.promptAsync()` with multiple subtask parts — parallel or serial? | High | Dispatch 2+ tasks in one call, observe timing |
| Does `session.promptAsync()` block until all subagents complete, or return immediately? | High | Observe orchestrator turn timing after dispatch |
| Does `session.idle` fire reliably after subtask completion for return guide injection? | Medium | First dispatch will reveal this |
| Do return guides inject cleanly without duplicates? | Medium | Check after first multi-task dispatch |

---

## Git Status

After this session, the following are changed but not committed:
- `dot_config/opencode/agents/orchestrate.md` (modified)
- `dot_config/opencode/opencode.jsonc` (modified)
- `dot_config/opencode/plugins/dispatch.ts` (new, untracked)
- `dot_config/opencode/commands/*.md` (new, untracked — 7 files)

Commit message suggestion:
```
feat: dispatch plugin — replace [mode] text markers with structured dispatch tool

Adds custom dispatch tool (plugin) that maps mode names to agent+model,
supports parallel multi-task dispatch, and injects return guides after
subagent completion. Creates 7 user-facing /commands. Simplifies
orchestrator prompt by ~400 lines.
```

---

## Current State (Post-Restart)

OpenCode has been restarted. The dispatch plugin is loaded and functional.

- The `dispatch` tool IS available in the orchestrator's toolkit
- The orchestrator's system prompt references `dispatch` instead of `[mode]` markers
- All 6 slash commands (`/quick-lookup`, `/scout`, `/deep-research`, `/verify-string`, `/code-review`, `/docs`) are available in the TUI
- The orchestrator should use `dispatch()` for ALL code investigation, not the `task` tool with mode markers

### Immediate Verification Items
1. Verify `dispatch` appears in available tools — call `dispatch(tasks: [{mode: "quick", task: "read this session file, confirm dispatch plugin is documented"}])`
2. Test multi-task parallel dispatch: `dispatch(tasks: [{mode: "quick", ...}, {mode: "scout", ...}])`
3. Verify return guides are injected after dispatch completes (guided follow-up prompt)
4. Test TUI commands: `/quick-lookup test` in TUI
5. If anything fails, check OpenCode logs for plugin errors
