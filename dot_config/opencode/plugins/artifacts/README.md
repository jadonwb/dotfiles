# artifacts

A standalone, filesystem-backed registry for durable artifacts and the agent
tools that author them. The RPC adapter lives in `../artifacts-rpc/`, which imports this package and registers
`personal.artifacts` through `../bridge/registry.ts`.

Artifacts are structured records. `system` is the primary agent and implements
changes directly; a plan gates implementation only when the user asked for one,
and can otherwise be drafted, filled in, and revised without blocking the work.
Evidence and reviews are optional durable records. The prompt stays stable:
durable knowledge lives in `AGENTS.md`, repository docs, and these artifacts.

## Artifact kinds

Every artifact is one structured record plus one generated read-only view,
addressed by ID only:

- `id` — the `art_…` identifier.
- `kind` — `plan`, `evidence`, or `review`.
- `title` / `description` / `primaryAuthor` — short human-facing labels,
  immutable once created.
- `status` — `draft`, `published`, or `read`. Plans stay `draft` until
  `plan_complete`; evidence and reviews are finalized to `published` and
  dismissed to `read`.
- `finalized` — readiness for evidence and reviews. Plans are created finalized
  and stay editable until completion.

### plan

A plan is the working document for a feature or investigation: goal and scope,
intended changes, decisions, checks, and evidence links. It has one
`workingDirectory` plus four flat prose fields: `goalScope` (`# Goal / Scope`),
`intendedChanges` (`## Intended Changes and Behaviors`), `context`
(`## Context`), and `checks` (`## Checks`). `plan_create` accepts initial field
content. `plan_update` replaces any subset of fields atomically, replaces the
ordered `evidenceIDs` membership, and optionally patches one exact occurrence in
`intendedChanges` or `context`, so a single bullet or paragraph can change
without restating the whole field. An evidence membership array snapshots
`{id, description}` for attached evidence. `plan_load` reads any plan and reports
status and completion. `plan_complete` records the outcome summary, changed
files, verification, and unfinished work, then freezes the plan; later content
mutations fail and a new plan references the completed one with
`previousPlanID`.

### evidence

A main question/topic plus `summary`, `limitations`, and an ordered array of
findings. Findings have stable author-only IDs and self-contained content.
`evidence_finalize` requires a Summary, Limitations, or at least one finding.

### review

A machine-readable `outcome` (`Pass`, `Changes required`, or `Blocked`), a human
`summary`, and ordered findings with severity, affected path/symbol, evidence,
risk, and correction. `review_finalize` requires the outcome and Summary.

## Paths

- Source (chezmoi-managed):
  `~/.local/share/chezmoi/dot_config/opencode/plugins/artifacts/`
- Live (applied target): `~/.config/opencode/plugins/artifacts/`
- Registry state: `$XDG_STATE_HOME/opencode/artifacts/` (fallback
  `~/.local/state/opencode/artifacts/`), one directory per artifact directly
  under it, each containing the authoritative `record.json` and the generated
  `current.md` view.

Files: `store.mjs` (Node-compatible registry logic), `format.mjs` (one-way
rendering of the generated view), `project.mjs` (project-root resolution),
`artifact-rpc.ts` (RPC contract, imported by the adapter), `index.ts` (tool
registration), `artifact-tools.ts` (tool logic, owner/writer resolution, compact
message builders). Tests live in
`../../tests/artifacts/`.

## Storage and the generated view

- `record.json` is authoritative and written last. Records use the flat
  kind-specific model; unsupported shapes are rejected.
- `current.md` is a one-way rendering for display: frontmatter with only
  frontend metadata (`id`, `kind`, `status`, `title`, `primaryAuthor`,
  `description`) followed by a deterministic kind-specific body, formatted by
  Prettier over the complete document. The generated view is one-way; editors read it
  read-only.
- After an interrupted write the next mutation regenerates the view from the
  record.

## Model-facing tools

Capability tools are registered under the documented namespace/Code Mode
contract. The model calls them as `tools.plan["create"]`,
`tools.evidence["create"]`, and so on; each effective name (`plan_create`,
`evidence_create`, …) is also its permission string. Kind, namespace, and permission
come from the tool; a wrong-kind ID fails
with `invalid_kind`.

Authoring returns directly reusable machine values:

- create (`plan_create`, `evidence_create`, `review_create`) returns the bare
  artifact ID (`art_…`). Create early; the optional initial
  fields let you record what you already know without waiting for the whole
  artifact to be finished.
- finding (`evidence_finding`, `review_finding`, no findingID) returns the bare
  generated finding ID (`fin_…`); with `findingID` it replaces, and with
  `remove: true` it removes.
- updates (`plan_update`, `evidence_update`, `review_update`) return the bare
  artifact or finding ID. `plan_update` is one atomic write
  covering fields, evidence membership, and an optional patch.
- `plan_complete` records the outcome and freezes the plan; it returns
  `art_… completed`.
- finalize returns `art_… published` for evidence and reviews.

Read tools return compact text; full loaders include the body:

- `artifact_search` — plain-text search across artifact bodies in the project,
  with an optional kind filter, so evidence, plans, and reviews are discoverable
  without IDs.
- `plan_load` (any status; includes completion and the previous plan).
- `evidence_create` (optional question/Summary/Limitations), `evidence_update`
  (overview fields), `evidence_finalize` (optional final overview fields),
  `evidence_load` (full), `evidence_summary` (overview only).
- `review_create` (optional outcome/Summary), `review_update` (outcome and/or
  Summary), `review_finalize` (optional final outcome/Summary), `review_load`
  (full), `review_summary` (outcome + Summary only).

Plans guide implementation. The model may `plan_load` any plan and act on it;
the user's review is feedback, and implementation continues.

### Typical authoring flows

The setters are available for edits, but the shortest useful flow is:

- **evidence** — `evidence_create` (optional question/Summary/Limitations) →
  `evidence_finding` as facts are confirmed → `evidence_finalize` (optional
  final overview).
- **review** — `review_create` (optional outcome/Summary) → `review_update` →
  `review_finding` per finding → `review_finalize` (optional final
  outcome/Summary).
- **plan** — `plan_create` with Goal/Scope and Intended Changes → `plan_update`
  for field changes, evidence membership, or one targeted patch → implement →
  `plan_complete` with the outcome, changed files, verification, and unfinished
  work. The completed plan is frozen; a follow-up plan passes `previousPlanID`,
  whether the predecessor is finished or still open.

A plan can be created as soon as its subject is known and filled while the work
continues. It stays editable until completion.

### Schema notes

Fields that look redundant are deliberate:

- `status` and `finalized` answer different questions: lifecycle
  (`draft`/`published`/`read`) and readiness. Plans are finalized drafts until
  completion; evidence/review finalization publishes.
- `ownerSessionID` routes feedback; `writerSessionID` is the sole mutation
  authority. They differ when a worker authors an artifact. Feedback defaults
  to the owner; when the writer is a worker, the owner resumes that worker with
  the feedback and the worker updates the artifact.
- `primaryAuthor` is an immutable frontend label; session identities stay
  internal.
- Plan evidence stores an immutable description snapshot so the plan stays
  readable after the evidence artifact changes or is cleaned up.
- `completedAt` is the plan freeze marker, separate from `status` and
  `finalized`. A completed plan rejects later content mutations.

## RPC contract

`personal.artifacts` (outputs use `artifacts`/`artifact`):

- `list` — summaries with kind, title, description, primary author, status,
  readiness, and feedback-routing metadata.
- `get` — the latest generated view for one artifact ID.
- `feedback` — question/selection against one artifact ID with an optional
  validated `recipient` (`"owner"` or `"writer"`, default `"owner"`).
- `mark_read` — evidence/review only, sets `status: read` and records the
  dismissal.

Metadata separation: the wire summary carries frontend metadata plus
`ownerSessionID` for feedback routing. `writerSessionID` stays
internal and is stripped from every RPC-bound summary/view.

Errors are declared responses (`validation`, `not_found`, `invalid_kind`,
`not_ready`, `patch_conflict`, `forbidden`, `lock_conflict`, `io`), not
arbitrary thrown errors.

## Feedback and review semantics

- Submissions deduplicate by a client-generated `requestID`.
- Feedback is a synthetic notification to the target session; the primary agent
  continues working while the user reviews.
- Editing a `read` evidence or review returns it to the visible `draft`, clears
  readiness, and clears the read marker so it reappears in pickers until
  re-finalized.
- Byte limits: question ≤ 16384 UTF-8 bytes, selected excerpt ≤ 65536 UTF-8
  bytes.

## Delivery

A submission is persisted first, then durably admitted to the target session via
`ctx.session.synthetic` with `delivery: "queue"` and `resume: true`. Delivery covers
review/feedback; `mark_read` records the dismissal on the server (`status:
read`). Delivery is at-least-once.

## Stale locks

Mutations hold an exclusive per-artifact lock file (`artifacts/<id>/lock`). An
existing lock is reported as `lock_conflict`; do not bypass it. If a mutation
crashed while holding the lock, ask the user to confirm the holder is gone
before removing `artifacts/<id>/lock`.

## Tests

Standalone tests run on the repository's mise-managed Node (the plugin runs
under OpenCode's embedded Bun; the tests run under Node):

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
`:OpenCodePlans`, `:OpenCodeEvidence`, `:OpenCodeReviews`, and
`:OpenCodeArtifacts` on `<leader>ap/ae/ar/aa`. `<M-a>` includes resolved rows and
Artifact buffers carry `OpenCodeArtifactFeedback` and, for published evidence
and reviews, `OpenCodeArtifactMarkRead` on `<leader>ay` (plus `<leader>af`).

Requests go through `opencode api` with argv lists and JSON-encoded bodies.
