# OpenCode V2: subagent model pools

Research snapshot: November 19, 2026. Step 1 is implemented and committed;
it has not run in a live session yet.

## Status and next steps (November 19, end of day)

Committed, and **not yet applied with chezmoi**:

- `dot_config/opencode/plugins/model-pools/index.ts`: an `execute.before`
  hook on the `subagent` tool replaces a pool name in `model` with the first
  entry from `pools.json` that is in `ctx.model.list()` with the requested
  variant. When no entry is available it passes the first one, so the built-in
  tool reports the unavailable model. An `execute.after` hook appends
  `Model: <ref> (pool "<name>")` to the tool's string content. Values with a
  `/`, unknown names, and omitted `model` pass through unchanged.
- `dot_config/opencode/plugins/model-pools/pools.json`: pools `default`,
  `frontend`, `debug`, `writing` (all `opencode-go`), and `fast` (direct
  `deepseek/deepseek-flash`, per token). `debug` lists GLM-5.3 first for the
  promotion that ends November 22; move Kimi first after that.
- `dot_config/opencode/prompts/lead.md`: adds the assignment Type field, a
  routing table of Type → pool → review focus, explicit authorization to set
  `model` (the built-in tool description says to set it only on user request),
  `fast` for small tasks the user waits on, and resume with `model: "fast"` on
  an `opencode-go` quota error. The Review section requires reading the full
  diff and checking the routing table's review focus.

Tested: a Bun script with a mocked `ctx` and the live `/api/model` output
resolved every pool, passed through omitted, explicit, and unknown values, left
other tools untouched, skipped a missing first entry, and fell back to the
first entry for an empty catalog. The real `ctx.model.list()` return shape is
assumed to match `/api/model` (`{ location, data }`); the plugin also accepts a
bare array.

Next, at home:

1. `chezmoi apply ~/.config/opencode` and start a lead session. Check the
   server log for `model-pools` errors.
2. Run the first two checks under "Checks before deployment": each pool name,
   an omitted model, an explicit reference, an unknown name, and a resume with
   and without `model`. Confirm the child session's actual model and the
   `Model:` line in the tool result.
3. Trigger or wait for a real `opencode-go` quota error and record how it
   reaches the lead (error text, retry delay). That decides step 2.

Step 2 (planned): a session `retry` hook marks a route exhausted with a
cooldown when it sees a quota error, so the `execute.before` hook skips it on
the next dispatch. Because paid Go models share one allowance, treat a Go quota
error as provider-wide and fall through to a per-token entry only when a
config flag such as `allowPaid` permits it. A running worker still needs the
lead's resume: `retry` cannot change the model, and
`experimental.model.resolve` only switches within one provider.

Later idea: a single virtual DeepSeek provider whose `http.request` hook sends
requests to Go or the direct API depending on quota state. That would cover
the lead's own session and compaction as well. It depends on experimental
hooks and on matching Go's quota error.

## Goal

Let the lead choose a task category when it calls the native `subagent` tool.
Keep model IDs, preference order, and billing policy in one place. Use
OpenCode Go subscription models first. Keep OpenCode's existing worker
permissions, background execution, and session continuation.

The routing table in `dot_config/opencode/prompts/lead.md` maps assignment
types to pool names, and `plugins/model-pools/pools.json` maps pool names to
model references. The lead still owns the assignment and reviews the worker's
actual changes for correctness, simplicity, style, and test coverage.

## Keep the built-in tool

OpenCode V2's [server plugin API][tools-hook] exposes
`ctx.tool.hook("execute.before", …)`, which can replace a tool's input.
The [tool dispatcher][dispatcher] passes the hook's rewritten input to the
built-in executor. The [`subagent` implementation][subagent] accepts a string
in `model`, then parses it as `provider/model#variant` and checks that the
model and variant are available. The built-in tool already uses the same
hook to remove empty `model` and `sessionID` fields.

A plugin can match `event.tool === "subagent"`, recognize an exact alias in
`event.input.model`, and replace that value with the selected model reference.
All other arguments pass through as supplied. The built-in executor still
starts or resumes the child and applies its usual validation.

| `model` input | Proposed behavior |
| --- | --- |
| Omitted | Let OpenCode select the configured model on launch. A continuation with the same agent keeps the existing child's model. |
| `default` | Select from the explicit general-purpose pool. This is distinct from omitting `model`. |
| `frontend`, `debug`, `writing` | Select from the corresponding pool. |
| `provider/model` or `provider/model#variant` | Pass through to OpenCode's native handling. |
| Unrecognized keyword | Preserve OpenCode's invalid-model error. |

For example, a call with `agent: "worker"` and `model: "frontend"` could reach
the built-in executor with `model: "opencode-go/gemini-4-argon#high"`. Passing a
pool alias with a `sessionID` requests a model selection for that
continuation. Omit `model` when the intent is to keep the same worker model.
OpenCode added explicit overrides for both new and existing child sessions
in [PR #49194][model-override].

The stock tool description tells the caller to use `model` only on explicit
request and describes concrete references. Lead guidance should explicitly
authorize the pool keywords and explain when to omit the field. The lead
already classifies the assignment to write its handoff; the plugin can select
the model with fixed rules. This design needs no separate model classifier.

## Pool order and fallback

Start with ordered lists. Select the first eligible available chat model and
check any requested variant. An entry missing from the catalog can be skipped.
An entirely unavailable pool should report that clearly, especially when its
remaining candidates would require per-token billing outside the configured
policy. A pool is also a useful place to record why each model is listed and
what the lead should review closely.

Distinguish these cases:

1. **Catalog availability at dispatch.** The hook can skip an unavailable
   model or variant. A valid catalog entry does not prove that credentials,
   account allowance, or inference capacity are usable for this request.
2. **Known quota state at dispatch.** A later version could skip a route
   already marked as exhausted until its reset or cooldown. Go's paid models
   draw from a shared allowance, so switching to a second Go model does not
   necessarily clear an account-level limit. Track the scope of the failure
   before marking a model or provider unavailable.
3. **Quota failure after dispatch.** The tool returns a child `sessionID`
   before inference fails. The pre-execution hook cannot recover that running
   assignment. The initial plan is for the lead to recognize a provider
   failure and continue the same child with
   `model: "deepseek/deepseek-flash"` when paid fallback is allowed. Before
   relying on this, check how Go's quota error reaches the lead and how long
   native retry delays the notification. Distinguish allowance exhaustion from
   a temporary rate limit.

Direct DeepSeek can also be an explicit latency choice for a small assignment
the user is waiting on. The working observation was roughly twice the
inference speed of the Go route; no timing benchmark was run in this
investigation. It bills per token. Keep this choice separate from quota
recovery so a normal pool lookup follows the subscription-first policy.

## GLM-5.3 promotion

The November 19 [OpenCode Go model catalog][catalog] listed these monthly
usage ceilings on the $10 Go plan:

| Catalog ID | Go ceiling | Input modalities listed by Go |
| --- | ---: | --- |
| `opencode-go/glm-5.3` | $500 | Text |
| `opencode-go/glm-5.3-flash` | $60 | Text, images, video |

The **$500 promotion applies to the full GLM-5.3**. The [Go usage
documentation][go-limits] says the higher limit applies through November 22,
2026. The dollar figure is the usage ceiling if you spend the full monthly
allowance on that model. Paid Go models share the allowance, and the 5-hour
and weekly limits still apply. Recheck the catalog before relying on these
figures after the promotion.

The OpenCode model lookup confirmed both Go models support `low`, `high`,
and `max`. Go describes the full model as its flagship for long-horizon
coding and complex project delivery. [Z.ai reports][glm-full] a DeepSWE v1.1
score of 66.9 for GLM-5.3 versus 46.2 for GLM-5.2. That supports a trial on
longer engineering assignments. It does not establish how GLM compares with
Kimi on these repositories. [Z.ai's Flash announcement][glm-flash] describes
Flash's native multimodal inputs, which make it a candidate for work with
screenshots.

## Suggested subscription-first pools

The following are starting points for trials, not measured rankings:

| Pool | First choice or trial | Selection and review notes |
| --- | --- | --- |
| `default` | `opencode-go/deepseek-v4.1-flash` | Keep Flash for short lookups, bounded research, and mechanical edits. Check sources and scope. Route longer investigations to `debug`. |
| `frontend` | `opencode-go/gemini-4-argon#high` | Keep Gemini first for screenshots, layout, and visual verification. Trial `opencode-go/glm-5.3-flash` as a second visual candidate. Full GLM-5.3 can handle complex React or QML logic when the inputs are text. |
| `debug` | Trial `opencode-go/glm-5.3#high` first during the promotion; compare with `opencode-go/kimi-k3.1-pro#high` | Use for root-cause work, multi-file fixes, and repeated edit/test cycles. Check the stated cause, caller behavior, and regression tests. Reassess the order after the promotion. |
| `writing` | `opencode-go/claude-haiku-5-5` | Keep Haiku first for prose, documentation, and prompts. Review against `AGENTS.md`. The available GLM evidence is stronger for engineering than for this writing style. |

## Checks before deployment

- Exercise an omitted model, each recognized alias, an explicit model ID,
  and an unknown alias. Check the actual child model and confirm that native
  permission checks and background return behavior still work.
- Resume a child first with `model` omitted, then with an explicit alias.
  Confirm the child keeps its `sessionID` and only changes model on the
  requested override.
- Simulate a missing catalog entry and an exhausted pool. Check that
  candidate order is respected and per-token routes are used only when
  allowed. Test quota recovery separately with a controlled failure.
- Compare GLM and Kimi on the same bounded debugging assignment. Compare
  Gemini and GLM Flash on a screenshot-driven frontend task. Record elapsed
  time, allowance consumed, checks run, and defects the lead finds in review.

[tools-hook]: https://opencode.ai/docs/build/plugins/server/#tools
[dispatcher]: https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool.ts
[subagent]: https://github.com/anomalyco/opencode/blob/dev/packages/core/src/tool/plugin/subagent.ts
[model-override]: https://github.com/anomalyco/opencode/pull/49194
[catalog]: https://opencode.ai/inference/go/v1/models
[go-limits]: https://opencode.ai/docs/console/go/#usage-limits
[glm-full]: https://z.ai/blog/glm-5.3
[glm-flash]: https://z.ai/blog/glm-5.3-flash
