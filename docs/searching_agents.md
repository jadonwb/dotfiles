# Search optimization

## Prompt

My opencode config at \~/.config/opencode has been really shaping up recently
and its working pretty well.

If I were to maybe remove pdf exploration from my main system agent, and move it
into my search subagent, to save context and improve result finding, should I
keep search as a general research/find agent, or should I split off into:

find - only looks for references and locations, returns a quick answer explore -
looks for various things, tries to do a broad search of different options and
references research - drills into detail, comes up with implementation level
detail and/or finds evidence in documents and comes up with conclusions

each would all have the same set of tools, but different reasoning efforts /
thinking levels and different instructions

thoughts?

## Response

**I’d use the three profiles you described, with clear differences in their
deliverables and stopping conditions.** Moving substantial PDF reading into them
makes sense for keeping the main agent’s context useful.

Looking at your setup, your current `search` is already a mixture: low reasoning
effort, instructions favoring narrowly targeted searches, and an
evidence-artifact workflow for deeper research. Splitting those responsibilities
would let each behave more consistently.

I’d define them like this:

| Agent        | Job                                                             | Returns                                                                          | Starting effort |
| ------------ | --------------------------------------------------------------- | -------------------------------------------------------------------------------- | --------------- |
| **find**     | Locate a specific fact, reference, symbol, document, or passage | Answer, exact location, minimal supporting context                               | Low             |
| **explore**  | Map an unfamiliar area or discover plausible approaches         | Relevant options, how they differ, key references, gaps                          | Medium          |
| **research** | Resolve a substantive question using evidence                   | Supported conclusions, implementation details, conflicting evidence, limitations | High            |

Those effort levels are starting points to tune against actual results. **The
instructions and output contracts matter more than the effort setting.**

For example, against the same collection of PDFs:

- **find:** “Where is the maximum operating temperature specified?”
- **explore:** “Which cooling approaches do these documents discuss, and which
  deserve investigation?”
- **research:** “Can this assembly operate at 85°C continuously? Reconcile the
  ratings, exceptions, and test conditions.”

The distinction is the question being answered. All three can reasonably have
the same tools.

A few things would make this work well in your setup:

**Give each a concrete stopping condition.** Find stops once it has located and
checked the requested reference. Explore stops once it has a useful map of the
relevant options and their sources. Research stops once it can answer the
question with support, or identify the specific evidence that prevents a
conclusion. “Explore various things” alone leaves too much room for wandering.

**Route directly to the appropriate agent.** Avoid making
`find → explore → research` a standard pipeline. That would repeatedly rebuild
context. The main agent should choose the profile from the task, and resume an
existing child when continuing the same investigation. A single obvious grep can
still stay in the main session.

**Keep conclusions within research’s remit.** Your current search prompt
explicitly excludes design choices and recommendations from evidence. I’d let
research produce evidence-backed conclusions and conditional recommendations,
while distinguishing them from source facts. The main agent then integrates
those findings with the user’s goals and makes the implementation decision.

**Scale artifact use with the work.** Find should usually return inline. Explore
can return a compact map, with an artifact when worth preserving. Research fits
your incremental evidence workflow. The parent should read the artifact summary
first and retrieve individual findings as needed; loading every full artifact
would erode the context benefit.

For PDFs specifically, have the child return **document identity, page
references, findings, and material extraction uncertainty**. Let it handle
searching, rendering, tables, and figures internally. That isolates the bulky
investigation while keeping its conclusions traceable.

The clearest context saving comes from keeping those intermediate results out of
the parent. Whether restricting PDF tools also saves tool-definition tokens
depends on how your runtime exposes them.

OpenCode supports separate prompts, model variants, and fresh child contexts for
these profiles; their descriptions are also shown to the agent choosing whom to
launch, so make those descriptions precise.
[OpenCode agent documentation](https://opencode.ai/docs/agents/)

My recommendation: **three small, distinct profiles sharing one research
toolkit**, with the main agent retaining implementation and overall
decision-making.
