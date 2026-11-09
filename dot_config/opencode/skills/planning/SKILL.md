---
name: Planning
description: Create and keep a working plan for a feature or investigation so the goal, decisions, checks, and evidence stay in one place. Use at the start of a feature, a multi-stage refactor, or a research-and-plan session, and to guide implementation. Triggers: plan, design, scope, feature, approach, refactor, investigation.
---

# Planning

A plan is the in-session working document for a feature or investigation. It
holds the goal, intended changes, decisions, checks, and links to evidence.
Implementation proceeds from it.

## When to plan

Create a plan when:

- the user describes a feature, refactor, or investigation with a concrete goal
- the work has several stages, or choices that need recording
- research must be organized against a goal

A one-line fix or a small edit proceeds directly. A multi-file change benefits
from a short plan as the place to record decisions and evidence.

## Workflow

1. Read the project `AGENTS.md` and use `artifact_search` for existing evidence
   or plans before re-deriving anything.
2. `tools.plan["create"]({ title, description, workingDirectory, goalScope?, intendedChanges?, context?, checks?, previousPlanID? })`
   — returns the plan ID. Put the goal and major stages in the create call when
   you know them; link the plan this one continues or supersedes with
   `previousPlanID`.
3. Ask the user about choices you cannot make; fill the rest yourself. Record
   each decision in the plan as it is made.
4. `tools.plan["update"]({ artifactID, goalScope?, intendedChanges?, context?, checks?, evidenceIDs?, patch? })`
   — replace fields that change, attach published evidence with `evidenceIDs`,
   or patch one exact occurrence.
5. Implement. The plan guides the work; it does not gate it.
6. When the work lands, record the outcome with `plan_complete`.

## What belongs in a plan

A plan records direction; execution details belong in the work:

- scope and the outcome it achieves
- important tradeoffs and why one was chosen
- success criteria: how the user can tell it worked
- major stages, in order, with the state each one leaves behind
- evidence links that support a decision

Do not write file-by-file edit instructions, code, line anchors, or a full task
breakdown before the work is understood. Those belong in the work itself.

## Evidence

Load `research-evidence` for source work, comparisons, or broad reading. Create
the evidence artifact as you learn, then attach it with `evidenceIDs`. The plan
carries the goal and the decision; the evidence carries the detail. Knowledge
the repository should keep belongs in a repository note; the evidence artifact
is the session record.

## Continuing an unfinished plan

Plans are writer-owned: only the writer session can update or complete a plan. A
new session reads an unfinished plan and starts a successor with
`previousPlanID` pointing at the unfinished plan.

## Shape

```markdown
# Goal / Scope

## Intended Changes and Behaviors

- Outcome: what becomes true for the user.
- Stage 1: the state it leaves behind.
- Stage 2: the state it leaves behind.

## Context

- Tradeoff considered, chosen option, and why.
- Constraint that shapes the approach.

### Evidence

- Description (art_…).

## Checks

- Observable success criterion.
```

## Completion

When significant work is done, record the outcome in the plan:

1. `tools.plan["complete"]({ artifactID, summary, changed?, verification?, unfinished? })`
   — `summary` is required; `verification` lists the checks actually run. The
   plan freezes after completion.
2. `tools.plan["load"]({ artifactID })` reads the completed record.
3. A later change starts a new plan with `previousPlanID` pointing at the
   completed plan. The completed plan stays frozen.

Completion records the outcome. Use it when the work is significant enough to
revisit; a small edit does not need one.

## Failure modes

- Planning a one-line fix.
- Writing the plan as a file-by-file task list before the work is understood.
- Leaving decisions in the transcript instead of the plan.
- Expanding scope while leaving the plan stale.
