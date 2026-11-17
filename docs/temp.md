Can you research the simplest ways to benefit from subagents but not over
orchestrate?

my current approach is a single agent planner+implementer that can use subagents
for research, but:

1. it doesn't use those subagents enough
2. I have seen people using even simpler setups than me that just use a
   orchestrator like claude opus 5.5 and an implementer subagent like deepseek
   flash 1017, and having better results than me

how do I do better? I know the model itself if like 95%+ of the magic, I feel
like I keep making it harder on my agents

\~/.config/opencode is my config.

should I do away with my artifacts and just have subagents report directly, or
do you think my idea is good?

I am wondering if instead of artifacts I just make use of the already available
opencode database and expand on the past conversations skill?

idk yet.

---

research online about subagent anti-patterns, and reference real professionals
like the opencode team or the cursor/x-ai team or the claude team

---

**I’d keep one primary agent, make delegation easier, and make artifacts
optional.** Your overall idea is sound. Some of your rules, however, make
delegation costly or explicitly prevent the setup you’re comparing yourself
against.

I inspected your config and researched primary sources from Anthropic, Cursor,
OpenCode, and xAI. I haven’t changed anything.

The strongest professional evidence points to these anti-patterns:

| Anti-pattern                                        | What the teams actually report                                                                                                                                                                                                                                                                            | Practical implication                                                              |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| **Splitting closely related phases between agents** | Anthropic describes planner → implementer → tester arrangements losing context and sometimes spending more tokens coordinating than working. They recommend splitting along context boundaries. [Anthropic](https://claude.com/resources/articles/building-multi-agent-systems-when-and-how-to-use-them)  | A worker should usually investigate, implement, and test its assigned change.      |
| **Building an agent for every category of work**    | Anthropic’s Applied AI team reports deployments where folding planners, routers, and specialists into one agent with skills improved quality, cost, and latency. [Diane Sarkis, October 2026](https://claude.com/resources/articles/building-agents-when-to-fold-subagents-into-your-main-agent-loop)     | Create another agent when a separate context or permission boundary helps.         |
| **Too much coordination infrastructure**            | Cursor’s experiments encountered lock bottlenecks and agents avoiding hard work. They later removed an integrator role because it created more bottlenecks than it solved. These were large-scale experiments, not ordinary coding sessions. [Wilson Lin, Cursor](https://cursor.com/blog/scaling-agents) | Keep one clear owner of the outcome; avoid adding coordination roles preemptively. |
| **Vague delegation and excessive fan-out**          | Anthropic observed duplicate searches, agents continuing after finding enough evidence, and excessive updates. Clear objectives, boundaries, output requirements, and stopping conditions helped. [Anthropic Research engineering team](https://www.anthropic.com/research/multi-agent-research-system)   | Improve the assignment before increasing the number of agents.                     |
| **Delegating tiny tasks**                           | Cursor recommends skills for simple, repeatable actions. Its built-in exploration and browser subagents primarily isolate noisy intermediate output. [Cursor docs](https://cursor.com/docs/subagents)                                                                                                     | Delegate substantial exploration; keep a known-file lookup local.                  |

xAI’s workflow guidance follows a similar boundary: work that divides into many
independent pieces and ends in one report, such as issue triage or broad audits.
That’s product guidance, rather than a comparative study of architectures.
[xAI](https://x.ai/news/workflows)

**What stands out in your configuration**

1. **Implementation delegation is prohibited.** Your primary prompt says “do not
   hand implementation to another agent,” repeats that implementation stays in
   the primary session, and your built-in `general` agent is disabled. Your
   agent is following the architecture you gave it.

2. **Research has substantial overhead.** The primary chooses among `find`,
   `survey`, and `research`. Research then creates an artifact, records
   findings, finalizes it, returns only an ID, and requires the parent to fetch
   the answer. That can be worthwhile for a report, but it increases the cost of
   asking a colleague a question.

3. **Some output instructions conflict.** Your research prompt asks it to lead
   with its finding, then requires its final message to contain exactly an
   artifact ID. It also forbids recommendations. That leaves more interpretation
   and synthesis with the primary.

4. **Some tool guidance has aged.** Your prompt specifies `background: true` and
   foreground calls. Current OpenCode documentation says subagents always run in
   the background and are continued using their `sessionID`. Confirm the
   installed version before updating that wording.
   [OpenCode tools](https://opencode.ai/docs/tools/)

These are reasons to test simplification. They don’t prove that artifacts caused
your disappointing results; I haven’t evaluated your task outcomes.

**The smallest setup I’d try**

Keep the primary responsible for understanding your intent, choosing an
approach, integrating changes, and verifying the result. Then:

- Collapse `find`, `survey`, and `research` into one read-only **explore**
  agent. Specify depth in the assignment.
- Enable one general **worker** that can investigate, implement, and test a
  bounded change.
- Keep **review** available for consequential changes or explicit review
  requests.
- Keep your nesting depth of one.
- Give every agent a useful direct return message.

I would initially keep the primary’s editing ability. A write-disabled
orchestrator forces delegation, but also makes trivial changes require a
handoff. Treat that architecture as an experiment if cheap-worker economics
matter to you.

A delegation policy can be short:

```text
Delegate broad exploration whose intermediate output would crowd this
conversation, independent work that can run alongside the current task,
and bounded implementation work with clear acceptance criteria.

Keep tightly coupled work and quick targeted changes in this session.

Give each child the goal, relevant context and paths, constraints,
acceptance criteria, and stopping condition. Let an implementation worker
investigate, edit, and test its complete assignment.

Continue the same child for follow-ups. Avoid duplicating its investigation.

Children return a concise result, supporting references or changed files,
checks performed, and unresolved uncertainty. Save larger deliverables
when useful; include a short summary and their location.
```

Those are my proposed defaults, not a quoted team prescription. OpenCode already
provides background execution and resumable child sessions, so you can use those
capabilities without building another orchestration layer.
[OpenCode](https://opencode.ai/docs/tools/)

**On artifacts: keep the capability, remove the obligation**

Your artifact idea has professional support. Anthropic explicitly recommends
storing large subagent outputs externally and returning references to preserve
fidelity and avoid copying large deliverables through the coordinator.
[Anthropic](https://www.anthropic.com/research/multi-agent-research-system)

I would use this division:

| Information                                                                    | Default home                   |
| ------------------------------------------------------------------------------ | ------------------------------ |
| Child’s conclusion, actionable findings, uncertainty                           | Direct return message          |
| Large research report, comparison, or something you want to annotate in Neovim | Artifact                       |
| Project decision or knowledge future contributors need                         | Repository documentation       |
| Earlier discussion and investigation trail                                     | OpenCode conversation history  |
| State needed to resume substantial unfinished work                             | One short working note or plan |

**Always return enough information for the parent to act.** An artifact
reference can accompany that answer. This preserves your Neovim review workflow
while removing artifact management from routine delegation.

Your writer-owned records also create a real coordination cost: corrections
require resuming the original author. That ownership may be valuable for
provenance, but I would reserve it for deliverables where provenance matters.

**On expanding past conversations: yes, narrowly**

I inspected the database schema read-only. It already contains parent-child
relationships, agent/model metadata, messages, parts, and usage fields. That
supports your idea of using existing history rather than recording every
investigation twice.

Your current skill only permits recall when you explicitly ask. I’d expand it to
allow targeted retrieval when:

- Continuing earlier work.
- Looking up a previous decision.
- Inspecting a child’s detailed evidence after its summary proves insufficient.

Keep project/session scoping and bounded snippets. Historical conclusions also
need checking against current code when relevant.

The database can preserve the investigation trail. A short maintained note still
earns its place when you need an authoritative statement of the current
decision. Otherwise, future agents must reconstruct that decision from
discussion, abandoned approaches, and corrections.

**How I’d determine whether this actually helps**

Separate model choice from architecture. Your configured primary is DeepSeek
Flash, so comparing it with an Opus-primary setup changes both variables.

Use a small set of representative tasks:

1. With the same primary model, compare your current workflow against direct
   child reports and optional artifacts.
2. Then compare a stronger primary working directly against that same primary
   using a cheaper worker.

Track successful completion, your interventions, elapsed time, cost, and rework.
Treat delegation frequency as diagnostic information.

Cursor describes evaluating harness changes against both measured results and
real usage, and tuning behavior for particular models. That is better evidence
than a universal “95% model” allocation.
[Stefan Heule and Jediah Katz, Cursor](https://cursor.com/blog/continually-improving-agent-harness)

My first change would be **concise direct child reports, optional artifacts, and
permission to delegate bounded implementation**. That tests the main sources of
friction without requiring a new orchestration system.

---

should the work subagent also be allowed to use the explore subagent, or when
its bounded like that it should use its own research, implementation, and
testing?

and what is explore and general/worker became the same agent?

just a general subagent to do all types of things as deepseek flash 1017 and the
main system agent is the frontier model like opus or astra?

also opus/astra can still make changes themselves if a worker returns and it
doesn't look the best UI wise or something since deepseek is good at large text
changes and other models are good at UI or higher level design?

---

**Yes—a strong primary plus one general-purpose DeepSeek worker is the setup I’d
test first.** The primary keeps full editing ability.

The worker can research, implement, and test its entire assignment. “Bounded”
means a clear outcome and scope, not that the parent must prescribe every edit.
For example:

> Implement CSV export for the results table. Find the relevant code, follow
> existing conventions, and run appropriate checks. Preserve the current
> filtering behavior. Return changed files, verification results, and unresolved
> concerns.

That keeps the context needed for implementation and testing together.

**I’d initially prevent workers from spawning other agents.** Let the worker
conduct its own exploration. Otherwise, one delegation introduces another
context handoff, another summary, and more coordination.

Nested exploration becomes useful when a worker discovers a substantial,
separable question—such as investigating an unfamiliar dependency while it
continues implementing against a known interface. Add that capability when you
repeatedly encounter that situation. Your current depth limit of one is a
reasonable starting point.

**Explore and worker can be the same agent.** The assignment determines what it
does:

- “Investigate this behavior; return evidence; leave files unchanged.”
- “Implement this change and verify it.”
- “Review this diff for these failure cases.”

The main reason to retain a separate explorer is an enforced read-only
permission boundary or materially different tools. A general worker told to
remain read-only has a behavioral instruction; a read-only explorer has a tool
restriction. If you don’t need that distinction, combining them removes a
routing decision.

**And yes, the primary should freely make changes itself—including UI refinement
after a worker returns.** Delegation assigns responsibility for an outcome; it
doesn’t give the worker exclusive ownership of every subsequent edit.

A useful division could be:

| Primary: Opus/Astra                               | Worker: DeepSeek                                        |
| ------------------------------------------------- | ------------------------------------------------------- |
| Understand your intent and resolve ambiguity      | Investigate a bounded question                          |
| Make architectural and visual design decisions    | Implement a defined change                              |
| Handle tightly coupled or difficult work directly | Perform repetitive migrations or broad mechanical edits |
| Inspect results and refine the final experience   | Run checks and report failures                          |

Treat those model assignments as hypotheses about your workload. The worker can
handle design when it performs well; the primary can handle mechanical changes
when delegation would take longer.

For your UI example: the worker builds the functionality and initial layout,
then the primary inspects the rendered result and adjusts spacing, hierarchy,
interaction, or styling directly. If the result needs substantial rework, the
primary can instead resume that same worker with concrete feedback.

The practical constraint is **one active editor per overlapping area**. Once the
worker returns, the primary can take over. If you resume the worker after making
changes, tell it what changed so it works from the current state.

I’d express the architecture simply:

> The primary owns the outcome and may work directly or delegate. A worker
> completes a bounded assignment through investigation, implementation, and
> verification. The primary inspects the result and may refine it directly.
> Workers report concisely; artifacts are optional.
