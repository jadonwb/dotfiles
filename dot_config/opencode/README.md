# OpenCode configuration

A single-primary-agent setup with on-demand skills and durable artifacts. The
goal is to keep the always-loaded prompt small, let the model work in one
coherent context, and reserve subagents and skills for work that genuinely needs
isolation.

## Agents

- `system` — the primary and default agent. Full tool access, general
  engineering/research instructions, concise output style, and the delegation
  policy. It does the implementation; there is no builder or command-runner
  session.
- `search` — read-only research subagent. Used when a question needs broad
  documentation or many files and only a compact answer should enter the main
  context, or when independent questions can run in parallel.
- `review` — read-only independent correctness review. Used for large or risky
  changes, or when the user asks. It has clean context, which is the point.

`plan`, `build`, `general`, and `explore` are disabled. The built-in
`compaction`, `title`, and `summary` agents remain.

## Skills

Skills are advertised by name and description; the body loads only when the task
matches. The always-loaded system prompt names the core workflow skills and
otherwise stays out of the way.

| Skill               | Load when                                              |
| ------------------- | ------------------------------------------------------ |
| `planning`          | a multi-step or risky change, or the user asks to plan |
| `research-evidence` | source/documentation research that should be reused    |
| `review-workflow`   | an independent correctness check, or the user asks     |
| `mermaid-diagrams`  | a flow, architecture, state machine, or sequence       |

Session memory is deliberately **not** a skill: it is always-on behavior in the
system prompt. Other discovered skills (`opencode`, `omarchy`, `run-as-root`,
`diagnose-crash`, `report`, …) load when their descriptions match.

The split follows the current guidance: a system prompt defines permanent
behavior and policy; a skill defines a repeatable procedure for a task that only
applies sometimes. Moving a core behavior such as memory into a skill makes it
opt-in, and the agent often will not load it at the moment it matters.

Skill authoring follows the current best practices: a specific what-and-when
description with trigger terms, a body well under 500 lines, the workflow and
tool sequence rather than a restatement of the system prompt, and supporting
detail only where it changes behavior. The always-loaded prompt is kept stable
because prompt caching keys on the prefix; variable memory is appended after the
stable instructions rather than rewriting them.

## Artifacts

`plugins/artifacts/` is a standalone filesystem-backed registry and the
`personal.artifacts` RPC used by Neovim. Kinds:

- `memory` — **project memory**, one live document per repository, shared by
  sessions, subdirectories, and linked worktrees of that checkout.
- `checkpoint` — the session's small objective/progress document.
- `plan` — an optional working document; an approval gate only when the user
  asked for a plan.
- `evidence` — reusable research with self-contained findings.
- `review` — an independent outcome and findings.
- `report` — what changed, checks, and what remains; the plan link is optional.

Create artifacts early. `memory_open`, `evidence_create`, `review_create`, and
`report_create` accept initial content, so a draft can be filled incrementally
as the work teaches you something. `artifact_search` finds existing memories and
evidence by text, so discovery does not require knowing an ID.
`plan_field_patch` replaces one unique occurrence, so a plan bullet can change
without restating the field.

The user can review artifacts in Neovim, select text, and send feedback. When
the user asks for a plan, approval is the signal to start implementing. When
they did not ask, approval is only a review marker and never a precondition.
Editing a reviewed artifact returns it to draft for re-review.

## Compaction and memory

- Every agent-loop request (`context` hook) gets a `<memory-context>` system
  part: the session checkpoint in full, bounded by keeping its head _and_ its
  tail, plus the project-memory **index** (title, description, section
  headings). Large documents are never inlined; the agent loads or searches
  them. It is never a user message and never appears in the transcript.
- Compaction uses OpenCode's built-in summary prompt unmodified. The prompt
  already covers objective, requirements, decisions, work state, next move,
  files, and context, and reconciles newer history. Nothing is injected into the
  compaction transcript: the next request reloads the checkpoint and project
  memory, so a summarizer copy would only add a second, staler version.
- Requirements and corrections belong in the checkpoint, recorded when they are
  given. Injection cannot recover a requirement the agent never saved, and a
  summary is not a substitute for the live document.
- `buffer: "30%"` keeps the last 30% of the 1M window free, so automatic
  compaction starts at ~700k tokens. `keep.tokens: 32000` keeps the recent tail.
  The threshold is a policy choice, not a measured optimum; see RESEARCH.md.
- The head+tail clip keeps the newest progress and next move. Keep the
  checkpoint small so a requirement in the middle is not clipped.

Checkpoint tests append past the bound and confirm the newest `## Next Move`
survives while the stale head is elided.

## Layout

- `agents/` — primary and subagent prompts.
- `skills/` — on-demand workflows.
- `plugins/bridge/` — frontend RPC seam: `personal.bridge` handshake and the
  domain registry every RPC domain registers through.
- `plugins/artifacts/` — artifact store, agent tools, and memory injection. No
  bridge or RPC imports.
- `plugins/artifacts-rpc/` — the editor-facing adapter: registers
  `personal.artifacts` through the bridge.
- `tests/artifacts/` — artifact store and tool/RPC tests.
- `opencode.jsonc` — default agent, compaction, MCP servers, plugin list.
- `cli.json` — terminal preferences and keybinds.
- `RESEARCH.md` — research notes behind the design.

## Bridge

Artifacts were never meant to own the Neovim <-> OpenCode channel. The channel
is now its own layer, so it can grow into session control and editor UI commands
without touching artifact code:

- `personal.bridge.describe` returns `{ protocol, domains }` — the handshake a
  frontend uses before calling a domain. It is plumbing only; it carries no
  product behavior.
- `plugins/bridge/registry.ts` exports `registerDomain` and `mintRequestID`. An
  adapter plugin registers its contract through it instead of calling
  `ctx.rpc.register` directly, so the handshake and the registration cannot
  drift apart. The artifact tools never import this module: storage and tools
  live in `plugins/artifacts/`, and only the RPC adapter
  (`plugins/artifacts-rpc/`) touches the bridge.
- The registry lives on `globalThis` under a symbol because each plugin is its
  own module instance; a module-scope map would be private per plugin.

The Neovim side mirrors this: `editor.features.opencode-rpc` is a
namespace-parameterized transport, `editor.features.opencode-session` owns
per-tab session attachment, and `editor.features.opencode-artifacts` owns only
artifact behavior.

## Verification

Artifact registry:

```sh
mise exec -- node --experimental-strip-types --test \
  dot_config/opencode/tests/artifacts/store.test.mjs \
  dot_config/opencode/tests/artifacts/project.test.mjs \
  dot_config/opencode/tests/artifacts/artifact-tools.test.mjs
```

Live checks:

```sh
opencode plugin list
opencode api get /api/agent
opencode api get /api/skill
opencode api post '/api/rpc/personal.artifacts/list?location%5Bdirectory%5D=<dir>' --data '{"input":{}}'
```

Apply changes with `chezmoi apply ~/.config/opencode`. Configuration and plugins
reload without restarting the server; a TUI part may need a fresh TUI.
