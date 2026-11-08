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
| `planning`          | the user asks to plan, or a scope decision is expensive to reverse |
| `research-evidence` | source/documentation research that should be reused    |
| `review-workflow`   | an independent correctness check, or the user asks     |
| `past-conversations` | the user asks to recall an earlier session or decision |
| `mermaid-diagrams`  | a flow, architecture, state machine, or sequence       |

Past-conversation recall is deliberately a skill (`past-conversations`): it
queries the local session database only when the user asks to remember
something. Nothing is injected on every request. Other discovered skills
(`opencode`, `omarchy`, `run-as-root`, `diagnose-crash`, `report`, …) load when
their descriptions match.

The split follows the current guidance: a system prompt defines permanent
behavior and policy; a skill defines a repeatable procedure for a task that only
applies sometimes. Durable project knowledge belongs in `AGENTS.md` and in the
repository, not in the prompt.

Skill authoring follows the current best practices: a specific what-and-when
description with trigger terms, a body well under 500 lines, the workflow and
tool sequence rather than a restatement of the system prompt, and supporting
detail only where it changes behavior. The always-loaded prompt is kept stable
because prompt caching keys on the prefix; no per-session document is appended to
it.

## Artifacts

`plugins/artifacts/` is a standalone filesystem-backed registry and the
`personal.artifacts` RPC used by Neovim. Kinds:

- `plan` — an optional working document; an approval gate only when the user
  asked for a plan. A completed plan records its outcome, changed files,
  verification, and unfinished work, then freezes. Later work starts a new plan
  with `previousPlanID`.
- `evidence` — reusable research with self-contained findings.
- `review` — an independent outcome and findings.

Create artifacts early. `plan_create`, `evidence_create`, and
`review_create` accept initial content, so a draft can be filled incrementally
as the work teaches you something. `artifact_search` finds existing artifact
text, so discovery does not require knowing an ID. `plan_update` accepts whole
fields, an ordered `evidenceIDs` list, and an optional `patch` object for one
exact occurrence, so a plan bullet can change without restating the field.
`plan_complete` records the outcome and freezes the plan.

The user can review artifacts in Neovim, select text, and send feedback. When
the user asks for a plan, approval is the signal to start implementing. When
they did not ask, approval is only a review marker and never a precondition.
Editing a reviewed artifact returns it to draft for re-review; a completed plan
cannot be edited.

## Compaction

- Compaction uses OpenCode's built-in summary prompt unmodified. No response hook
  rewrites the summary and no memory document is appended.
- `buffer: "30%"` keeps the last 30% of the 1M window free, so automatic
  compaction starts at ~700k tokens. `keep.tokens: 32000` keeps the recent tail.
  The threshold is a policy choice, not a measured optimum.
- Compaction is lossy: it keeps terse bullets and drops detail it judges
  recoverable from code or files. Write decisions and comparisons to repository
  notes or evidence while they are fresh.

## Layout

- `agents/` — primary and subagent prompts.
- `skills/` — on-demand workflows.
- `plugins/bridge/` — frontend RPC seam: `personal.bridge` handshake and the
  domain registry every RPC domain registers through.
- `plugins/artifacts/` — artifact store and agent tools. No bridge or RPC
  imports.
- `plugins/artifacts-rpc/` — the editor-facing adapter: registers
  `personal.artifacts` through the bridge.
- `tests/artifacts/` — artifact store and tool/RPC tests.
- `opencode.jsonc` — default agent, compaction, MCP servers, plugin list.
- `cli.json` — terminal preferences and keybinds.

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
