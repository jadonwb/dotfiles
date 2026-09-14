# plan-bridge

A filesystem-backed registry for passing Markdown artifacts between OpenCode
sessions and Neovim, and the authoritative plan-approval gate. A plan artifact
whose `artifact_get` shows `status=approved`, `kind=plan` is what authorizes
Builder.

## Artifacts

Every artifact is Markdown plus a small record, addressed by ID only:

- `id` — the `art_…` identifier.
- `kind` — `plan`, `evidence`, or `review`.
- `title` / `description` — short human-facing labels.
- `status` — plans start `draft`; evidence and reviews start `published`; a plan
  becomes `approved` when it is approved.
- `ownerSessionID` — the session that owns patch authorization and
  feedback/approval routing: the nearest Planner ancestor, or the caller when
  none exists.

There is one authoritative record per artifact and one generated read-only view.
No revisions, history, or snapshots are kept.

## Paths

- Source (chezmoi-managed):
  `~/.local/share/chezmoi/dot_config/opencode/plugins/plan-bridge/`
- Live (applied target): `~/.config/opencode/plugins/plan-bridge/`
- Registry state: `$XDG_STATE_HOME/opencode/plan-bridge/` (fallback
  `~/.local/state/opencode/plan-bridge/`), one directory per artifact under
  `artifacts/<id>/` containing the authoritative `record.json` and the generated
  `current.md` view.

Files: `store.mjs` (Node-compatible registry logic, testable without Bun),
`format.mjs` (one-way rendering of the generated view), `artifact-rpc.ts` (RPC
contract), `index.ts` (tool + RPC registration and delivery),
`artifact-tools.ts` (tool logic, owner resolution, compact message builders),
tests `store.test.mjs` and `artifact-tools.test.mjs`.

## Storage and the generated view

- `record.json` is authoritative and written last. It holds the verbatim body
  the author supplied or patched; patches always match against those bytes.
- `current.md` is a one-way rendering for display: a minimal frontmatter block
  (`id`, `kind`, `status`, `title`) followed by the verbatim body, formatted by
  Prettier over the complete document. The generated view is never parsed back
  into storage; editors read it read-only, and `artifact_get` returns its path.
- After an interrupted write the next mutation regenerates the view from the
  record. Locally created artifacts are not migrated or accepted through
  compatibility logic.

## Model-facing tools

- `artifact_publish` — publish `kind`/`title`/`description`/`body`; plans start
  `draft`, evidence and reviews start `published`. The body is stored verbatim.
  Returns the artifact ID and the generated-view path.
- `artifact_get` — read one artifact by ID. Returns the generated-view path for
  the `read` tool; it does not inline the Markdown.
- `artifact_patch` — unambiguous body replacements, plus optional structured
  `title`/`description` updates (never frontmatter text edits). Approved plans
  reject patches.

Owner resolution (`artifact-tools.ts`): the owner is the nearest Planner in the
server-assigned session ancestry (`ctx.session.get` walking `parentID`) — a
Planner caller owns its own publication; worker sessions walk to their Planner;
when no Planner ancestor is reachable (a standalone session such as the
unrestricted test agent) the caller owns its own artifact. Every fetched session
is validated (requested ID, same location). Same-location operation only; moved
owners fail visibly.

## Agent roles

Planner alone assigns Search, Builder and Review, owns decisions, and
coordinates the artifact writers. Workers are launched with the `subagent` tool
(agent ID, short `description`, complete `prompt`); independent work uses
`background: true`, and the returned `sessionID` continues that same child
conversation. Runner is the shared command helper: Planner and each worker may
call it for a short bounded operation without rounding back through Planner.
Search, Runner, Builder, and Review run as catalog-visible `mode: subagent`
workers. Only Runner is callable by the workers themselves; no worker may launch
Search, Builder, or Review.

- **Planner** (primary) authors `plan` artifacts, acts on the user's approval,
  and launches Builder only from an approved plan. It does not edit project
  files.
- **Search** researches source files and documentation read-only and authors
  `evidence` artifacts.
- **Runner** executes only the bounded commands or operations a caller assigns
  and returns a short result, not an artifact.
- **Builder** applies the exact approved plan and runs only the checks the plan
  assigns. It holds `artifact_get` only.
- **Review** independently inspects the captured Builder change scope read-only,
  authors `review` artifacts, and may call Runner for scoped observations.

Canonical artifact tool arguments: `artifact_publish` takes
`kind`/`title`/`description`/`body`; `artifact_get` takes `artifactID`;
`artifact_patch` takes `artifactID` with optional `replacements`, `title`, and
`description`. The owner is derived from the calling session and its Planner
ancestry, never supplied by the caller.

## RPC contract

`personal.artifacts` (outputs use `artifacts`/`artifact`): `list` — summaries
with kind, description, owner and status; `get` — the latest generated view for
one artifact ID; `feedback` — question/selection against one artifact ID;
`approve` — plans only (evidence/review kinds are rejected), sets
`status: approved`, and freezes patches; `retry_delivery` — redeliver a recorded
submission by request ID.

Errors are declared responses (`validation`, `not_found`, `forbidden`,
`approved`, `patch_conflict`, `lock_conflict`, `io`), not arbitrary thrown
errors. Every lookup is scoped to the artifact's recorded location.

## Feedback / approval semantics

- Submissions deduplicate by a client-generated `requestID`; a repeated
  submission returns the recorded one instead of creating a duplicate.
- An approval is the recorded decision that authorizes Builder; an approved plan
  then rejects further patches.
- Byte limits: question ≤ 16384 UTF-8 bytes, selected excerpt ≤ 65536 UTF-8
  bytes; oversized input is rejected with a `validation` error and leaves no
  submission behind.

## Delivery (synthetic, honest, retryable)

A submission is persisted first, then a message is durably admitted to the
owning session via `ctx.session.synthetic` with explicit `delivery: "queue"` and
`resume: true` (admission and scheduling, not model completion). The compact
builders emit:

- `description` — short title-bearing UI label rendered after the synthetic
  event marker (e.g. `Feedback: <title>`).
- `text` — model-visible: feedback names the artifact ID, the user question, and
  exactly one optional context representation (quoted selected excerpt,
  otherwise the selected line range, otherwise general feedback). Approval text
  is one line naming the approved artifact ID.
- `metadata` — model-invisible bookkeeping: `artifactID`, `requestID`, `kind`,
  `submission`, `source`.

Delivery state is recorded per submission (`pending` → `delivered` | `failed`),
so failed deliveries can be retried after editor restarts with the same request
ID. Delivery is **at-least-once, not exactly-once**.

## Stale locks

Mutations hold an exclusive per-artifact lock file (`artifacts/<id>/lock`). An
existing lock is reported as a `lock_conflict` error — it is never bypassed. If
a mutation crashed while holding the lock, the lock file is stale: remove
`artifacts/<id>/lock` by hand and retry. The record is never discarded.

## Tests

Standalone tests run on the repository's mise-managed Node 22 (the plugin itself
runs under OpenCode's embedded Bun, but the tests do not need Bun and no Bun
installation or scripts are added):

```
mise exec -- node --experimental-strip-types --test \
  dot_config/opencode/plugins/plan-bridge/store.test.mjs \
  dot_config/opencode/plugins/plan-bridge/artifact-tools.test.mjs
```

## Neovim side

`~/.config/nvim/lua/editor/features/opencode-artifacts.lua`
(`NVOpenCodeArtifacts`) targets the generic RPC (`personal.artifacts`) and opens
each artifact's generated `current.md` read-only. The picker exposes
`:OpenCodePlans` (draft plans by default), `:OpenCodeEvidence`,
`:OpenCodeReviews`, `:OpenCodeArtifacts` on `<leader>ap/ae/ar/aa`, with `<M-a>`
to include approved artifacts and `<M-r>` to retry a recorded-but-undelivered
feedback/approval submission. Artifact buffers carry only
`OpenCodeArtifactFeedback`, `OpenCodeArtifactRetryDelivery` and — on draft plans
— `OpenCodeArtifactApprove` (plus `<leader>af` and, on draft plans,
`<leader>ay`). Start a fresh Neovim instance after updating.

Requests go through `opencode api` with argv lists and JSON-encoded bodies;
user-selected Markdown is never interpolated into shell commands.
