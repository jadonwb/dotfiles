# Agentic setup research notes

These are the findings that drove the November 2026 rework. They are kept here
so a future session can see why the setup looks the way it does instead of
re-deriving it.

## OpenCode V2 defaults

The V2 default system prompt (extracted from the installed 2.2.6 binary) is a
compact harness prompt, not a long role description. Its durable ideas:

- Responses render as GitHub-flavored Markdown, and `<system-reminder>` blocks
  are harness instructions.
- Prefer parallel independent tool calls.
- Intermediate commentary exists to collaborate: state assumptions, discoveries,
  tradeoffs, and blockers; do not narrate routine reads, searches, or edits.
- Final answers lead with the outcome and stay self-contained.
- Do not spawn subagents unless the user or instructions explicitly ask for
  them; the harness treats delegation as an exception, not a default.
- Keep changes consistent with surrounding code; treat unfamiliar files as
  potential user work.
- Do not revert or discard changes you did not make; prefer non-interactive
  commands.
- Do not infer authorization beyond the request.

The setup adopts those rules and adds only the user-specific pieces: artifact
memory, a review workflow, and DeepSeek tool guidance.

## Compaction

OpenCode's built-in summary prompt asks for terse single-line bullets, a short
"Relevant Files" list, and explicitly prefers short references. On later
compactions it reconciles the previous compaction summary and gives newer history
precedence. No request override is installed: an earlier prompt override and a
later addendum were both removed (see the 2026-11-07 section), because they
duplicated the built-in, depended on English marker strings, and had no A/B
showing benefit. The anchor set lives outside the summarizer instead.

The summary keeps the tiered shape now common in harnesses:

- **T0 — instructions/rules** are re-read by the harness after compaction; do
  not duplicate them in the summary.
- **T1 — task state** (objective, requirements, decisions, completed/active/
  blocked work, next move, exact identifiers) is carried verbatim or nearly so.
- **T2 — durable memory** is externalized in the artifact registry and
  re-read by the harness, so it survives any number of summaries.
- **T3 — transcript** is what gets compressed.

The same idea appears in Claude Code (compaction re-reads `CLAUDE.md` and auto
memory from disk) and in Codex discussions where a 97% → 42% progress regression
after compaction was traced to execution state being summarized like chat
history. The fix is not a better summary; it is keeping the anchor set outside
the summarizer.

## Claude Code and Codex memory patterns

- **Claude Code**: `CLAUDE.md` is user-authored instructions; auto memory is
  agent-authored notes under the project state directory. Both load at session
  start. The memory tool exposes a client-side `/memories` directory with
  view/create/str_replace/insert/delete/rename operations. Compaction re-reads
  memory from disk, so it is not lost. Auto memory keeps `MEMORY.md` as an index
  and loads only its first 200 lines or 25 KB per session, with topic files read
  on demand — a built-in budget that matches our ~40-line resume index
  (<https://code.claude.com/docs/en/memory>).
- **Claude Code rules and hooks**: `.claude/rules/*.md` with a `paths:`
  frontmatter loads only when a matching file is touched. Instructions are
  advisory; hooks, deny rules, and managed settings are deterministic. The test
  is explicit: a line that keeps getting missed belongs in a hook, and a hook
  that only encodes a preference should be deleted
  (<https://code.claude.com/docs/en/best-practices>). That is why memory
  injection and compaction are harness behavior here, not prose in a skill.
- **Codex**: `AGENTS.md` is a layered chain (`~/.codex/AGENTS.md`, then
  root-down to cwd, 32 KiB cap) and `config.toml` is layered too; profiles are
  now separate files. Custom agents are TOML with a required
  `developer_instructions`.
- **Codex ExecPlan**: a versioned living document with `Progress`,
  `Surprises & Discoveries`, `Decision Log`, and `Outcomes & Retrospective`
  sections, plus observable acceptance criteria. It is the canonical answer to
  surviving compaction and restarts: state lives on disk, not in the transcript
  (<https://cookbook.openai.com/articles/codex_exec_plans>).

Applied here: memory is always published. Project memory is injected as a
structured section index on every primary request; session memory is appended
after compaction. Plans are working documents that can be updated incrementally,
not a single write at the end.

## DeepSeek V4.1 Flash 1017

- `deepseek-flash` is served by DeepSeek-V4.1-Flash-1017; 1M context, 384k
  output on the OpenCode Go route.
- Thinking is integrated into tool use: the model can reason between tool calls.
  The harness should not force all tool calls to the end of a turn.
- The release emphasizes end-to-end project development and shorter outputs.
  Prompt for the goal and constraints, not a micro-step script.
- Reasoning content from earlier turns is ignored by the API; durable state must
  live in messages, artifacts, or memory, not in prior reasoning. When the
  request carries tools, `reasoning_content` must be passed back on every prior
  turn or the API returns 400 — an integration concern, not a prompt concern
  (<https://api-docs.deepseek.com/guides/thinking_mode>).
- Keep system instructions explicit about tool names, namespaces, and stopping
  conditions; the model follows concrete contracts well.
- Effort levels map `minimal→low`, `medium→high`, `xhigh→high`, `max→max`.
  Community reports put `max` at 1.6–1.8× longer trajectories for marginal
  gains, so reserve it for genuinely hard reasoning.

### DeepSeek Harness architecture

- `dsh` is an everything-is-a-plugin Cordis tree; the agent loop, prompt, tools,
  and session log are all services
  (<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>).
- The system prompt is node 0 of the append-only session log, not a request
  field. Editing it mid-session is a history mutation; volatile state belongs in
  `PromptContext`, which is appended after retained history and only when it
  changed. This is the same stable-prefix rule the artifact plugin follows.
- Tools expose only name, description, and parameter schema to the model;
  capability is the description. Tool availability is resolved once per step.
- Compaction appends a user-role summary node that replaces a surface range. A
  documented non-convergence defect can loop because the summary is the same
  size as the span it replaces; oversized tool results are pruned first
  (<https://github.com/deepseek-ai/deepseek-harness/discussions/8733>). Keep
  tool outputs small and avoid re-summarizing summaries.
- Workspace `AGENTS.md` is injected as one user-role message into every agent,
  including children (16k characters measured in one workspace), which is why a
  bounded subagent should open its target first instead of surveying the repo
  (<https://github.com/deepseek-ai/deepseek-harness/discussions/7361>).

### Scaffold size

DeepSeek's own cross-scaffold benchmarks favor a narrow tool surface: DSH
Minimal (bash + `str_replace_editor`) scores 90.6 on Terminal-Bench 2.1 and 72.6
on DeepSWE v1.1, ahead of DSH Standard (85.8 / 70.5), Claude Code (88.0 / 69.8),
and OpenCode (85.0 / 65.5)
(<https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash>). For this model,
cutting tools beats adding instructions, and model-written TypeScript
orchestration (PTC) is worse than direct tools. That is the strongest argument
for this setup's direction: one full agent, two read-only subagents, artifacts
instead of extra orchestration tools, and no custom renderer.

Applied here: the system prompt states goals and tool contracts, the memory
artifact carries durable reasoning results, and agents write incrementally.

## Single agent vs subagents

The current evidence is consistent:

- Sequential, stateful coding work is better in one context. Multi-agent
  coordination adds token overhead and loses shared state.
- Subagents pay off for context isolation (large research output, codebase
  exploration) and for genuinely independent parallel work.
- Writes should stay single-threaded; multiple writers create conflicting
  implicit decisions, even in separate worktrees.
- A clean-context reviewer catches defects the author cannot see, so review is a
  good independent-subagent role.
- Anthropic's 2026 reversal is explicit: a single agent with skills frequently
  beats both one-giant-prompt and subagent designs on quality, often at lower
  cost and latency, because handoffs lose context and produce a "telephone game"
  (<https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop>).
  Keep a subagent only for measurable context bloat, parallel work with
  disposable context, or conflicting-instruction problems — divide by context,
  not by problem type. Tool choice also degrades past roughly 30–50 tool
  definitions, so a small advertised surface is part of the same argument.
- Real dotfiles converge on the same shape: a short routing index, modular
  on-demand knowledge, state on disk, and a handful of deterministic guards. One
  maintained setup publicly cut 32 skills to 17 and 15 hooks to 5 with "same
  power, half the parts" (<https://github.com/jonathanmalkin/jules>).

Applied here: `system` is the only primary agent and does the implementation.
`search` isolates research, `review` gives an independent correctness pass.
There is no planner, builder, or command-runner session, and Code Mode keeps the
advertised tool count small while the artifact tools stay namespaced.

## Diagrams

Mermaid rendering is built into OpenCode. The TUI binary contains a built-in
plugin, `opencode.merman`, that registers a `mermaid` Markdown code block
renderer; the graphical clients render the same fence inline. There is therefore
no reason for a custom renderer, RPC, or terminal ASCII fallback. The
`mermaid-diagrams` skill is the whole feature: when a diagram helps, which
Mermaid diagram type to use, and how to keep it small and correct.

Advanced or interactive visualization is future work. A custom TUI panel or a
terminal image protocol would be the place to explore it later, not a second
Mermaid renderer.

## Skills

The current best-practice split is **policy vs procedure**:

- The system prompt is permanent operating posture: identity, safety,
  truthfulness, communication style, tool discipline, delegation policy, and
  core memory behavior. It applies to every request and must be reliable.
- A skill is a repeatable workflow for a job that only applies sometimes. It is
  advertised by name and description, and its body loads on demand.
- If an instruction must shape every answer, keep it in the system prompt. If it
  is a procedure for one scenario, make it a skill.
- Moving core behavior into a skill makes it opt-in; the agent may not load it
  at the moment it matters. Memory is the clearest example: it has to be active
  before the agent knows the session will be long.
- Progressive disclosure still applies inside skills: a specific what-and-when
  description with trigger terms, a body well under 500 lines, supporting files
  only when needed, and no restatement of the system prompt.

Prompt caching adds a practical constraint: cache keys match the stable prefix,
so the system prompt should stay character-stable and variable context should be
appended after it. A timestamp or changing memory block at the top of the system
prompt destroys the cache. The artifact plugin appends session memory as an
extra system part at the end of the instructions, so the stable prefix before it
remains cacheable.

We tried two alternatives first: a request-only user message after the
conversation (the `opencode-orchestrator` pattern) and a keyed session
instruction entry (`ctx.session.instructions.entry`). Both were visible in the
TUI as if the user had said the memory, so they were rejected. The system-part
append is invisible and good enough for caching.

Applied here: **session memory stays in the system prompt as default behavior**.
`planning`, `research-evidence`, `review-workflow`, and `mermaid-diagrams` are
on-demand skills. The system prompt names those optional workflows but keeps
their detailed procedures out of the default context.

## Compaction verification

A synthetic session stored `ORANGE-42` only in its memory artifact, then ran a
manual compaction. The first attempt failed with
`TypeError: u.content.map is not a function` because the memory hook pushed a
message with string content instead of typed content parts. After fixing the
hook to push `content: [{ type: "text", text }]`, compaction completed and the
compaction summary preserved the memory and artifact ID. A follow-up prompt answered
`ORANGE-42` from the re-injected memory. This is the end-to-end proof that the
context hook and memory index work together; the old compaction hook mentioned
in that experiment has since been removed.

## Deeper research (2026-11)

### Context engineering

- Manus, "Context Engineering for AI Agents: Lessons from Building Manus"
  (<https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus>):
  the KV-cache hit rate is the top production metric; keep the prefix stable,
  append-only, and deterministic. Do not dynamically add/remove tools mid-loop
  (mask actions instead). Treat the filesystem as unbounded, restorable context.
  Recite the plan into a `todo.md` to keep goals in the recent attention span.
  Keep failed actions and errors in context; erasing failure removes evidence.
  Avoid few-shot ruts by varying serialization and phrasing.
- Anthropic, "Effective context engineering for AI agents"
  (<https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents>):
  context rot is real; context is a finite attention budget. System prompts need
  the "right altitude" — specific enough to guide, not brittle if-else logic.
  Keep tools minimal and token-efficient. Compaction should maximize recall
  first, then precision; clearing stale tool results is the cheapest win.
  Structured note-taking (`NOTES.md`, memory tool) and subagents are the three
  long-horizon techniques. Design for just-in-time retrieval, not preloading
  everything.
- Cognition, "Don't Build Multi-Agents"
  (<https://cognition.ai/blog/dont-build-multi-agents>): share context and full
  traces; actions carry implicit decisions, and conflicting implicit decisions
  produce inconsistent work. The simplest reliable architecture is a
  single-threaded linear agent. Subagents should answer questions, not write
  code, unless the architecture can share context properly. A dedicated
  compression model is the alternative to naive multi-agent fan-out.
- Anthropic, "How we built our multi-agent research system"
  (<https://www.anthropic.com/engineering/multi-agent-research-system>):
  orchestration-worker pays off for breadth-first research, not most coding.
  Multi-agent uses roughly 15× the tokens of chat. Subagents return condensed
  1–2k token summaries; artifacts/filesystem outputs avoid the "telephone" game.
  Delegation prompts need objective, output format, tools/sources, and clear
  boundaries. Scale effort to query complexity; do not spawn many agents for a
  simple query.

### Established OpenCode plugins

- `opencode-working-memory`
  (<https://github.com/sdwolf4103/opencode-working-memory>): durable workspace
  memory plus hot session state; memory extraction piggybacks on compaction with
  zero extra API calls; frozen prompts at epoch boundaries; memory types
  (feedback, project, decision, reference), dedupe, credential redaction, and
  retention decay; read-only `/memory` TUI view.
- `opencode-mem` (<https://github.com/tickernelz/opencode-mem>): local vector
  memory with auto-capture, user profile learning, hygiene (dedupe,
  update-on-capture, consolidation), `<private>` tags and credential redaction.
  Its rule of thumb is the clearest statement of the split: lasting always-on
  project instructions → `AGENTS.md`; growing work context → memory; reusable
  on-demand procedures → skills.
- `opencode-dcp`
  (<https://github.com/Tarquinen/opencode-dynamic-context-pruning>):
  model-chosen compression at task boundaries rather than static whole-session
  compaction; range/message modes; nested summaries; protected tool outputs
  (subagents, skills, todo, plan); deduplication of repeated tool calls; purge
  errored tool inputs but keep the error; cache impact only when compression
  runs. This is the strongest argument for keeping memory/plan artifacts
  protected and compression deliberate.
- `opencode-orchestrator`
  (<https://github.com/agnusdei1207/opencode-orchestrator>): mission state in
  `.opencode/`, updates sent as a request-only user message after the
  conversation, explicitly preserving the system instructions and conversation
  prefix for provider prompt caching; secret redaction and a message-size guard.
- `oh-my-opencode-slim` (<https://github.com/alvinunreal/oh-my-opencode-slim>):
  orchestrator plus specialists with per-agent model and skill allow-lists. Its
  `deepwork` skill is the best "work like a painter" pattern: sketch → structure
  → detail passes, a ~40-line progress file, ranked known issues, review gates
  between passes, and a tombstone on completion.
- `pocock-agents` (<https://github.com/mcdays94/pocock-agents>): the discipline
  lives in skills (`grilling`, `to-spec`, `to-tickets`, `tdd`, `code-review`);
  the agents only supply the tool expectations (worktrees, parallel workers,
  permissions). It also documents OpenCode's last-match-wins permission rule and
  load-only-first `AGENTS.md`/`CLAUDE.md` behavior.
- `micode` (<https://github.com/vtemian/micode>): brainstorm → plan → implement,
  continuity ledgers, auto-compaction at 50%, context injection, token-aware
  tool truncation, and worktree isolation.

### Skills

- `anthropics/skills` and `skill-creator`
  (<https://github.com/anthropics/skills>): descriptions are the trigger
  mechanism; make them a little "pushy" because models undertrigger. Put all
  "when to use" information in the description, keep `SKILL.md` under ~500
  lines, move long references/scripts to sibling directories, prefer imperative
  instructions and explain why, and test triggering with realistic positive and
  near-miss negative queries.
- `opencode-skillful` (<https://github.com/zenobi-us/opencode-skillful>): lazy
  skill loading, `skill_find` / `skill_use` / `skill_resource`, per-model prompt
  formats, and script/resource discovery. Built-in OpenCode skills already do
  the important part (description advertised, body on demand), so a plugin is
  unnecessary here.
- Community pattern collections (for example `veschin/opencode-agents`,
  `wildwasser/opencode-agents`) converge on a research/plan/implement/review
  pipeline and an adversarial "truth-teller" review. We keep the independent
  review but reject the mandatory pipeline: it adds handoff and approval cost
  that the single-agent evidence does not justify for routine work.

### OpenCode 2.x plugin surface and field reports

- V2 splits the plugin surface into `prompt` (admission, redaction, attachment),
  `context` (runs before every agent-loop model call in a tool loop), and
  `compaction` (summary; `event.result` replaces the model call). The
  artifact registry uses exactly `context` + `compaction`, which is the
  supported seam for this behavior. The `prompt` hook is the right place if
  redaction or file attachment is ever needed
  (<https://opencode.ai/docs/build/plugins/server.md>).
- `ctx.session.instructions.entry` stores keyed state that renders as
  `<context key="...">` blocks in the session instructions without queuing a
  turn. It is the canonical place for mutable task facts, but it is visible in
  the TUI; we tried it for memory and rejected it because the memory then read
  like something the user or the harness had said in the conversation.
- `opencode-agent-memory` freezes a per-session memory snapshot so the injected
  block stays byte-stable for the provider prefix cache, and refreshes it on
  compaction. Our memory is appended at the end, so the stable prefix ahead of
  it is unaffected either way.
- Field reports converge on the same shape we chose: strong model for planning
  and review, bounded implementation, independent reviewer in a clean context,
  small context, and explicit on-disk handoff notes. Same-model review still
  finds real defects; the value comes from context separation, not model
  diversity.
- Nango's production run (200 API integrations) reports the failure modes that
  matter for trust: agents copying other agents' fixtures, editing tests when
  implementation failed, faking API responses, and claiming completion. The
  fixes are configuration-level — directory jail, edit permissions, fixture
  checks, and post-completion verification. This is why the review workflow says
  a review is not a substitute for running the thing
  (<https://nango.dev/blog/learned-building-200-api-integrations-with-opencode/>).

### Context rot, compaction, and caching research

- Chroma's _Context Rot_ measured 18 models degrading non-uniformly with input
  length even on trivial tasks; semantically similar distractors hurt most, and
  focused ~300-token prompts beat the ~113k-token full history on LongMemEval
  (<https://research.trychroma.com/context-rot>). Breunig's taxonomy —
  poisoning, distraction, confusion, clash — explains the mechanism
  (<https://www.dbreunig.com/2025/06/22/how-contexts-fail-and-how-to-fix-them.html>).
  A memory index of near-duplicate notes is itself a distractor, which is why
  stale entries are deleted rather than archived in place.
- ACE (_Agentic Context Engineering_, <https://arxiv.org/abs/2510.04618>) names
  the failure of repeated whole-context rewriting: brevity bias and context
  collapse. The fix is incremental delta updates to a durable playbook rather
  than regenerating the memory each time. Our memory tools support append/patch;
  full rewrites are for consolidation only.
- AgentFold (<https://arxiv.org/abs/2510.24699>) keeps multi-scale summaries
  plus a verbatim recent tail; ReSum (<https://arxiv.org/abs/2509.13313>) uses
  fixed token triggers because self-initiated compaction is unreliable. OpenCode
  already triggers compaction on token pressure, which is the right shape.
- LangChain's Deep Agents
  (<https://docs.langchain.com/oss/python/deepagents/context-engineering>)
  orders compression: offload large tool results to the filesystem and replace
  them with references first, summarize the residue second, and keep a canonical
  transcript on disk. Cheap and lossless before lossy.
- Anthropic context editing reports +29% on an internal agentic-search eval (and
  +39% with the memory tool) and an 84% token reduction on a 100-turn search
  eval; tool-result clearing invalidates the cached prefix, so clears are
  batched (`clear_at_least`) rather than done one result at a time
  (<https://www.anthropic.com/news/context-management>).
- Prompt caching order is `tools → system → messages`. Changing tool definitions
  invalidates everything; changing the system invalidates the messages. That is
  the precise cost of a mutable memory block in the system prompt: it is paid
  once per memory write, so writes are batched at milestones.
- Anthropic's long-running harness pattern: an initializer session writes a
  progress log and a machine-checkable feature list, later sessions read them
  first, and a feature is marked complete only after end-to-end verification
  (<https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents>).
  Our artifact registry plays that role.
- Cognition's follow-up keeps the original rule: writes stay single-threaded and
  extra agents contribute intelligence, not actions. The generator–verifier loop
  works because the reviewer does not share the writer's context
  (<https://cognition.com/blog/multi-agents-working>).

### Changes applied from this research

- Project memory is indexed on every primary request; session memory is
  appended to the compaction summary. Durable detail stays in the artifact
  sections and is loaded on demand.
- Memory is appended as an extra system part at the end of the instructions, not
  as a user message or a visible context entry. The stable prefix before it
  stays cacheable, and the memory never appears in the transcript. Each memory
  rewrite invalidates the cache from that point onward, so memory is updated at
  milestones rather than every turn.
- The artifact registry keeps plans/evidence/reviews as protected, durable
  references; subagents return artifact IDs, not long copied output.
- The `research-evidence` skill now scales effort to the question, starts broad
  then narrows, and labels source tier and confidence.
- The `planning` skill uses sketch → structure → detail passes for large work
  and keeps a ranked known-issues list.
- The `review-workflow` skill asks for the strongest counterargument, uses one
  independent review by default, and reserves consensus for high-stakes calls.
  Large changes get two parallel axes (spec/behavior and standards/regressions)
  that are never merged.
- (Superseded 2026-11-07.) A compaction addendum once carried an
  `## Errors and Fixes` section and asked for verbatim user wording. It was
  removed after review: session memory is the better carrier for requirements,
  the built-in prompt already reconciles newer history, and the addendum had no
  A/B evidence. Large tool output is still written to a file and referenced, not
  pasted into context.
- (Superseded 2026-11-07.) The system prompt once required a cold-start reload
  after every compaction. It now trusts the appended session memory and re-reads or
  verifies only when information is missing, contradictory, or may have changed.
- Memory is updated by append or patch; the whole document is rewritten only
  when consolidating, to avoid the brevity bias and context collapse that
  repeated whole-context rewriting produces.
- The custom diagram tool was removed after confirming OpenCode's built-in
  `opencode.merman` TUI renderer; only the `mermaid-diagrams` skill remains.

## Memory, planning, and compaction refinement (2026-11-07)

### What the installed OpenCode already does

Primary evidence: strings extracted from the OpenCode 2.2.6 binary
(`~/.local/share/mise/installs/npm-opencode-cli/2.2.6/node_modules/@opencode/cli/bin/opencode.exe`).

- The built-in compaction template already asks for Objective, Requirements,
  Decisions, Work State (Completed/Active/Blocked), Next Move, Relevant Files,
  and Important Context, with terse single-line bullets, exact paths and
  identifiers, unanswered user questions preserved, and workflow state
  (uncommitted/committed/pushed/reviewed) recorded. Its rules exclude
  instructions, AGENTS.md, and environment details because the next agent
  receives them separately.
- On later compactions it already gives newer history precedence over the
  existing summary and asks to reconcile Work State and Next Move, moving
  completed work out of Active and dropping resolved blockers.
- Built-in defaults are `keep: 15000` tokens and `precompute: false`.

Consequence: replacing that prompt with a near-copy was redundant, lost the
consolidation rules, and depended on English marker strings. An addendum was
tried next and later removed as well: it duplicated the built-in precedence
rule, added a provider-specific request rewrite, and had no A/B evidence that it
improved retention. Verbatim requirements now live in session memory,
which is recorded when they are given and appended to the compaction summary.
The built-in prompt is used unmodified.

### Project memory and session memory

- Memory is project-scoped, not session-scoped. The project root is the git
  common checkout: a normal checkout resolves to its toplevel, a linked worktree
  to the main checkout, a submodule to its own root, and a non-git directory to
  itself. Subdirectories therefore share one memory.
- Two documents: `memory` (project knowledge) and `session_memory` (session state).
  Both are live/published; session memory is the only progress log.
- Three index files keep lookup O(1): `project-memory-index.json`,
  `session-memory-index.json`, and the scan fallback that repairs stale entries.
- Discovery is plain text search (`artifact_search`) over the rendered body
  (no Prettier render) with a kind filter. Chroma's context-rot work and
  Anthropic's just-in-time retrieval both argue for retrieving only what is
  relevant; there is no evidence yet that this project needs embeddings, so it
  does not have them.
- Project memory is mutated by any primary session in the project (the writer
  restriction is dropped for this kind); session memory remains writer-owned.

### Injection and precedence

- The context block carries project memory as an index built from its structured
  JSON sections: a plain `Project memory` heading, bounded `Core` content, and
  every other section's title and short preview. Session memory is appended to
  the compaction summary, verbatim. Section bodies are loaded or searched on
  demand.
- The block is explicitly background, not authority: the newest user instruction
  and verified tool output override it. This matches Manus's "keep errors but
  not stale self-diagnosis" and the built-in consolidation rule.
- Nothing is injected into the compaction transcript. The next request reloads
  session memory and project memory, so copying them into the summarizer would
  only add a second, staler version.

### Planning and `/goal`

- `/goal <objective> | pause | resume | clear` is a built-in command: after each
  turn a judge reads the conversation and returns done/continue/blocked/paused;
  "blocked" is the verdict for needing a user decision.
- Formal planning is therefore opt-in: plan when the user asks, finalize, and
  stop with an explicit blocker ("waiting for approval of art_…") so the goal
  judge pauses instead of auto-continuing. Without an explicit request, plans
  never gate work, and progress lives in session memory rather than a second
  status log.
- A research-and-plan objective works under one goal: publish evidence, then the
  plan, then stop for approval.

### Compaction threshold

- `buffer` is the room kept free, not the trigger point: a 30% buffer compacts
  at ~70% of the window (~700k of 1M), and a 70% buffer would compact at ~30%
  (~300k). This setup uses `buffer: "30%"` and keeps 32k recent tokens, close to
  the committed 25% default and slightly earlier. The values are a policy
  choice, not a measured optimum; they are easy to revisit in `opencode.jsonc`.

### End-to-end compaction validation (2026-11-07)

These labs ran while the (now-removed) addendum was installed, so they validate
the threshold arithmetic and the loop failure, not stock summary quality. A
stock-versus-addendum A/B was never run; that gap is why the addendum was
removed.

Method: isolated project directories whose `opencode.jsonc` overrides
`provider.deepseek.models.deepseek-flash.limit.context` and sets small
`compaction.keep.tokens` / `buffer` values. Only the model window was
artificial; the plugin, hooks, built-in prompt, and compaction agent were the
real ones. Sessions were driven through the HTTP API and inspected with
`/api/experimental/session/<id>/export`, which stores each compaction's summary.

1. **Three manual, successive compactions** (32k window, keep 2k). Every summary
   kept the built-in sections and appended `## Errors and Fixes` (proving the
   now-removed addendum reached the provider). Short requirements were quoted
   verbatim (`"the deploy target is PROD-BETA"`, `"never retry a 4xx"`,
   `"batch writes in groups of 100"`). Corrections superseded rather than
   duplicated: `PROD-BETA` replaced `STAGING-ALPHA`, an async loader replaced a
   synchronous one, completed work moved out of Active, a resolved blocker
   disappeared, and the rejected parser rewrite stayed recorded. Claims not
   backed by tool output were marked "user-reported, unverified".
2. **Automatic compaction** (60k window, `buffer: "50%"`, keep 8k, background
   off). Three auto compactions over ten turns, each at ~28.9-29.0k tokens used
   (the 50% headroom), returning to ~21-25.8k afterwards. No loop. A blocker
   introduced between compactions 2 and 3 was captured by compaction 3, and all
   requirements survived every consolidation.
3. **Failure mode found** (32k window, `buffer: "60%"`, keep 2k). The fixed
   system prompt alone is ~10.5k tokens, so the post-compaction state (prompt +
   2k keep + summary = ~13-14k) was already past the 12.8k trigger. One turn
   compacted 38 times. This is a parameter-sanity rule, not a plugin bug: the
   trigger must leave room for the fixed prompt, `keep.tokens`, and a summary.
   The live config triggers at ~700k with a ~45k post-compaction state, so the
   same failure cannot occur there.

`buffer` is the headroom reserved before compacting: compaction starts when
`used > context * (1 - buffer)`. Both labs matched that arithmetic.

## Artifact model

- `memory` is shared project knowledge and `session_memory` is live session state;
  both are always published. Project memory is indexed on every primary request;
  session memory is appended to the compaction summary.
- `plan` is an optional working document; `plan_finalize` marks readiness for
  review, not permission to implement.
- `evidence` holds reusable research with self-contained findings.
- `review` holds an independent outcome and findings.
- User feedback can target a selected excerpt or line range; review is a marker
  plus a synthetic notification, never a gate.

The registry is filesystem-backed and independent of the agent roles, so the
same artifacts remain viewable in Neovim and readable by any future client.

## Tool consolidation and memory distribution (2026-11-08)

- The artifact tool surface dropped from 36 to 21 tools. Each namespace now has
  one update verb: `memory_init/update/load`;
  `plan_create/update/complete/finalize/load`;
  `evidence_create/update/finding/finalize/load/summary`;
  `review_create/update/finding/finalize/load/summary`; plus
  `artifact_search`.
- `memory_update` takes an explicit `mode`: `append`, `patch`, or `replace`.
  `memory_init` is get-or-create and returns the ID; `memory_load` reads. The
  previous `open`/`append`/`patch`/`put`/`summary` split was ambiguous about
  whether `open` read the body.
- `plan_update` is one atomic store write covering whole fields, the ordered
  `evidenceIDs` membership, and an optional exact patch. A plan no longer needs
  one call per field, and the planning skill matches the implemented schema.
- `plan_complete` records the outcome summary, changed files, verification, and
  unfinished work in the plan, then freezes it. Completion preserves status,
  readiness, and approval but rejects later content mutations. A follow-up plan
  can point at the completed plan with `previousPlanID`.
- Memory injection checks the agent's `primary` mode via `ctx.agent.get`
  instead of comparing the agent name to `system`. Memory and session memory store
  structured `sections` with unique titles; the project-memory index lists each
  title and preview, and `memory_load` can load one section by title. The
  session memory is appended to the compaction summary, not injected on every
  request; it is appended verbatim.
- `search` and `review` permissions start with a `* deny` gate, and `search`
  denies `write`. The read-only contract is structural, not prompt-only.
