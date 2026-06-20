import type { Plugin } from "@opencode-ai/plugin"

const lastAgent = new Map<string, string>()

const TRANSITIONS: Record<string, Record<string, string>> = {
  orchestrate: {
    execute: `Your operational mode has changed from Orchestrate to Execute. You are no longer in read-only mode. Execute the tasks with the full extent of your tools and subagents.`,
  },
  execute: {
    orchestrate: `Your operational mode has changed from Execute to Orchestrate. You are now in read-only mode, no edit tools are allowed. Orchestrate and plan with the full extent of your tools and subagents.`,
  },
}

export default (async ({ client }) => {
  return {
    "chat.message": async (input, _output) => {
      const { sessionID, agent } = input
      if (!agent) return

      const prev = lastAgent.get(sessionID)
      lastAgent.set(sessionID, agent)

      if (!prev || prev === agent) return

      const transitions = TRANSITIONS[prev]
      if (!transitions) return
      const message = transitions[agent]
      if (!message) return

      await client.session.prompt({
        path: { id: sessionID },
        body: {
          agent,
          noReply: true,
          parts: [{ type: "text", text: message }],
        },
      })
    },
  }
}) satisfies Plugin
