---
name: Research and evidence
description: Research source code, documentation, or external sources and publish reusable evidence artifacts. Use this skill whenever the user asks to research, investigate, compare, verify, cite, survey, or find out what the docs/source actually say, or when several independent questions can run in parallel. Triggers: research, investigate, sources, docs, compare, evidence, citations, survey, fact-check, verify, deeply explore. Do not use for a single fact you can answer with one read.
---

# Research and evidence

Research serves a decision or an edit. Keep the question narrow, cite the source
of each fact, and publish only what will be reused.

Create an evidence artifact as you learn, from the primary session or from
`search`. Attach it to the plan with `evidenceIDs`: the plan carries the goal
and the decision, the evidence carries the detail. The evidence artifact is the
session record. Knowledge the repository should keep belongs in a repository
note.

## Choose the mode

Do the research yourself when it is one focused read, a single grep, or a
question you can answer in a few tool calls.

Delegate to the `search` subagent when:

- the question needs many files or broad external documentation
- the output would flood this context and only a compact answer is useful
- several independent questions can run in parallel

Give Search a self-contained prompt: the question, known paths or sources, the
expected output format, the constraints, what the answer will decide, and an
explicit stopping condition. Launch it in the background and keep working. Treat
its output as evidence, not as a decision. Do not delegate a design choice.

Scale the effort to the question. One focused read or grep is enough for a
simple fact. A broad or multi-file question gets one Search agent. Three to five
parallel Search agents are justified only for independent subquestions with
disjoint sources; do not fan out a small question, and do not duplicate a search
another agent is already doing.

Start broad, then narrow. Find the landscape and the primary sources first, then
drill into the specific claim. Prefer primary material over summaries: source
code, official docs, specs, and release notes before blog posts, and blog posts
before forum threads.

## Read the result

Search returns a bare `art_…` evidence artifact ID. Use:

- `tools.evidence["summary"]({ artifactID })` for the question, Summary, and
  Limitations
- `tools.evidence["load"]({ artifactID })` when you need the full findings

A one-fact answer may come back inline with no artifact. That is fine; do not
create evidence for it.

## Author evidence incrementally

When the findings will be reused:

1. `tools.evidence["create"]({ title, description, question?, summary?, limitations? })`
   — create early; pass what you already know. Returns the bare ID.
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

Label the source tier and confidence:

- **Primary** — source code, official documentation, specs, release notes,
  reproducible commands or benchmarks. High confidence.
- **Secondary** — maintained project docs, engineering blogs, issue threads,
  author posts. Medium confidence; check whether it matches the current version.
- **Community** — Reddit, Hacker News, forums, unverified summaries. Low
  confidence; useful for leads and failure reports, not as the only support for
  a load-bearing claim.

Cross-check key claims against a second source when the decision is expensive.
When sources conflict, say which one you trust and why.

## Stop

Stop when the assigned question is answered and its support is recorded. Do not
turn research into an inventory, a history, a redesign, or a validation project.
If a source conflicts with another, say which one you trust and why. If a needed
fact is unavailable, state the gap.
