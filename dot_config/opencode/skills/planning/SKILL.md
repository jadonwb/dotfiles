---
name: Planning
description: Produce a reviewable plan when the user explicitly asks to plan, design, scope, or sequence a change, and wait for their approval before implementing. Formal planning is optional otherwise; do not plan merely because a change touches several files. Triggers: plan, design, roadmap, migration, refactor, approach, scope, proposal. Do not use for a one-line fix, typo, routine command, or an obvious change.
---

# Planning

Formal planning is opt-in. Routine multi-file work does not need a plan
document, a plan gate, or a ceremony. When the user asks for a plan, they are
asking for a reviewable decision record and for a say before implementation
starts.

## When to plan

Plan when:

- the user explicitly asks for a plan, approach, design, or roadmap
- a decision is expensive to reverse and the user wants to review the scope
- several sessions need a durable record of intent

Otherwise, act. A short plan artifact as a reference is fine, but
do not turn every change into one, and never let a plan delay a change the user
asked for.

## Approval

- **The user asked for a plan** — create and finalize it, then stop and ask for
  approval before implementing. Wait for a real answer; do not implement "while
  they review".
- **The user did not ask** — implement directly. A plan may be created and
  updated as background if it helps, but it does not gate the work.

If a goal is active, end the approval turn with an explicit blocker such as
"Waiting for your approval of plan art_…". The goal judge treats that as blocked;
the work resumes when the user answers.

## What belongs in a plan

A plan records direction; execution details belong in the work:

- scope and the outcome it achieves
- important tradeoffs and why one was chosen
- success criteria: how the user can tell it worked
- major stages, in order, with the state each one leaves behind

Do not write file-by-file edit instructions, code, line anchors, or a full task
breakdown before the work is understood. Those belong in the work itself. If a
stage needs its own design pass, do that pass when you reach it.

## Keep one progress record

For a multi-phase task, keep progress in the plan when one exists; otherwise
keep one short repository note (`docs/`, `notes/`, or a file next to the work).
Record:

- objective and current requirements
- decisions made
- what is done, active, and blocked
- the next move

The plan's scope and criteria change only when scope or criteria change. Its
progress section tracks done, active, blocked, and next. Keep one version of the
same state.

## Workflow

1. Read the project `AGENTS.md` and use `artifact_search` for existing evidence or
   plans before re-deriving anything.
2. `tools.plan["create"]({ title, description, workingDirectory, goalScope?,
   intendedChanges?, context?, checks?, previousPlanID? })` — returns the bare
   plan ID. Put the outcome and major stages in the create call when you already
   know them; link a completed predecessor with `previousPlanID`.
3. `tools.plan["update"]({ artifactID, goalScope?, intendedChanges?, context?,
   checks?, evidenceIDs?, patch? })` — replace any fields that change, attach
   published evidence with `evidenceIDs`, or use `patch` for one exact
   occurrence.
4. `tools.plan["finalize"]({ artifactID })` — ready for review.
5. If the user asked for planning: report the plan ID and ask for approval, then
   stop. Otherwise implement, updating the plan or note as you go. When the
   significant work is done, record the outcome with `plan_complete`.

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

## Completion and review

`approve_plan` in Neovim records the user's review. When the user asked for a
plan, approval is the signal to start. When they did not, approval is a review
marker; implementation continues.

When significant work is done, record the outcome in the plan:

1. `tools.plan["complete"]({ artifactID, summary, changed?, verification?, unfinished? })`
   — `summary` is required; `verification` is the checks actually run. The
   plan is frozen after completion and preserves its approval marker.
2. `tools.plan["load"]({ artifactID })` reads the completed record.
3. A later change starts a new plan with `previousPlanID` pointing at the
   completed plan. Do not reopen or edit the completed plan.

Completion records the outcome. Do not complete a plan
for every small edit; use it when the work is significant enough to review or
revisit.

## Research-and-plan sessions

A deeper session can combine research and planning under one goal: research,
publish evidence, then produce the plan and stop for approval. Keep the research
in evidence artifacts and the decision in the plan; state each finding once.

## Failure modes to avoid

- Planning because the change touches several files.
- Implementing before the approval you were asked to wait for.
- Turning the plan into a file-by-file task list before the work is understood.
- Keeping progress in both the plan and a separate note.
- Expanding scope while leaving the plan stale.
