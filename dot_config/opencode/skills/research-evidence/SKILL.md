---
name: Research and evidence
description: Route research work and consume its results — answer in-session, or delegate to find, survey, or research, then read evidence by summary first. Triggers: research, find, verify, check, locate, investigate, compare, survey, cite, evidence, fact-check, several independent questions.
---

# Research and evidence

Research serves a decision or an edit. Keep the question narrow, and publish
only what will be reused.

## Choose the route

| Route      | Question shape                                             | Deliverable                                             |
| ---------- | ---------------------------------------------------------- | ------------------------------------------------------- |
| yourself   | one focused read, one grep, a few tool calls               | the answer, in session                                  |
| `find`     | one specific fact, reference, symbol, document, or passage | the fact with its exact location, inline                |
| `survey`   | an unfamiliar area, or the options that exist              | a compact map of options, sources, and gaps             |
| `research` | a substantive question needing support                     | conclusions with conflicts and limitations, as evidence |

The route follows the question. Do not run `find → survey → research` as a
pipeline; each rebuilds context from nothing. Resume the same child when
continuing one investigation.

Fan out three to five children only for disjoint independent subquestions. Do
not fan out a small question, and do not duplicate work another child is already
doing.

## Write the child prompt

A child starts cold. Give it: the question, the known paths or sources, the axis
that matters, what the answer will decide, the output contract you expect, an
explicit stopping condition, and the constraints. When the user dictated the
subagent task, copy their words verbatim before adding your own context.

Launch independent children in the background and keep working; wait only when a
fact blocks the next step.

Treat a child's output as evidence. Choosing a design or a direction stays in
this session.

## Consume the result

`find` answers inline. A one-fact answer does not need an artifact; its does not
create evidence for it.

`survey` returns its map inline, or a summary plus a bare `art_…` ID when the
map is large enough to revisit.

`research` returns a bare `art_…` ID. Read it with
`tools.evidence["summary"]({ artifactID })` for the question, Summary, and
Limitations; call `tools.evidence["load"]({ artifactID })` only when you need a
specific finding. Loading every artifact erases the context saving that
justified the delegation.

Attach reusable evidence to the plan with `evidenceIDs`: the plan carries the
goal and the decision, the evidence carries the detail.

A child's artifact belongs to that child. Do not edit it from this session; the
store only accepts mutations from the writer session, so resume the child with
the feedback and read the updated result.

When the repository should keep the knowledge, write a repository note beside
the code or in a directory such as `notes/` or `docs/`. Evidence artifacts are
in-session records, not project documentation.

## Author evidence in-session

When you do the work yourself and the findings will be reused:

1. `tools.evidence["create"]({ title, description, question?, summary?, limitations? })`
   — create early; pass what you already know.
2. `tools.evidence["finding"]({ artifactID, title, content })` — add each
   confirmed finding as you learn it. Use the returned `fin_…` ID to replace it
   later; do not duplicate it.
3. `tools.evidence["update"]({ artifactID, question, summary, limitations })` —
   update the overview if it changes.
4. `tools.evidence["finalize"]({ artifactID, summary?, limitations? })` —
   optionally set the final overview and publish.

Each finding must stand alone: the fact, its context, and its source. Put exact
code, excerpts, paths, symbols, versions, and URLs beside the claim. Separate
documented facts, inspected code, and inference. Add material uncertainty to
Limitations.

## Stop

Stop when the assigned question is answered and its support is recorded. Do not
turn research into an inventory, a history, a redesign, or a validation project.
When sources conflict, say which one you trust and why. When a needed fact is
unavailable, state the gap.
