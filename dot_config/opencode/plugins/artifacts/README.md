# artifacts

A standalone, filesystem-backed registry for durable artifacts and the agent
tools that author them. It knows nothing about the Neovim bridge: the RPC
adapter lives in `../artifacts-rpc/`, which imports this package and registers
`personal.artifacts` through `../bridge/registry.ts`.

Artifacts are working memory. `system` is the primary agent and implements
changes directly; a plan gates implementation only when the user asked for one,
and can otherwise be drafted, filled in, and revised without blocking the work.
Evidence, reviews, and reports are optional durable records. Project memory and
the session checkpoint are the two live documents that are injected back into
the agent context.

## Artifact kinds

Every artifact is one structured record plus one generated read-only view,
addressed by ID only:

- `id` — the `art_…` identifier.
- `kind` — `memory` (project), `checkpoint` (session), `plan`, `evidence`,
  `review`, or `report`.
- `title` / `description` / `primaryAuthor` — short human-facing labels,
  immutable once created.
- `status` — `draft`, `published`, `approved`, or `read`; memory and the
  checkpoint are always `published`. Plans use `draft` until finalized, then may
  be marked `approved` as a review marker. Evidence, reviews, and reports are
  finalized to `published` and dismissed to `read`.
- `finalized` — readiness. Content mutations clear it; `plan_finalize` makes a
  plan ready for review, and evidence/review/report finalization publishes the
  draft. Memory and the checkpoint stay finalized.

### memory and checkpoint

Two live Markdown documents (`content`), both always readable and editable:

- `memory` is **project memory**, one document per project root (the git common
  checkout, so subdirectories and linked worktrees share it; see `project.mjs`).
  Any primary session in the project may append or correct it.
- `checkpoint` is the session's small objective/requirements/decisions/progress
  document. It stays owned by the session that created it.

`memory_open` with `scope: "project"` (default) or `scope: "session"` returns
the existing document or creates it; `memory_append` adds a section at each
milestone; `memory_patch` replaces one exact occurrence; `memory_put` replaces
the whole body. The plugin injects the checkpoint in full (head+tail bounded)
and project memory as a section index into every agent-loop request (`context`
hook). The built-in compaction prompt is left alone; the next request reloads
the live documents. `artifact_search` searches the session directory plus shared
project memory and finds either by text when the ID is unknown.

### plan

A plan is an optional working document for multi-step or risky work. It has one
`workingDirectory` plus four flat prose fields: `goalScope` (`# Goal / Scope`),
`intendedChanges` (`## Intended Changes and Behaviors`), `context`
(`## Context`), and `checks` (`## Checks`). `plan_field_patch` replaces one
exact occurrence, so a single bullet or paragraph can change without restating
the whole field. An evidence membership array snapshots `{id, description}` for
attached evidence. `plan_finalize` requires non-empty Goal/Scope and Intended
Changes; checks, context, and evidence stay optional. `plan_load` reads any
plan, draft or reviewed. Editing a reviewed plan returns it to draft and clears
the review marker.

### evidence

A main question/topic plus `summary`, `limitations`, and an ordered array of
findings. Findings have stable author-only IDs and self-contained content.
`evidence_finalize` requires a Summary, Limitations, or at least one finding.

### review

A machine-readable `outcome` (`Pass`, `Changes required`, or `Blocked`), a human
`summary`, and ordered findings with severity, affected path/symbol, evidence,
risk, and correction. `review_finalize` requires the outcome and Summary.

### report

An optional linked `planArtifactID` (draft or reviewed), plus `summary`,
`changed`, `checks`, and `unfinished`. `report_finalize` requires the Summary; a
report without a plan is valid.

## Paths

- Source (chezmoi-managed):
  `~/.local/share/chezmoi/dot_config/opencode/plugins/artifacts/`
- Live (applied target): `~/.config/opencode/plugins/artifacts/`
- Registry state: `$XDG_STATE_HOME/opencode/plan-bridge/` (fallback
  `~/.local/state/opencode/plan-bridge/`), one directory per artifact under
  `artifacts/<id>/` containing the authoritative `record.json` and the generated
  `current.md` view. The state directory name is retained so existing artifacts
  survive the rename.

Files: `store.mjs` (Node-compatible registry logic), `format.mjs` (one-way
rendering of the generated view), `project.mjs` (project-root resolution),
`artifact-rpc.ts` (RPC contract, imported by the adapter), `index.ts` (tool
registration and memory injection), `artifact-tools.ts` (tool logic,
owner/writer resolution, compact message builders). Tests live in
`../../tests/artifacts/`.

## Storage and the generated view

- `record.json` is authoritative and written last. Records use the flat
  kind-specific model; unsupported shapes are rejected.
- `current.md` is a one-way rendering for display: frontmatter with only
  frontend metadata (`id`, `kind`, `status`, `title`, `primaryAuthor`,
  `description`) followed by a deterministic kind-specific body, formatted by
  Prettier over the complete document. The generated view is never parsed back
  into storage; editors read it read-only.
- After an interrupted write the next mutation regenerates the view from the
  record.

## Model-facing tools

Capability tools are registered under the documented namespace/Code Mode
contract. The model calls them as `tools.memory["open"]`,
`tools.plan["create"]`, and so on; each effective name (`memory_open`,
`plan_create`, …) is also its permission string. Kind, namespace, and permission
are fixed by the tool and never supplied by the model; a wrong-kind ID fails
with `invalid_kind`.

Authoring returns directly reusable machine values:

- create (`memory_open`, `plan_create`, `evidence_create`, `review_create`,
  `report_create`) returns the bare artifact ID (`art_…`). Create early; the
  optional initial fields let you record what you already know without waiting
  for the whole artifact to be finished.
- append (`evidence_finding_put`, `review_finding_put`, no findingID) returns
  the bare generated finding ID (`fin_…`).
- setters/patches (`plan_field_set`, `plan_field_patch`,
  `plan_evidence_add/remove`, `evidence_overview_put`,
  `memory_put/append/patch`, `report_content_put/remove`, finding removes)
  return the bare artifact or finding ID.
- finalize returns `art_… published` for evidence/review/report and
  `art_… finalized` for plans.

Read tools return compact text; full loaders include the body:

- `memory_open` (`scope` project/session, optional initial `content`),
  `memory_load` (full; omitting the ID resolves project memory),
  `memory_summary` (metadata + body).
- `artifact_search` — plain-text search across artifact bodies with an optional
  kind filter, so memories and evidence are discoverable without IDs.
- `plan_load` (any status), `plan_status`.
- `evidence_create` (optional question/Summary/Limitations), `evidence_finalize`
  (optional final overview fields), `evidence_load` (full), `evidence_summary`
  (overview only).
- `review_create` (optional outcome/Summary), `review_finalize` (optional final
  outcome/Summary), `review_load` (full), `review_summary` (outcome + Summary
  only).
- `report_create` (optional plan and initial sections), `report_finalize`
  (optional final sections), `report_load` (full), `report_summary` (linked plan
  - Summary only).

Plans gate implementation only when the user asked for one. Otherwise the model
may `plan_load` a draft and act on it, and the user's review is feedback rather
than a permission step.

### Typical authoring flows

The setters are available for edits, but the shortest useful flow is:

- **memory** — `memory_open` (project or session, optional initial content) →
  `memory_append` at milestones → `memory_patch` for corrections and to
  supersede stale entries.
- **evidence** — `evidence_create` (optional question/Summary/Limitations) →
  `evidence_finding_put` as facts are confirmed → `evidence_finalize` (optional
  final overview).
- **review** — `review_create` (optional outcome/Summary) → `review_finding_put`
  per finding → `review_finalize` (optional final outcome/Summary).
- **plan** — `plan_create` → `plan_field_set` Goal/Scope → `plan_field_patch`
  one unique bullet at a time → `plan_finalize`. When the user asked for a plan,
  stop for approval after finalizing.
- **report** — `report_create` (optional plan and initial sections) →
  `report_content_put` for later sections → `report_finalize` (optional final
  sections).

A draft can be created as soon as its subject is known and filled while the work
continues; a finalize call is a readiness/publish boundary, not a permission
boundary.

### Schema notes

Fields that look redundant are deliberate:

- `status` and `finalized` answer different questions: lifecycle
  (`draft`/`published`/`approved`/`read`) and readiness. A plan can be finalized
  and still draft; evidence/review/report finalization publishes.
- `ownerSessionID` routes feedback; `writerSessionID` is the sole mutation
  authority. They differ when a worker authors an artifact.
- `primaryAuthor` is an immutable frontend label, never a session identity.
- Plan evidence stores an immutable description snapshot so the plan stays
  readable after the evidence artifact changes or is cleaned up.
- `report.planArtifactID` is optional. A report can stand alone; the old
  required link was the one genuinely redundant constraint and was removed.

## RPC contract

`personal.artifacts` (outputs use `artifacts`/`artifact`):

- `list` — summaries with kind, title, description, primary author, status,
  readiness, and owner-scoping metadata.
- `get` — the latest generated view for one artifact ID.
- `feedback` — question/selection against one artifact ID with an optional
  validated `recipient` (`"owner"` or `"writer"`, default `"owner"`).
- `approve_plan` — plan only, requires a finalized draft (`not_ready`
  otherwise), sets `status: approved` as a review marker. Editing the plan
  clears the marker and returns it to draft. It does not authorize or block any
  implementation.
- `mark_read` — evidence/review/report only, sets `status: read` with no owner
  notification and no delivery bookkeeping. Memory and checkpoints are live and
  have no read state.
- `retry_plan_delivery` — redeliver a recorded plan-review submission by request
  ID.

Metadata separation: the wire summary carries frontend metadata plus
`ownerSessionID` for the Neovim attached-session filter. `writerSessionID` stays
internal and is stripped from every RPC-bound summary/view.

Errors are declared responses (`validation`, `not_found`, `invalid_kind`,
`not_ready`, `patch_conflict`, `forbidden`, `lock_conflict`, `io`), not
arbitrary thrown errors.

## Feedback and review semantics

- Submissions deduplicate by a client-generated `requestID`.
- A plan review is a recorded marker plus a synthetic notification. It is not an
  implementation gate; the primary agent may continue working while the user
  reviews.
- Editing a `read` or `approved` artifact returns it to the visible `draft`,
  clears readiness (except memory), and clears the review/read marker so it
  reappears in pickers until re-finalized.
- Byte limits: question ≤ 16384 UTF-8 bytes, selected excerpt ≤ 65536 UTF-8
  bytes.

## Delivery

A submission is persisted first, then durably admitted to the target session via
`ctx.session.synthetic` with `delivery: "queue"` and `resume: true`. Delivery is
review/feedback only; `mark_read` never delivers. Approval text names the
artifact ID and the record's authoritative
`kind=plan status=approved finalized=true` payload so the primary agent can
answer the review without a separate lookup. Delivery is at-least-once, not
exactly-once.

## Stale locks

Mutations hold an exclusive per-artifact lock file (`artifacts/<id>/lock`). An
existing lock is reported as `lock_conflict`; it is never bypassed. If a
mutation crashed while holding the lock, remove `artifacts/<id>/lock` by hand
and retry. The record is never discarded.

## Tests

Standalone tests run on the repository's mise-managed Node (the plugin runs
under OpenCode's embedded Bun, but the tests do not need Bun):

```
mise exec -- node --experimental-strip-types --test \
  dot_config/opencode/tests/artifacts/store.test.mjs \
  dot_config/opencode/tests/artifacts/project.test.mjs \
  dot_config/opencode/tests/artifacts/artifact-tools.test.mjs
```

## Neovim side

`~/.config/nvim/lua/editor/features/opencode-artifacts.lua`
(`NVOpenCodeArtifacts`) targets the RPC (`personal.artifacts`) and opens each
artifact's generated `current.md` read-only. The picker exposes
`:OpenCodePlans`, `:OpenCodeEvidence`, `:OpenCodeReviews`, `:OpenCodeReports`,
`:OpenCodeArtifacts` on `<leader>ap/ae/ar/aq/aa` (the All view excludes memory
and checkpoints: they are live session state, not reviewable artifacts), with
`<M-a>` to include resolved rows and `<M-r>` to retry a recorded-but-undelivered
plan review. Artifact buffers carry `OpenCodeArtifactFeedback`,
`OpenCodeArtifactRetryDelivery`, and context-sensitively
`OpenCodeArtifactApprove` (finalized draft plans) or `OpenCodeArtifactMarkRead`
(published evidence/reviews/reports), both on `<leader>ay` (plus `<leader>af`).

Requests go through `opencode api` with argv lists and JSON-encoded bodies;
user-selected Markdown is never interpolated into shell commands.
