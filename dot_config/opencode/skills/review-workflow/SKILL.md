---
name: Review workflow
description: Get an independent correctness review of a change, artifact, or design and act on the findings. Use this skill whenever the user asks for a review, audit, second opinion, or sanity check, or when a change is large, security-sensitive, hard to reverse, or touches data/concurrency. Triggers: review, audit, check, verify correctness, validate, regression, risky change, second opinion, security. Do not use for a trivial local edit.
---

# Review workflow

A review is an independent inspection with clean context. Use it when a defect
would be costly and the author may be blind to it.

## When to review

Review:

- a large or cross-cutting change
- security, data-loss, migration, or concurrency risk
- a change the author cannot exercise end to end
- when the user asks for a review or a second opinion

Skip it for a small, localized, low-risk edit. Do not launch a review just to
produce a document.

## Launch the reviewer

Use the `review` subagent in the background with a self-contained prompt:

```text
Concern: <the specific correctness question>.
Working directory: <absolute path>.
Scope: <files or behavior the change touches>.
Artifacts: <plan/evidence IDs, if any>.
Already checked: <checks the author ran; do not repeat unless code changed>.
Do not write files; run read-only checks if needed.
```

Give the reviewer the concern and the scope; let it reach its own conclusion. It
loads the artifacts by ID itself. Ask for the strongest failure case or
counterargument. Run the thing as well.

One independent review is the default. A consensus of several reviewers or
models is reserved for a high-stakes, hard-to-reverse decision; most of what any
single reviewer says is noise, and agreement across independent contexts is the
signal worth paying for.

For a large, risky change, split the review into two independent axes and run
them as two parallel review subagents:

- **Spec / behavior** — does it implement the intended behavior and satisfy the
  requirements?
- **Standards / regressions** — does it fit the repository's conventions and
  avoid adjacent breakage?

Keep the axes separate. A change can pass one and fail the other, and combining
them hides that. Cap each review at a short, actionable summary.

## Read the result

The reviewer returns a bare `art_…` review ID. It may create the review early
with `review_create` (optional `outcome`/`summary`), add findings as it
inspects, and finish with `review_finalize` (optional final
`outcome`/`summary`). Use `tools.review["summary"]({ artifactID })` for the
outcome and human Summary. Load the full review only when you need the findings
to act.

- **Pass** — record the result and continue.
- **Changes required** — apply the correction in scope, rerun the focused check,
  and update the progress note; change the plan when scope or criteria change.
  If the correction expands scope, stop and put the decision to the user.
- **Blocked** — obtain the missing fact or tell the user what is missing.

Do not argue with a finding without evidence. If you disagree, state the
evidence and re-check the specific claim. Do not relaunch the same review in a
loop; if it repeats, report the blocker.

## User feedback

If the user comments on a review artifact, read it by ID and answer the specific
point. The review is writer-owned by the review subagent: resume that subagent
with the feedback so it updates and re-finalizes the review, then reload it. Do
not rewrite the review from the primary session or restart the review from
scratch.
