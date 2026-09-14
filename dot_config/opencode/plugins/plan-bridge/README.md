# plan-bridge

A filesystem-backed registry for passing Markdown artifacts between OpenCode
sessions and Neovim, and the authoritative implementation-approval gate. A plan
artifact whose `artifact_get` shows `status=approved`,
`authority=implementation`, and the exact approved revision is what authorizes
Builder.

## Artifacts

Every artifact is Markdown plus a small record:

- `id` — the `art_…` identifier.
- `kind` — `plan`, `evidence`, or `review`.
- `title` / `description` — short human-facing labels, generated into the
  document frontmatter.
- `status` — plans start `draft`; evidence and reviews start `published`; a
  plan becomes `approved` when its displayed revision is approved.
- `authority` — record-only. New plans record `implementation`; evidence and
  reviews record `historical`. Only an approved `implementation` plan
  authorizes Builder.
- `revision` — the content revision (see below).
- `ownerSessionID` — the session that owns feedback/approval routing: the
  nearest Planner ancestor, or the author session when none exists.
- `authorSessionID` — the session that wrote the current revision.

One document format is supported:

- **shared-markdown** (`art_…`): the frontmatter format below, canonical
  revision, per-revision author provenance, immutable snapshots.

## Paths

- Source (chezmoi-managed): `~/.local/share/chezmoi/dot_config/opencode/plugins/plan-bridge/`
- Live (applied target): `~/.config/opencode/plugins/plan-bridge/`
- Registry state: `$XDG_STATE_HOME/opencode/plan-bridge/` (fallback
  `~/.local/state/opencode/plan-bridge/`), one directory per artifact under
  `artifacts/<id>/` containing the authoritative `record.json`, the stable
  `current.md`, and immutable snapshots under `revisions/`.

Files: `store.mjs` (Node-compatible registry logic, testable without Bun),
`format.mjs` + `format-fixtures.json` (shared Markdown format specification,
canonical revision algorithm, pinned cross-implementation fixtures),
`artifact-rpc.ts` (RPC contract), `index.ts` (tool + RPC registration and
delivery), `artifact-tools.ts` (tool logic, provenance resolution, compact
message builders), tests `store.test.mjs`, `format.test.mjs`,
`artifact-tools.test.mjs`
(`node --test dot_config/opencode/plugins/plan-bridge/…` from the chezmoi
working directory).

## shared-markdown

A shared artifact document is UTF-8/LF text:

- an opening `---` fence line, exactly nine header lines in fixed key order
  (`id`, `kind`, `title`, `description`, `owner_session_id`,
  `author_session_id`, `created_at`, `updated_at`, `status`), each
  `<key>: ` + `JSON.stringify(value)` (single-line JSON string scalars),
- a closing `---` fence line terminated by LF,
- the body Markdown afterwards, stored verbatim (no H1 inserted, final
  newline distinction preserved).

Parsing is strict: duplicate, missing, unknown, or out-of-order fields,
malformed or non-canonical scalars, and any other header syntax are rejected
(`format-fixtures.json` pins every rule byte-exactly, including rejection
tags, for the Lua implementation).

**Content revision**: the first 8 lowercase hex characters of the SHA-256
digest over the canonical input = the
seven identity header lines (`id`, `kind`, `title`, `description`,
`owner_session_id`, `author_session_id`, `created_at`, JSON string values, LF
delimiters) + a closing `---` line + the exact body bytes. `updated_at` and
`status` are validated but never hashed, so approval can flip the displayed
status without changing the content revision. The revision is never an input
to its own hash; the artifact ID is random.

## Model-facing tools

Shared artifacts (permission actions; globally denied, allowed per agent):

- `artifact_publish` — publish `kind`/`title`/`description`/`body`; plans
  start `draft` with `authority: "implementation"`, evidence and reviews
  start `published` with `authority: "historical"`. Returns the artifact ID,
  owner, author, current path, content revision, authority and immutable
  snapshot reference.
- `artifact_get` — current state by default, or an exact revision
  (`revisions/<hex>.md`) whose content carries its creation-time status header.
  Reports `Status` and `Authority`.
- `artifact_patch` — expected revision + unambiguous body replacements only,
  plus optional structured `title`/`description` updates (never frontmatter
  text edits). Identity, kind, owner, authority and timestamps are
  tool-managed; each revision records the acting author. Approved plans reject
  patches.

Authorization (`artifact-tools.ts`): the acting author is the calling session
from the tool context. The owner is the nearest Planner in the server-assigned
session ancestry (`ctx.session.get` walking `parentID`) — a Planner caller owns
its own publication; worker sessions walk to their Planner; when no Planner
ancestor is reachable (a standalone session such as the unrestricted test agent)
the author owns its own artifact. Every fetched session is validated (requested
ID, same location); an optional agent field is never guessed. Same-location
operation only; moved owners fail visibly.

## Agent roles

Planner alone assigns Search, Builder and Review, owns decisions, and
coordinates the artifact writers. Workers are launched with the `subagent` tool
(agent ID, short `description`, complete `prompt`); independent work uses
`background: true`, and the returned `sessionID` continues that same child
conversation. Runner is the shared command helper: Planner
and each worker may call it for a short bounded operation without rounding back
through Planner. Search, Runner, Builder, and Review run as catalog-visible
`mode: subagent` workers. Only Runner is callable by the workers themselves; no
worker may launch Search, Builder, or Review.

- **Planner** (primary) authors `plan` artifacts, acts on the user's approval,
  and launches Builder only from an approved `implementation` plan at the exact
  revision. It does not edit project files. It assigns Search, Builder and
  Review, and may call Runner directly for a user-facing command question.
- **Search** researches source files and documentation read-only and authors
  `evidence` artifacts. It calls Runner for command observations — foreground
  for a blocking short observation, background for independent command work —
  rather than performing general system or Git exploration itself.
- **Runner** executes only the bounded commands or operations and allowed side
  effects a caller assigns, then returns directly to that caller with a short
  result, not an artifact. It runs on its configured cheap model with no
  variant. It holds read/glob/grep and host shell authority but no edit,
  artifact, question, web-research, or subagent permission. Shell runs with host
  authority; the assignment scope is the target paths and side effects it names,
  so installs, system/Omarchy commands, resets, and destructive actions require
  explicit assignment authorization and are never inferred from an investigation
  request. Scratch work uses unique task directories under `/tmp/opencode/runner`.
- **Builder** applies the exact approved plan and runs only the checks the plan
  assigns. It holds `artifact_get` only — it reads assigned artifacts but cannot
  author them. It keeps direct shell for its assigned checks and may offload a
  check or short command observation to Runner within the assignment; delegation
  never authorizes new project mutations, installations, or broader
  investigation.
- **Review** independently inspects the captured Builder change scope read-only,
  authors `review` artifacts, and may call Runner for scoped tests or
  Git/runtime observations with an explicit working directory and side effects.
  It has no project edit or direct shell permission and does not repair or
  install anything beyond the review assignment.

Canonical artifact tool arguments: `artifact_publish` takes
`kind`/`title`/`description`/`body`; `artifact_get` takes `artifactID` with an
optional `revision`; `artifact_patch` takes `artifactID`/`expectedRevision`
with optional `replacements`, `title`, and `description`. Owner and author are
derived from the calling session and its Planner ancestry, never supplied by the
caller.

## RPC contract

`personal.artifacts` (outputs use `artifacts`/`artifact` and include
`authority`):
`list` — summaries with kind, description, provenance, authority and format
marker;
`get` — current state or an exact revision/snapshot reference;
`feedback` — question/selection against the displayed content revision;
`approve` — plans only (evidence/review kinds are rejected); validates the
displayed revision under lock, records that exact revision, and regenerates the
current frontmatter with `status: approved` without changing the content
revision;
`retry_delivery` — redeliver a recorded submission by request ID.

Errors are declared responses (`validation`, `not_found`, `stale_revision`,
`forbidden`, `approved`, `patch_conflict`, `lock_conflict`, `io`), not
arbitrary thrown errors. Every lookup is scoped to the artifact's recorded
location.

## Storage, snapshots and recovery

- record.json is authoritative and written last. Snapshots are immutable
  (`0400`) and hold the complete document as of revision creation; history in
  the record is lean metadata (revision, createdAt, authorSessionID) with
  snapshot references — bodies are never duplicated per revision.
- List summaries and describe-style reads touch record.json only; content
  always requires a snapshot read. A missing authoritative snapshot fails
  visibly (`io`) instead of fabricating content.
- After an interrupted write, the next mutation reconciles derived files:
  current.md is regenerated from the committed snapshot and lifecycle state
  (status/updated_at from the record, author from the current revision). A
  snapshot header keeps its creation-time status; the registry/current view
  carries current approval status.
- Manual frontmatter edits never authorize or reopen anything; the recorded
  approval decision is the only authorization, and patching an approved plan
  is rejected.

## Feedback / approval semantics

- Submissions deduplicate by a client-generated `requestID`; a repeated
  submission returns the recorded one instead of creating a duplicate.
- Feedback and approval carry the revision the user was actually viewing;
  stale requests are rejected instead of being applied silently.
- An approval freezes the exact revision it was recorded against. Only a plan
  whose authority is `implementation` then authorizes Builder.
- Byte limits: question ≤ 16384 UTF-8 bytes, selected excerpt ≤ 65536 UTF-8
  bytes; oversized input is rejected with a `validation` error and leaves no
  submission behind.

## Delivery (synthetic, honest, retryable)

A submission is persisted first, then a message is durably admitted to the
owning session via `ctx.session.synthetic` with explicit
`delivery: "queue"` and `resume: true` (admission and scheduling, not model
completion). The compact builders emit:

- `description` — short title-bearing UI label rendered after the synthetic
  event marker (e.g. `Artifact feedback: <title>`).
- `text` — model-visible: feedback carries the artifact `ID@revision`, the user
  question, and exactly one optional context representation (quoted selected
  excerpt, otherwise the selected line range, otherwise general feedback).
  Approval text is at most two lines: an `implementation` approval names the
  approved `artifactID@revision` and that the Planner should launch ONE
  background Builder for that exact revision; a `historical` approval states
  the freeze and that it does not authorize Builder.
- `metadata` — model-invisible bookkeeping: `artifactID`, `revision`,
  `requestID`, `kind`, `authority`, `submission`, `source`.

Delivery state is recorded per submission (`pending` → `delivered` |
`failed`) with the original request IDs, so failed deliveries can be retried
after editor restarts with the same request ID. Delivery is
**at-least-once, not exactly-once**; a crash between persistence and
admission can leave `pending`, and an explicit retry may re-send. Failure is
reported (`delivery.state: "failed"`), never guessed around; admission
failures are reported as unknown-admission to the client.

## Stale locks

Mutations hold an exclusive per-artifact lock file
(`artifacts/<id>/lock`). An existing lock is reported as a `lock_conflict`
error — it is never bypassed. If a mutation crashed while holding the lock,
the lock file is stale: remove `artifacts/<id>/lock` by hand and retry. The
registry record is never discarded; the next mutation reconciles the derived
files from the authoritative record, so an interrupted write self-heals
without data loss (subject to the visible-failure rule for lost snapshots
above).

## Neovim side

`~/.config/nvim/lua/editor/features/opencode-artifacts.lua`
(`NVOpenCodeArtifacts`, with the shared-markdown implementation in
`lua/editor/features/opencode-artifacts/format.lua`) targets the generic RPC
(`personal.artifacts`) and reads shared-markdown artifacts (canonical
revisions). The picker
exposes `:OpenCodePlans` (draft plans by default), `:OpenCodeEvidence`,
`:OpenCodeReviews`, `:OpenCodeArtifacts` on `<leader>ap/ae/ar/aa`, with `<M-a>`
to include approved artifacts and `<M-r>` to retry a recorded-but-undelivered
feedback/approval submission from the persisted server record. Artifact
buffers carry only `OpenCodeArtifactFeedback`, `OpenCodeArtifactRetryDelivery`
and — on draft plans — `OpenCodeArtifactApprove` (plus `<leader>af` and, on
draft plans, `<leader>ay`). Start a fresh Neovim instance after updating.

Requests go through `opencode api` with argv lists and JSON-encoded bodies;
user-selected Markdown is never interpolated into shell commands.
