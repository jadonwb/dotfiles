# OpenCode: subagent model categories

The lead routes each worker assignment to a model by category: `code`, `ui`, or
`writing`. The user picks each category's model in the TUI, so changing models
needs no prompt or config edit.

## Behavior

The plugin lives in `dot_config/opencode/plugins/model-categories/`:

- `index.ts` (server) hooks `execute.before` on the built-in `subagent` tool.
  When `model` is `category` or `category#variant`, it rewrites `model` to
  `<provider/model>`, with the variant if one was given. The model is the
  category's chosen model, or the target agent's configured model
  (`agents/worker.md`) when none is chosen. Without a variant, the model's own
  default applies. Every other value passes through, and the built-in tool validates the result. An `execute.after` hook
  appends `Model: <ref> (category "<name>")` to the tool result. The server
  part stores choices in `ctx.storage` and serves them over RPC.
- `rpc.ts` is the RPC contract (`get`, `set`) shared by both parts.
- `tui.ts` adds `/worker-models` and a palette command: select a category,
  then a model. `opencode-go` models are listed first. `ctrl+d` in the model
  list clears the choice.

Choices hold `provider/model` without a variant; the lead adds a variant per
assignment. The provider prefix separates subscription and per-token routes,
for example `opencode-go/deepseek-v4.1-flash` and `deepseek/deepseek-flash`.

A quota or rate-limit error stops the worker, and the lead reports it to the
user.

## Tested

Typecheck against `@opencode/plugin` 2.3.2 under `strict`, and a Node run of
the server part with a mocked `ctx`: each category with and without a variant
and with and without a chosen model, an omitted `model`, an explicit
reference, an unknown name, an agent without a model, a missing agent, RPC
`set` and clear, and a non-subagent tool.

## Checks in a live session

- `/worker-models` opens, lists models, saves, and `ctrl+d` clears.
- Choices persist across a service restart and apply in other projects
  (`ctx.storage` scope is undocumented).
- A lead launch with `ui`, `code#high`, and `writing` starts the child on the
  expected model, and the `Model:` line appears.
- Resuming a child with `model` omitted keeps its model.
