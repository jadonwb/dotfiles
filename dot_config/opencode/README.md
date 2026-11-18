# OpenCode configuration

## Agents

- `lead` is the default. It can work directly or delegate a bounded assignment
  to `worker`. It inspects the worker's report and diff, verifies the result,
  and can make refinements before handing the work to the user for review.
- `worker` uses DeepSeek Flash to investigate or to implement and test an
  assignment. It reports directly to the lead and cannot launch subagents.
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

`opencode.jsonc` configures MCP servers, plugins, and background compaction.
`cli.json` holds terminal preferences. The Neovim bridge provides editor
control and transcript access for connected sessions.

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
  summarized. A direct report and the existing session transcript cover
  routine handoffs.

To evaluate the setup, hold the lead model fixed and compare a few
representative tasks with and without delegation. Track accepted changes,
interventions, elapsed time, and cost.

## Verification

From the chezmoi repository:

```sh
chezmoi apply ~/.config/opencode
opencode api get /api/agent
opencode api get /api/skill
opencode plugin list
```
