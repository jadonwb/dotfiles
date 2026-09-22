# plan-bridge

A filesystem-backed registry for passing structured artifacts between OpenCode
sessions and Neovim, and the authoritative plan-approval gate. A plan approval
whose synthetic notification names `kind=plan`, `status=approved`,
`finalized=true` is what authorizes Builder.

## Artifacts

Every artifact is one structured record plus one generated read-only view,
addressed by ID only:

- `id` — the `art_…` identifier.
- `kind` — `plan`, `evidence`, `review`, or `report`.
- `title` / `description` / `primaryAuthor` — short human-facing labels,
  immutable once created. `primaryAuthor` is frontend metadata derived from the
  creating agent's name; owner/writer session identities stay internal routing
  data and never enter the rendered frontmatter.
- `status` — lifecycle is kind-specific. Plans start `draft` and become
  `approved` when the user approves a finalized draft (an approval is the
  Builder gate and freezes the complete flat record). Evidence, reviews, and
  reports start `draft`, are finalized to `published`, and become `read` when
  the user dismisses them with Mark read; a content edit returns them to
  `draft` until they are finalized again.
- `finalized` — the readiness flag. Every content mutation clears it;
  `plan_finalize` validates the flat prose fields (making the draft
  approvable), while evidence/review/report finalization validates useful
  content and publishes the draft. Incomplete plans are visible but cannot
  expose approval actions, and incomplete evidence/reviews/reports cannot be
  marked read.

Content model per kind:

- **plan** — one `workingDirectory` plus four flat prose fields: `goalScope`
  (`# Goal / Scope`, whole-field set), `intendedChanges` (`## Intended Changes
  and Behaviors`, exact oldText→newText patch), `context` (`## Context`, exact
  oldText→newText patch), and `checks` (`## Checks`, whole-field set). An
  evidence membership array `evidence` holds snapshotted entries `{id:
  art_…, description}` keyed only by the evidence artifact ID; the immutable
  short description is captured automatically when Planner attaches the
  evidence, so plans stay readable after later artifact cleanup. Finalization
  requires non-empty Goal/Scope and Intended Changes; Checks, Context and
  evidence stay optional.
- **evidence** — a main question/topic plus `summary` (## Summary) and
  `limitations` (## Limitations) prose, and an ordered array of detailed
  findings (`fin_…` IDs) with a title and self-contained content. Finding IDs
  are stable for their author only and never enter the rendered Markdown or
  Planner context.
- **review** — a machine-readable `outcome` (`Pass`, `Changes required`, or
  `Blocked`), a human-readable `summary` (## Summary), and ordered findings
  (`fin_…` IDs) with severity, affected path/symbol, evidence, risk, and
  correction.
- **report** — a linked `planArtifactID` naming its approved plan plus four
  prose sections `summary` (## Summary), `changed` (## Changed), `checks`
  (## Checks), and `unfinished` (## Unfinished); finalization requires the
  Summary and publishes the report so Planner/Review can consume it.

## Paths

- Source (chezmoi-managed):
  `~/.local/share/chezmoi/dot_config/external_opencode/plugins/plan-bridge/`
- Live (applied target): `~/.config/opencode/plugins/plan-bridge/`
- Registry state: `$XDG_STATE_HOME/opencode/plan-bridge/` (fallback
  `~/.local/state/opencode/plan-bridge/`), one directory per artifact under
  `artifacts/<id>/` containing the authoritative `record.json` and the generated
  `current.md` view.

Files: `store.mjs` (Node-compatible registry logic), `format.mjs` (one-way
rendering of the generated view), `artifact-rpc.ts` (RPC contract), `index.ts`
(tool + RPC registration and delivery), `artifact-tools.ts` (tool logic,
owner/writer resolution, compact message builders), tests `store.test.mjs` and
`artifact-tools.test.mjs`.

## Storage and the generated view

- `record.json` is authoritative and written last. Records must use the flat
  kind-specific model; unsupported record shapes are rejected.
- `current.md` is a one-way rendering for display: a frontmatter block
  containing ONLY frontend artifact metadata (`id`, `kind`, `status`, `title`,
  `primaryAuthor`, `description` — never owner/writer/session routing IDs)
  followed by a deterministic kind-specific body, formatted by Prettier over
  the complete document. Plans render `# Goal / Scope`, `## Intended Changes
  and Behaviors`, `## Context`, a nested `### Evidence` bullet list (description
  snapshot + artifact ID), and `## Checks`; evidence renders the question,
  Summary, Limitations, and `## Findings`; reviews render Outcome, Summary, and
  named finding sections; reports render Summary/Changed/Checks/Unfinished.
  Finding IDs never appear in the Markdown; they are returned by the tools and
  listed compactly by the full load tools only. The generated view is never
  parsed back into storage; editors read it read-only.
- After an interrupted write the next mutation regenerates the view from the
  record.

## Model-facing tools

Capability tools, registered under the documented namespace/codemode contract —
the model reaches them as `tools.plan["create"]`, `tools.evidence["summary"]`,
and so on, and each effective name (`plan_create`, `evidence_summary`, …) is
also its permission string. The kind, namespace, and permission are fixed by
each tool and never supplied by the model; a wrong-kind ID fails with
`invalid_kind`.

Authoring returns DIRECTLY REUSABLE machine values, so a create result can be
passed straight into the next call without parsing formatted prose:

- create (`plan_create`, `evidence_create`, `review_create`, `report_create`)
  returns the bare artifact ID (`art_…`).
- append (`evidence_finding_put`, `review_finding_put`, no findingID) returns
  the bare generated finding ID (`fin_…`).
- setters/patches (`plan_field_set`, `plan_field_patch`,
  `plan_evidence_add/remove`, `evidence_overview_put`,
  `report_content_put/remove`, finding removes) return the bare ID of the
  artifact or finding they just touched.
- finalize returns the bare artifact ID/status contract (`art_… published` for
  evidence/review/report; `art_… finalized` for plans).

Any edit clears finalization, so the writer re-runs the kind's finalize tool to
publish (evidence/review/report) or make approvable (plan) again.

Read tools return readable compact text, never full bodies unless they are a
full loader:

- Plan namespace (Planner): `plan_create`, `plan_field_set` (goalScope/checks,
  whole-field), `plan_field_patch` (intendedChanges/context,
  oldText→newText; a stale base is refused with `patch_conflict` and the
  record is untouched — re-read and re-base, never silently merged),
  `plan_evidence_add` / `plan_evidence_remove` (membership by evidence
  artifact IDs; add takes one ordered non-empty `evidenceIDs` array and is
  atomic — every member is validated as a finalized published evidence artifact
  in the same location before any change, each immutable description is
  snapshotted, and duplicates against existing membership or earlier entries in
  the array are skipped, preserving existing order then first-input order; any
  invalid member leaves the plan unchanged),
  `plan_finalize` (requires non-empty Goal/Scope and Intended Changes; Checks optional),
  `plan_status` (metadata + readiness only).
- `plan_load_approved` (Builder, Review) — loads an approved plan by ID with
  its full Markdown inline; atomically enforces `kind=plan` and
  `status=approved` (`invalid_kind` for non-plans, `not_approved` for
  unapproved plans), and lists the evidence membership IDs.
- Evidence namespace (Search authors; Builder/Review load):
  `evidence_create`, `evidence_overview_put` (sets question/Summary/Limitations
  in one call, provided fields replace wholesale), `evidence_finding_put` /
  `evidence_finding_remove` (detailed findings by stable author IDs),
  `evidence_finalize` (requires a Summary, Limitations, or at least one
  finding; publishes), `evidence_load` (Builder/Review, or Planner for
  user-requested explanation; full content inline,
  kind-locked, read-only), `evidence_summary` (Planner, compact overview —
  question/Summary/Limitations only, NEVER findings).
- Review namespace (Review authors; Builder loads): `review_create`,
  `review_outcome_put` (`Pass` | `Changes required` | `Blocked`),
  `review_summary_put` (human Summary), `review_finding_put` /
  `review_finding_remove`, `review_finalize` (requires outcome + Summary),
  `review_load` (Builder corrections, full content, read-only),
  `review_summary` (Planner, outcome + human Summary only, NEVER findings).
- Report namespace (Builder authors; Review loads; Planner reads):
  `report_create` (links the approved plan; requires `kind=plan`,
  `status=approved`; title/description derive from the plan),
  `report_content_put` / `report_content_remove` (whole-section sets for
  summary/changed/checks/unfinished), `report_finalize` (requires the Summary;
  publishes), `report_load` (Review only, full content — the linked
  `Plan: <artID>` lets Review recover the approved plan from only the Report
  ID), `report_summary` (Planner; the sole compact Report reader — the header
  already shows kind/status/finalized, the body adds the linked plan and the
  Summary, NEVER Changed/Checks/Unfinished).

Summary/full boundaries: Planner normally consumes the compact summary readers
(plus the `plan_status` authoring reader); full loaders (evidence_load,
review_load, report_load, plan_load_approved)
serve the assigned worker roles for implementation and correction work. Finding
IDs never enter rendered Markdown. Planner may load full evidence when needed
to explain it to the user, rather than launching redundant research.

Owner resolution (`artifact-tools.ts`): the owner is the nearest Planner in the
server-assigned session ancestry (`ctx.session.get` walking `parentID`) — a
Planner caller owns its own artifact; worker sessions walk to their Planner;
when no Planner ancestor is reachable (a standalone session such as the
unrestricted test agent) the caller owns its own artifact. The writer is the
validated calling session recorded at creation. `primaryAuthor` is derived from
the creating agent's name. Every fetched session is validated (requested ID,
same location). Same-location operation only; moved owners fail visibly.

## Agent roles (exact-ID handoffs)

Planner alone assigns Search, Builder and Review, owns decisions, and
coordinates the artifact writers. Workers are launched with the `subagent` tool
(agent ID, short `description`, complete `prompt`); independent work uses
`background: true`, and the returned `sessionID` continues that same child
conversation. Runner is the shared command helper: Planner, Search, and Review may
call it for a short bounded operation without rounding back through Planner.
Search, Runner, Builder, and Review run as catalog-visible `mode: subagent`
workers. Builder uses its own shell and cannot delegate. Only Runner is callable
by Search and Review; no worker may launch
Search, Builder, or Review.

Because OpenCode propagates only the child's final TEXT to the parent, every
worker performs all work through tools and then emits EXACTLY the successfully
finalized artifact ID as its sole terminal text — no narration, summary, or
formatting. An ID is never emitted for an unfinished draft; a failure fallback
states the blocker and returns essential content inline.

- **Planner** (primary) authors `plan` artifacts, acts on the user's approval,
  and launches Builder directly from the approval notification (which names
  `kind=plan`, `status=approved`, `finalized=true`; `plan_status` stays for
  plan-authoring/readiness inspection only). It consumes compact summary
  readers (`evidence_summary`, `review_summary`, `report_summary`) by default;
  full evidence is available for user-requested explanation, not routine ingestion.
  It does not read artifact view files or edit project
  files.
- **Search** researches source files and documentation read-only and authors
  `evidence` artifacts: one draft per session with overview + detailed
  findings, finalized to published; its terminal text is the evidence artifact
  ID.
- **Runner** executes only the bounded commands or operations a caller assigns
  and returns a short result, not an artifact.
- **Builder** applies the exact approved plan, runs only the checks the plan
  assigns, and authors a `report` artifact linked to the plan
  (Summary/Changed/Checks/Unfinished, finalized); its terminal text is the
  report artifact ID. It holds `plan_load_approved`, `evidence_load`, and
  `review_load` (for corrections) — content comes back inline; there is no
  second read step.
- **Review** receives the Builder report artifact ID, loads it (plus the
  approved Plan/Evidence it references) read-only, authors a `review` artifact
  (outcome + Summary + findings, finalized), and returns only its review
  artifact ID. Review is optional for larger/riskier changes, not a completion
  or publication prerequisite; it targets deeper risks rather than repeating
  Builder's successful immediate checks.

Plans should be small working increments. Omit Checks for low-risk edits;
`plan_field_set` accepts empty content to clear Checks. When a concrete risk
warrants one, assign a targeted immediate test, not a generic validation list.
Search reads files directly, reuses established findings, and stops once its
single question is answered. Runner handles bounded execution observations with
a timeout and output budget.

## Non-transactional resumability

The create → put → finalize chain is deliberately non-transactional. A failed
or interrupted `execute` chain is not rolled back: completed idempotent writes
remain durable, the artifact keeps its stable IDs, and the chain is resumed by
continuing calls on the same artifact ID and then finalizing. Finalization is
the validation boundary — a plan with missing required prose, an evidence with
no useful content, or a report without a Summary simply fails finalize, never
half-publishes. Approval is the terminal boundary: approved plans cannot be
reopened or mutated.

## RPC contract

`personal.artifacts` (outputs use `artifacts`/`artifact`): `list` — summaries
with kind, title, description, primary author, owner-scoping metadata for
attached-session filtering, readiness and status (declares no input; the client
still sends the normalized `{"input":{}}` object body); `get` — the latest
generated view for one artifact ID; `feedback` — question/selection against one
artifact ID with an optional validated `recipient` (`"owner"` or `"writer"`,
defaulting to `owner`); `approve_plan` — plan only, requires a finalized draft
(`not_ready` otherwise), sets `status: approved` (the Builder gate) and freezes
further edits; `mark_read` — evidence/review/report only, sets `status: read`
with no owner notification and no delivery bookkeeping; `retry_plan_delivery` —
redeliver a recorded plan-approval submission by request ID.

Metadata separation: the wire summary carries frontend metadata (`title`,
`description`, `primaryAuthor`, `status`) plus `ownerSessionID` for the Neovim
attached-session filter only. `writerSessionID` stays internal to records and
delivery and is stripped from every RPC-bound summary/view in `index.ts`; no
session identity is ever rendered as frontmatter.

Errors are declared responses (`validation`, `not_found`, `invalid_kind`,
`not_ready`, and for the tools `patch_conflict`/`not_approved`/`forbidden`/
`approved`/`lock_conflict`, `io`), not arbitrary thrown errors. Every lookup is
scoped to the artifact's recorded location.

Feedback recipients resolve only the stored session identities: `owner` targets
the artifact's `ownerSessionID` and `writer` its `writerSessionID`. A target
that is unavailable at delivery time is recorded as a `failed` delivery — never
silently rerouted. The Neovim UI sends `recipient: "owner"`; writer-directed
feedback is backend-only for now.

## Feedback / approval / read semantics

- Submissions deduplicate by a client-generated `requestID`; a repeated
  submission returns the recorded one (with its recorded recipient) instead of
  creating a duplicate.
- A plan approval is the recorded decision and the sole implementation gate: it
  authorizes Builder and the approved plan then rejects every further edit.
- Evidence/review/report dismissal is `mark_read`: it records a `readAt` marker
  and the `read` status with NO approval record and NO delivery; editing a
  `read` artifact returns it to the visible `draft` (clearing the marker and
  readiness) so it reappears in pickers until re-finalized.
- Byte limits: question ≤ 16384 UTF-8 bytes, selected excerpt ≤ 65536 UTF-8
  bytes; oversized input is rejected with a `validation` error and leaves no
  submission behind.

## Delivery (synthetic, honest, retryable for plans)

A submission is persisted first, then a message is durably admitted to the
target session via `ctx.session.synthetic` with explicit `delivery: "queue"` and
`resume: true` (admission and scheduling, not model completion). Delivery is
plan-approval and feedback only; `mark_read` never delivers. The compact
builders emit:

- `description` — short title-bearing UI label rendered after the synthetic
  event marker (e.g. `Feedback: <title>`).
- `text` — model-visible: feedback names the artifact ID, the user question, and
  exactly one optional context representation (quoted selected excerpt,
  otherwise the selected line range, otherwise general feedback). Approval text
  is one deterministic line naming the approved artifact ID plus the frozen
  record's authoritative fields (`kind=plan status=approved finalized=true`),
  so Planner dispatches Builder without a separate status lookup; retry re-emits
  the same current authoritative payload.
- `metadata` — model-invisible bookkeeping: `artifactID`, `requestID`, `kind`,
  `submission`, `recipient`, `source`.

Delivery state is recorded per submission (`pending` → `delivered` | `failed`),
and bookkeeping always names the submission type (`feedback` or `approval`), so
a request ID reused across a feedback and a plan approval can never mark the
wrong delivery record. Failed plan-approval deliveries can be retried after
editor restarts with the same request ID. Retry (`retry_plan_delivery` and the
editor's retry paths) is plan-approval-only; feedback is send-once. Delivery is
**at-least-once, not exactly-once**.

## Stale locks

Mutations hold an exclusive per-artifact lock file (`artifacts/<id>/lock`). An
existing lock is reported as a `lock_conflict` error — it is never bypassed. If
a mutation crashed while holding the lock, the lock file is stale: remove
`artifacts/<id>/lock` by hand and retry. The record is never discarded.

## Tests

Standalone tests run on the repository's mise-managed Node (the plugin itself
runs under OpenCode's embedded Bun, but the tests do not need Bun and no Bun
installation or scripts are added):

```
mise exec -- node --experimental-strip-types --test \
  dot_config/external_opencode/plugins/plan-bridge/store.test.mjs \
  dot_config/external_opencode/plugins/plan-bridge/artifact-tools.test.mjs
```

## Neovim side

`~/.config/nvim/lua/editor/features/opencode-artifacts.lua`
(`NVOpenCodeArtifacts`) targets the RPC (`personal.artifacts`) and opens each
artifact's generated `current.md` read-only. The picker exposes
`:OpenCodePlans` (draft plans by default), `:OpenCodeEvidence`,
`:OpenCodeReviews`, `:OpenCodeReports`, `:OpenCodeArtifacts` on
`<leader>ap/ae/ar/aq/aa`, with `<M-a>`
to include resolved rows (`approved` plans and `read` evidence/reviews/reports)
and `<M-r>` to retry a recorded-but-undelivered plan approval. Rows show kind,
title, status, the primary author label (never a session ID) and update date.
Artifact buffers carry `OpenCodeArtifactFeedback`, `OpenCodeArtifactRetryDelivery` and —
context-sensitively — `OpenCodeArtifactApprove` (finalized draft plans only,
readiness-gated) or `OpenCodeArtifactMarkRead` (published evidence/reviews/
reports), both on `<leader>ay` (plus `<leader>af`). Feedback is sent with
`recipient = "owner"`; writer-directed feedback is backend-only for now. Start a
fresh Neovim instance after updating.

Requests go through `opencode api` with argv lists and JSON-encoded bodies;
user-selected Markdown is never interpolated into shell commands.
