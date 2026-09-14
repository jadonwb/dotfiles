// V2 plugin: shared artifacts.
//
// Registers the shared-artifact tools (artifact_publish, artifact_get,
// artifact_patch) and the personal.artifacts RPC contract so Neovim can list
// artifacts, ask questions, and record approvals.
//
// Authority: a plan artifact with status "approved" and authority
// "implementation" is the sole implementation gate. Approving a draft plan
// records the exact displayed revision; only an implementation plan authorizes
// Builder.
//
// Registry logic lives in ./store.mjs; tool/authorization logic in
// ./artifact-tools.ts; the contract lives in ./artifact-rpc.ts.
// The location is captured once at setup (tool contexts have no directory),
// and the owner is resolved from server-assigned session ancestry, never a
// caller-supplied destination.
//
// Delivery uses ctx.session.synthetic with explicit delivery "queue" and
// resume true: durably admitted to the owning session, compact UI label in
// the description, model-visible text carrying the artifact ID@revision, and
// bookkeeping (request IDs, provenance) in metadata only.
import { randomUUID } from "node:crypto"

import { createStore, StoreError } from "./store.mjs"
import { Artifacts } from "./artifact-rpc.ts"
import {
  addArtifactTools,
  artifactApprovalMessage,
  artifactDeliveryDescription,
  artifactDeliveryMetadata,
  artifactFeedbackMessage,
} from "./artifact-tools.ts"

export default {
  id: "personal.artifact-registry",
  async setup(ctx) {
    const directory = ctx.location.directory
    const store = createStore()
    // In-process guard so concurrent duplicate submissions of the same
    // request ID share one delivery attempt. Delivery is at-least-once:
    // a crash between persistence and admission can require an explicit
    // retry, which may re-send the message.
    const inFlight = new Map<string, Promise<{ state: string; error: string | null }>>()

    function mintRequestID(requestID: unknown): string {
      if (requestID === undefined || requestID === null || requestID === "") {
        return `req_${randomUUID().replaceAll("-", "")}`
      }
      return requestID
    }

    function rpcError(context: { error: (type: string, message: string, data?: unknown) => never }, error: unknown): never {
      if (error instanceof StoreError) {
        throw context.error(error.code, error.message, error.data)
      }
      throw error
    }

    async function deliverToOwner(input: {
      submission: "feedback" | "approval"
      artifactID: string
      kind: string
      title: string
      revision: string
      authority: string
      requestID: string
      ownerSessionID: string
      question?: string | null
      selectedText?: string | null
      selectedRange?: { start: number; end: number } | null
    }): Promise<{ state: string; error: string | null }> {
      const existing = inFlight.get(input.requestID)
      if (existing) return existing
      // Compact shared builders: the model sees the artifact ID@revision, the
      // user question and exactly one context representation; request IDs and
      // provenance stay in the persisted record and message metadata.
      const text =
        input.submission === "approval"
          ? artifactApprovalMessage({
              authority: input.authority,
              artifactID: input.artifactID,
              revision: input.revision,
            })
          : artifactFeedbackMessage({
              kind: input.kind,
              title: input.title,
              artifactID: input.artifactID,
              revision: input.revision,
              question: input.question,
              selectedText: input.selectedText,
              selectedRange: input.selectedRange,
            })
      const description = artifactDeliveryDescription({ action: input.submission, title: input.title })
      const metadata = artifactDeliveryMetadata({
        artifactID: input.artifactID,
        revision: input.revision,
        requestID: input.requestID,
        kind: input.kind,
        authority: input.authority,
        submission: input.submission,
      })
      const markDelivery = store.markArtifactDelivery
      const attempt = (async () => {
        try {
          // Durably admitted to the owning session as a queued synthetic
          // message that resumes the session; resolves after admission and
          // scheduling, not after the model completes its turn.
          await ctx.session.synthetic({
            sessionID: input.ownerSessionID,
            text,
            description,
            metadata,
            delivery: "queue",
            resume: true,
          })
          await markDelivery({
            artifactID: input.artifactID,
            location: directory,
            requestID: input.requestID,
            state: "delivered",
          })
          return { state: "delivered", error: null }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          await markDelivery({
            artifactID: input.artifactID,
            location: directory,
            requestID: input.requestID,
            state: "failed",
            error: message,
          }).catch(() => {})
          return { state: "failed", error: message }
        } finally {
          inFlight.delete(input.requestID)
        }
      })()
      inFlight.set(input.requestID, attempt)
      return attempt
    }

    await ctx.tool.transform((editor) => {
      // Artifact tools: role/kind authorization and owner resolution live
      // in ./artifact-tools.ts.
      addArtifactTools(editor, {
        store,
        directory,
        getSession: (input) => ctx.session.get(input),
      })
    })

    await ctx.rpc.register(Artifacts, {
      list: async (_input, context) => {
        try {
          return { artifacts: await store.listArtifacts({ location: directory }) }
        } catch (error) {
          rpcError(context, error)
        }
      },

      get: async (input, context) => {
        try {
          return {
            artifact: await store.getArtifact({
              artifactID: input.artifactID,
              location: directory,
              revision: input.revision,
            }),
          }
        } catch (error) {
          rpcError(context, error)
        }
      },

      feedback: async (input, context) => {
        const requestID = mintRequestID(input.requestID)
        let submission
        try {
          submission = await store.addArtifactFeedback({
            artifactID: input.artifactID,
            location: directory,
            revision: input.revision,
            requestID,
            question: input.question,
            selectedText: input.selectedText,
            selectedRange: input.selectedRange,
          })
        } catch (error) {
          rpcError(context, error)
        }
        if (submission.deduplicated && submission.delivery.state === "delivered") {
          return {
            requestID,
            kind: "feedback",
            deduplicated: true,
            delivery: submission.delivery,
            artifact: submission.artifact,
          }
        }
        const delivery = await deliverToOwner({
          submission: "feedback",
          artifactID: submission.artifact.id,
          kind: submission.artifact.kind,
          title: submission.artifact.title,
          revision: submission.feedback.revision,
          authority: submission.artifact.authority,
          requestID,
          ownerSessionID: submission.artifact.ownerSessionID,
          question: submission.feedback.question,
          selectedText: submission.feedback.selectedText,
          selectedRange: submission.feedback.selectedRange,
        })
        return { requestID, kind: "feedback", deduplicated: submission.deduplicated, delivery, artifact: submission.artifact }
      },

      approve: async (input, context) => {
        const requestID = mintRequestID(input.requestID)
        let submission
        try {
          submission = await store.approveArtifact({
            artifactID: input.artifactID,
            location: directory,
            revision: input.revision,
            requestID,
          })
        } catch (error) {
          rpcError(context, error)
        }
        if (submission.deduplicated && submission.delivery.state === "delivered") {
          return {
            requestID: submission.requestID,
            kind: "approval",
            deduplicated: true,
            delivery: submission.delivery,
            artifact: submission.artifact,
          }
        }
        const delivery = await deliverToOwner({
          submission: "approval",
          artifactID: submission.artifact.id,
          kind: submission.artifact.kind,
          title: submission.artifact.title,
          revision: submission.approval.revision,
          authority: submission.artifact.authority,
          requestID: submission.requestID,
          ownerSessionID: submission.artifact.ownerSessionID,
        })
        return {
          requestID: submission.requestID,
          kind: "approval",
          deduplicated: submission.deduplicated,
          delivery,
          artifact: submission.artifact,
        }
      },

      retry_delivery: async (input, context) => {
        let record
        try {
          record = await store.getArtifact({ artifactID: input.artifactID, location: directory })
        } catch (error) {
          rpcError(context, error)
        }
        const feedbackEntry = record.feedback.find((entry) => entry.requestID === input.requestID)
        const isApproval = !feedbackEntry && record.approval && record.approval.requestID === input.requestID
        const entry = feedbackEntry ?? (isApproval ? record.approval : undefined)
        if (!entry) {
          throw context.error("not_found", `No feedback or approval submission with request ID ${input.requestID}`, {
            artifactID: input.artifactID,
            requestID: input.requestID,
          })
        }
        if (entry.delivery.state === "delivered") {
          return { requestID: input.requestID, kind: isApproval ? "approval" : "feedback", deduplicated: true, delivery: entry.delivery, artifact: record }
        }
        const delivery = await deliverToOwner({
          submission: isApproval ? "approval" : "feedback",
          artifactID: record.id,
          kind: record.kind,
          title: record.title,
          revision: entry.revision,
          authority: record.authority,
          requestID: input.requestID,
          ownerSessionID: record.ownerSessionID,
          question: entry.question,
          selectedText: entry.selectedText,
          selectedRange: entry.selectedRange,
        })
        return { requestID: input.requestID, kind: isApproval ? "approval" : "feedback", deduplicated: false, delivery, artifact: record }
      },
    })
  },
}
