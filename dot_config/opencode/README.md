# OpenCode configuration

## Agents

- `lead` is the default. It can work directly or delegate a bounded assignment
  to `worker`. It inspects the worker's report and diff, verifies the result,
  and can make refinements before handing the work to the user for review.
- `worker` investigates or implements and tests an assignment. It reports
  directly to the lead and cannot launch subagents. The lead launches it with a
  model category (`code`, `ui`, `writing`); a category without a chosen model
  runs the model in `agents/worker.md`.
- OpenCode's default `build`, `plan`, `general`, and `explore` are disabled.

Select the lead's model in OpenCode. To use the new guidance in an existing
session, switch its agent to `lead`; changing `default_agent` applies to new
sessions.

The agent files in `agents/` contain frontmatter only. A Markdown body would
replace the provider's base prompt. The `system-prompt` plugin inserts
`prompts/lead.md` or `prompts/worker.md` after the upstream base prompt on each
model request. Shared writing style and machine instructions live in
`AGENTS.md`.

## Skills and integrations

`desktop` covers desktop work, `run-as-root` covers privileged operations, and
`past-conversations` retrieves specific details from local session history. Keep
project decisions in the repository.

The `model-categories` plugin resolves `category` or `category#variant` in the
subagent tool's `model` input to the model chosen for that category, using the
model's default variant when none is given, and appends the resolved model to
the tool result. Choose models with `/worker-models` (also in the command
palette): pick a category, then a model; `ctrl+d` in the model list returns the
category to the worker's configured model. Choices are stored in the plugin's
server storage on this machine.

`opencode.jsonc` configures MCP servers, plugins, and background compaction.
`cli.json` holds terminal preferences. The Neovim bridge provides editor control
and transcript access for connected sessions.

## Why this setup

- [OpenCode's agent docs](https://opencode.ai/docs/agents/) describe background
  child sessions, direct reports, resumable work, and agent-specific
  permissions. The setup uses these mechanics directly.
- [Anthropic's multi-agent guidance](https://claude.com/resources/articles/building-multi-agent-systems-when-and-how-to-use-them)
  groups work by shared context: a worker who implements a change also has the
  context to test it.
  [Cursor's scaling experiments](https://cursor.com/blog/scaling-agents) found
  their extra integration role became a bottleneck. Those experiments ran at a
  much larger scale; they do not establish that independent review is
  universally unhelpful.
- [Anthropic's research team](https://www.anthropic.com/engineering/multi-agent-research-system)
  found external storage useful for large deliverables that lose detail when
  summarized. A direct report and the existing session transcript cover routine
  handoffs.

## Things to test and tune

### Lead and worker

- Hold both models and compaction settings fixed. Compare the old and revised
  lead prompts on a few representative tasks: a bounded change, an
  investigation, and a follow-up after user feedback. Track who takes the first
  pass, whether the result meets the acceptance criteria, correction rounds,
  elapsed time, and cost. Use lead-only runs as a baseline when measuring the
  value of delegation.

### Context and compaction

- Start with the current settings in [`opencode.jsonc`](opencode.jsonc):
  automatic background compaction, a 30% buffer, and a 32,000-token recent tail.
  OpenCode's defaults are a 15% buffer (at least 16,000 tokens) and a
  15,000-token tail. The buffer controls when compaction starts; the tail
  controls how much recent context survives it. Both settings apply across
  sessions, and each session uses its selected model's input budget. The
  compaction model selects who writes the summary. See the
  [OpenCode compaction guide](https://opencode.ai/docs/compaction).
- For a long-running lead session, check whether confirmed decisions, open
  questions, and active worker assignments survive compaction. Put decisions
  that need to survive multiple rounds in a short project note the lead can
  reread.
- Expect most fresh workers to finish one coherent assignment and its tests
  before compacting. Occasional compaction on a deep investigation is fine.
  Resume the same child for related fixes while its history helps; start fresh
  for unrelated work or when a clean brief can replace a long history.
- If routine worker tasks repeatedly compact before they finish, check task
  scope and trim noisy tool output first. If well-scoped tasks still need more
  room, test a smaller buffer and check the effect on both lead and worker.
  Change one setting at a time and record compactions, lost details, and rework
  alongside the task results.

## Verification

From the chezmoi repository:

```sh
chezmoi apply ~/.config/opencode
opencode api get /api/agent
opencode api get /api/skill
opencode plugin list
```
