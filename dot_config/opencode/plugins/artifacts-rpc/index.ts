// Artifact RPC adapter: the Neovim-facing half of the artifact registry.
//
// Storage and agent tools stay in ../artifacts. This plugin only exposes the
// registry over RPC (personal.artifacts) and registers that domain through the
// bridge. The adapter stays separate, so the artifact tools remain independent
// of bridge code.
//
// Delivery resolves stored session identities (owner or writer) and records the
// outcome; mark_read records the read without a delivery.

import { Artifacts } from "../artifacts/artifact-rpc.ts";
import { createStore, StoreError } from "../artifacts/store.mjs";
import {
  artifactApprovalMessage,
  artifactDeliveryDescription,
  artifactDeliveryMetadata,
  artifactFeedbackMessage,
  type ArtifactSummary,
  type ArtifactView,
} from "../artifacts/artifact-tools.ts";
import { registerDomain, mintRequestID } from "../bridge/registry.ts";
import { projectLocation } from "../artifacts/project.mjs";

// Return the store's bookkeeping delivery object verbatim; output validation
// needs the full shape (state, attemptedAt, deliveredAt, error).
type DeliveryState = {
  state: string;
  attemptedAt: string | null;
  deliveredAt: string | null;
  error: string | null;
};

/** Frontend RPC summary: frontend metadata plus owner-scoping, never the writer session identity. */
function rpcSummaryOf(summary: ArtifactSummary) {
  const { writerSessionID: _writer, ...frontend } = summary;
  return frontend;
}

/** Frontend RPC view: same stripping as rpcSummaryOf over the full view. */
function rpcViewOf(view: ArtifactView) {
  const { writerSessionID: _writer, ...frontend } = view;
  return frontend;
}

export default {
  id: "personal.artifacts-rpc",
  async setup(ctx) {
    const directory = ctx.location.directory;
    const projectDirectory = projectLocation(directory);
    const store = createStore();

    // In-process guard so concurrent duplicate submissions of the same
    // request ID share one delivery attempt. Delivery is at-least-once.
    const inFlight = new Map<string, Promise<DeliveryState>>();

    function rpcError(
      context: {
        error: (type: string, message: string, data?: unknown) => never;
      },
      error: unknown,
    ): never {
      if (error instanceof StoreError) {
        throw context.error(error.code, error.message, error.data);
      }
      throw error;
    }

    async function deliver(input: {
      submission: "feedback" | "approval";
      artifactID: string;
      kind: string;
      title: string;
      requestID: string;
      ownerSessionID: string;
      writerSessionID?: string;
      recipient?: "owner" | "writer";
      question?: string | null;
      selectedText?: string | null;
      selectedRange?: { start: number; end: number } | null;
      // The currently frozen approval record's authoritative state; only the
      // approval branch emits it, always as kind=plan/status=approved/true.
      status?: string;
      finalized?: boolean;
    }): Promise<DeliveryState> {
      const recipient =
        input.submission === "approval"
          ? "owner"
          : input.recipient === "writer"
            ? "writer"
            : "owner";
      const targetSessionID =
        recipient === "writer"
          ? (input.writerSessionID ?? input.ownerSessionID)
          : input.ownerSessionID;
      const existing = inFlight.get(input.requestID);
      if (existing) return existing;
      const text =
        input.submission === "approval"
          ? artifactApprovalMessage({
              artifactID: input.artifactID,
              kind: input.kind,
              status: input.status ?? "",
              finalized: input.finalized ?? false,
            })
          : artifactFeedbackMessage({
              kind: input.kind,
              title: input.title,
              artifactID: input.artifactID,
              question: input.question,
              selectedText: input.selectedText,
              selectedRange: input.selectedRange,
            });
      const description = artifactDeliveryDescription({
        action: input.submission,
        title: input.title,
      });
      const metadata = artifactDeliveryMetadata({
        artifactID: input.artifactID,
        requestID: input.requestID,
        kind: input.kind,
        submission: input.submission,
        recipient,
      });
      const markDelivery = store.markArtifactDelivery;
      const attempt = (async () => {
        try {
          // Durably admitted to the target session as a queued synthetic
          // message that resumes the session; resolves after admission.
          await ctx.session.synthetic({
            sessionID: targetSessionID,
            text,
            description,
            metadata,
            delivery: "queue",
            resume: true,
          });
          const marked = await markDelivery({
            artifactID: input.artifactID,
            location: projectDirectory,
            requestID: input.requestID,
            kind: input.submission,
            state: "delivered",
          });
          return marked.delivery;
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          try {
            const marked = await markDelivery({
              artifactID: input.artifactID,
              location: projectDirectory,
              requestID: input.requestID,
              kind: input.submission,
              state: "failed",
              error: message,
            });
            return marked.delivery;
          } catch {
            // Bookkeeping itself failed; return a maximal-shape delivery so
            // the RPC response still validates.
            return {
              state: "failed",
              attemptedAt: new Date().toISOString(),
              deliveredAt: null,
              error: message,
            };
          }
        } finally {
          inFlight.delete(input.requestID);
        }
      })();
      inFlight.set(input.requestID, attempt);
      return attempt;
    }

    await registerDomain(ctx, {
      contract: Artifacts,
      description: "Durable plans, evidence, and reviews.",
      handlers: {
        list: async (_input, context) => {
          try {
            const artifacts = await store.listArtifacts({
              location: projectDirectory,
            });
            return { artifacts: artifacts.map(rpcSummaryOf) };
          } catch (error) {
            rpcError(context, error);
          }
        },

        get: async (input, context) => {
          try {
            return {
              artifact: rpcViewOf(
                await store.getArtifact({
                  artifactID: input.artifactID,
                  location: projectDirectory,
                }),
              ),
            };
          } catch (error) {
            rpcError(context, error);
          }
        },

        feedback: async (input, context) => {
          const requestID = mintRequestID(input.requestID);
          const recipient = input.recipient === "writer" ? "writer" : "owner";
          let submission;
          try {
            submission = await store.addArtifactFeedback({
              artifactID: input.artifactID,
              location: projectDirectory,
              requestID,
              question: input.question,
              selectedText: input.selectedText,
              selectedRange: input.selectedRange,
              recipient,
            });
          } catch (error) {
            rpcError(context, error);
          }
          if (
            submission.deduplicated &&
            submission.delivery.state === "delivered"
          ) {
            return {
              requestID,
              kind: "feedback",
              deduplicated: true,
              delivery: submission.delivery,
              artifact: rpcSummaryOf(submission.artifact),
            };
          }
          // Recipient is resolved only from the stored session identities and is
          // recorded with the submission; a target that cannot be reached is
          // recorded as a failed delivery.
          const delivery = await deliver({
            submission: "feedback",
            artifactID: submission.artifact.id,
            kind: submission.artifact.kind,
            title: submission.artifact.title,
            requestID,
            ownerSessionID: submission.artifact.ownerSessionID,
            writerSessionID: submission.artifact.writerSessionID,
            recipient:
              submission.feedback.recipient === "writer" ? "writer" : "owner",
            question: submission.feedback.question,
            selectedText: submission.feedback.selectedText,
            selectedRange: submission.feedback.selectedRange,
          });
          return {
            requestID,
            kind: "feedback",
            deduplicated: submission.deduplicated,
            delivery,
            artifact: rpcSummaryOf(submission.artifact),
          };
        },

        approve_plan: async (input, context) => {
          const requestID = mintRequestID(input.requestID);
          let submission;
          try {
            submission = await store.approveArtifact({
              artifactID: input.artifactID,
              location: projectDirectory,
              requestID,
            });
          } catch (error) {
            rpcError(context, error);
          }
          if (
            submission.deduplicated &&
            submission.delivery.state === "delivered"
          ) {
            return {
              requestID: submission.requestID,
              kind: "approval",
              deduplicated: true,
              delivery: submission.delivery,
              artifact: rpcSummaryOf(submission.artifact),
            };
          }
          // The store gates approval to plan kind and readiness (a finalized
          // draft), so delivery here is always a plan approval to the owner; the
          // payload carries the frozen record's authoritative fields verbatim.
          const delivery = await deliver({
            submission: "approval",
            artifactID: submission.artifact.id,
            kind: submission.artifact.kind,
            title: submission.artifact.title,
            requestID: submission.requestID,
            ownerSessionID: submission.artifact.ownerSessionID,
            writerSessionID: submission.artifact.writerSessionID,
            status: submission.artifact.status,
            finalized: submission.artifact.finalized,
          });
          return {
            requestID: submission.requestID,
            kind: "approval",
            deduplicated: submission.deduplicated,
            delivery,
            artifact: rpcSummaryOf(submission.artifact),
          };
        },

        mark_read: async (input, context) => {
          const requestID = mintRequestID(input.requestID);
          let submission;
          try {
            submission = await store.markArtifactRead({
              artifactID: input.artifactID,
              location: projectDirectory,
              requestID,
            });
          } catch (error) {
            rpcError(context, error);
          }
          // Evidence/review dismissal only: the read is recorded locally.
          return {
            requestID: submission.requestID,
            kind: "read",
            deduplicated: submission.deduplicated,
            artifact: rpcSummaryOf(submission.artifact),
          };
        },

        retry_plan_delivery: async (input, context) => {
          let record;
          try {
            record = await store.getArtifact({
              artifactID: input.artifactID,
              location: projectDirectory,
            });
          } catch (error) {
            rpcError(context, error);
          }
          if (record.kind !== "plan") {
            throw context.error(
              "invalid_kind",
              `Retry delivery applies to plan approvals only; ${input.artifactID} is a ${record.kind}`,
              {
                artifactID: input.artifactID,
                kind: record.kind,
              },
            );
          }
          const entry =
            record.approval && record.approval.requestID === input.requestID
              ? record.approval
              : undefined;
          if (!entry) {
            throw context.error(
              "not_found",
              `No plan-approval submission with request ID ${input.requestID}`,
              {
                artifactID: input.artifactID,
                requestID: input.requestID,
              },
            );
          }
          if (entry.delivery.state === "delivered") {
            return {
              requestID: input.requestID,
              kind: "approval",
              deduplicated: true,
              delivery: entry.delivery,
              artifact: rpcViewOf(record),
            };
          }
          const delivery = await deliver({
            submission: "approval",
            artifactID: record.id,
            kind: record.kind,
            title: record.title,
            requestID: input.requestID,
            ownerSessionID: record.ownerSessionID,
            writerSessionID: record.writerSessionID,
            status: record.status,
            finalized: record.finalized,
          });
          return {
            requestID: input.requestID,
            kind: "approval",
            deduplicated: false,
            delivery,
            artifact: rpcViewOf(record),
          };
        },
      },
    });
  },
};
