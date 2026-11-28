import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import {
  SyntaxStyle,
  TextAttributes,
  type BoxRenderable,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core"
import { createEffect, createSignal, onCleanup, onMount, Show } from "solid-js"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"

// Replaces the built-in opencode.btw plugin, which is disabled in cli.json.
const PANEL = "jadon.side-chat"
const MAX_HISTORY_TURNS = 8
// Listed first in the model picker: the subscription that runs workers.
const PREFERRED_PROVIDER = "opencode-go"

const DEFAULT_KEYS = {
  ask: "alt+a",
  toggle: "alt+l",
  focus: "alt+f",
  panelAsk: "a",
  hide: "escape,q",
  close: "x",
  fullscreen: "f",
  model: "alt+m",
  panelModel: "m",
  lineUp: "alt+k",
  lineDown: "alt+j",
  messagePrevious: "alt+shift+k",
  messageNext: "alt+shift+j",
  home: "g,home",
  end: "shift+g,end",
  dialogCancel: "escape",
} as const
type PanelKeys = Record<keyof typeof DEFAULT_KEYS, string | false>

type PermissionRule = { action: string; resource: string; effect: "allow" | "deny" | "ask" }

const INSTRUCTIONS = [
  "The user is asking a quick side question about the conversation so far.",
  "Treat the inherited conversation as reference context; the side question is your current task.",
  "Answer directly and concisely in markdown.",
  "You may use read-only lookups (read, glob, grep, webfetch, websearch) when the answer depends on a current fact or a workspace file.",
  "Do not modify files, run shell commands, start subagents, or take any other action.",
  "Do not continue or complete work from the main conversation.",
].join(" ")

// Rules apply in order and the last match wins. The broad deny comes first, the
// allows follow, and the `.env` deny sits after them so a broad read cannot
// expose secrets. `.env.example` is the deliberate exception.
const READ_ONLY_PERMISSIONS: PermissionRule[] = [
  { action: "*", resource: "*", effect: "deny" },
  { action: "read", resource: "*", effect: "allow" },
  { action: "glob", resource: "*", effect: "allow" },
  { action: "grep", resource: "*", effect: "allow" },
  { action: "webfetch", resource: "*", effect: "allow" },
  { action: "websearch", resource: "*", effect: "allow" },
  { action: "read", resource: "*.env", effect: "deny" },
  { action: "read", resource: "*.env.*", effect: "deny" },
  { action: "read", resource: "*.env.example", effect: "allow" },
  { action: "external_directory", resource: "*", effect: "deny" },
]

type Turn = { question: string; answer: string; at: number }
type SideModel = { providerID: string; id: string; variant?: string }
// The subset of SessionMessageInfo the context estimate reads.
type SideMessage = {
  type: string
  text?: string
  content?: Array<{
    type: string
    text?: string
    name?: string
    state?: { input?: unknown }
  }>
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
  status?: string
  summary?: string
  recent?: string
}
type CompactionConfig = { buffer: number | string }
type Thread = {
  turns: Turn[]
  pending?: string
  streaming?: string
  sessionID?: string
  model?: SideModel
  error?: string
  contextTokens?: number
  contextLimit?: number
}
type State = { threads: Record<string, Thread> }

// Compaction settings are per directory and change only when config reloads.
const compactionCache = new Map<string, Promise<CompactionConfig>>()

export default Plugin.define({
  id: "jadon.side-chat",
  setup(context) {
    const [state, update] = context.storage.store<State>("aside", { initial: { threads: {} } })
    const [panelFocused, setPanelFocused] = createSignal(false)
    let focusPanelAction: (() => void) | undefined
    const resetPanelWidth = () => {
      const root = process.env.XDG_STATE_HOME ?? `${homedir()}/.local/state`
      const file = `${root}/opencode/${context.app.channel}/tui/layout.json`
      try {
        const data = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>
        delete data.paneWidth
        delete data.terminalWidth
        writeFileSync(`${file}.tmp`, JSON.stringify(data))
        renameSync(`${file}.tmp`, file)
      } catch {
        // No saved width; the panel already uses the default.
      }
    }

    const [dialogOpen, setDialogOpen] = createSignal(false)
    const [pickerOpen, setPickerOpen] = createSignal(false)
    const overrides = (context.options.keys ?? {}) as Record<string, string | false>
    const key = (id: string, fallback: string) => overrides[id] ?? fallback
    const keys: PanelKeys = {
      ask: key("session.aside", DEFAULT_KEYS.ask),
      toggle: key("session.aside.toggle", DEFAULT_KEYS.toggle),
      focus: key("session.aside.focus", DEFAULT_KEYS.focus),
      panelAsk: key("session.aside.ask", DEFAULT_KEYS.panelAsk),
      hide: key("session.aside.hide", DEFAULT_KEYS.hide),
      close: key("session.aside.close", DEFAULT_KEYS.close),
      fullscreen: key("session.aside.fullscreen", DEFAULT_KEYS.fullscreen),
      model: key("session.aside.model", DEFAULT_KEYS.model),
      panelModel: key("session.aside.model.panel", DEFAULT_KEYS.panelModel),
      lineUp: key("session.aside.line.up", DEFAULT_KEYS.lineUp),
      lineDown: key("session.aside.line.down", DEFAULT_KEYS.lineDown),
      messagePrevious: key("session.aside.message.previous", DEFAULT_KEYS.messagePrevious),
      messageNext: key("session.aside.message.next", DEFAULT_KEYS.messageNext),
      home: key("session.aside.home", DEFAULT_KEYS.home),
      end: key("session.aside.end", DEFAULT_KEYS.end),
      dialogCancel: key("session.aside.dialog.cancel", DEFAULT_KEYS.dialogCancel),
    }
    const theme = context.theme
    // The host renderer owns the SyntaxStyle; destroy it when the plugin unloads.
    const syntax = SyntaxStyle.fromStyles(
      {
        default: { fg: theme.text.base },
        comment: { fg: theme.syntax.comment },
        keyword: { fg: theme.syntax.keyword },
        function: { fg: theme.syntax.function },
        variable: { fg: theme.syntax.variable },
        string: { fg: theme.syntax.string },
        number: { fg: theme.syntax.number },
        type: { fg: theme.syntax.type },
        operator: { fg: theme.syntax.operator },
        punctuation: { fg: theme.syntax.punctuation },
      },
      context.renderer.nativeScene,
    )

    // A side thread is exactly one archived fork of the main session, so it
    // inherits the conversation up to that point and streams text deltas like a
    // normal session.
    const sideToMain = new Map<string, string>()
    for (const [mainSessionID, thread] of Object.entries(state.threads)) {
      if (thread.sessionID) sideToMain.set(thread.sessionID, mainSessionID)
    }
    const streamParts = new Map<string, Map<number, string>>()

    type ModelEntry = NonNullable<ReturnType<Context["data"]["location"]["model"]["list"]>>[number]
    const [modelVersion, setModelVersion] = createSignal(0)
    let cachedModels: ModelEntry[] = []
    let cachedProviders = new Map<string, string>()

    const normalizeModel = (model: SideModel): SideModel => ({
      providerID: model.providerID,
      id: model.id,
      variant: model.variant && model.variant !== "default" ? model.variant : undefined,
    })

    const sessionModel = (sessionID: string): SideModel | undefined => {
      const model = context.data.session.get(sessionID)?.model
      if (model) return normalizeModel({ providerID: model.providerID, id: model.id, variant: model.variant })
      const current = context.ui.model.current()
      if (!current) return undefined
      return normalizeModel({ providerID: current.providerID, id: current.modelID, variant: current.variant })
    }

    const sessionLocation = (sessionID: string) => {
      const directory = context.data.session.get(sessionID)?.location?.directory
      return directory ? { directory } : context.location
    }

    const loadModelList = async (sessionID: string) => {
      const location = sessionLocation(sessionID)
      await Promise.all([
        context.data.location.model.sync(location),
        context.data.location.provider.sync(location),
      ])
      const models = context.data.location.model.list(location) ?? []
      const providers = new Map(
        (context.data.location.provider.list(location) ?? []).map((provider) => [provider.id, provider.name]),
      )
      cachedModels = models
      cachedProviders = providers
      setModelVersion(modelVersion() + 1)
      return { models, providers }
    }

    // A numeric buffer is a token count; a percentage string is a share of the
    // usable window. Anything else falls back to the 15% default.
    const parseBuffer = (value: number | string) => {
      if (typeof value === "number") return value
      const match = /^([\d.]+)%$/.exec(value.trim())
      return match ? Number(match[1]) / 100 : 0.15
    }

    const loadCompaction = (sessionID: string) => {
      const location = sessionLocation(sessionID)
      const directory = location?.directory
      const key = directory ?? ""
      const cached = compactionCache.get(key)
      if (cached) return cached
      const pending = (async (): Promise<CompactionConfig> => {
        const result: CompactionConfig = { buffer: "15%" }
        const entries = await context.client.config.get(directory ? { location: { directory } } : undefined)
        // Documents are ordered lowest to highest precedence; the last one wins.
        for (const entry of entries ?? []) {
          if (entry.type !== "document") continue
          const buffer = entry.info?.compaction?.buffer
          if (typeof buffer === "number" || typeof buffer === "string") result.buffer = buffer
        }
        return result
      })()
      compactionCache.set(key, pending)
      pending.catch(() => compactionCache.delete(key))
      return pending
    }

    // The side chat never compacts. `threshold` is where OpenCode would start
    // compacting; the guard reserves the buffer share, an extra margin, and the
    // answer's own output, and a prompt is refused past that point.
    const budgetFor = (model: ModelEntry, cfg: CompactionConfig) => {
      const usable = model.limit?.input ?? model.limit?.context ?? 0
      const free = Math.max(
        typeof cfg.buffer === "number" ? cfg.buffer : Math.round(usable * parseBuffer(cfg.buffer)),
        16_000,
      )
      const threshold = Math.max(0, usable - free)
      const margin = Math.max(8_000, Math.round(usable * 0.08))
      const reserve = Math.min(model.limit?.output ?? 8_000, 16_000)
      return { usable, threshold, margin, reserve }
    }

    // The usable ceiling for a side prompt: everything the next request adds,
    // plus its answer, has to stay below this.
    const ceilingFor = (budget: { threshold: number; margin: number }) =>
      budget.threshold - budget.margin

    // A model with no declared window has no compaction point, matching
    // OpenCode, so there is nothing to guard.
    const fits = (
      budget: { threshold: number; margin: number; reserve: number },
      tokens: number,
      question = "",
    ) =>
      budget.threshold <= 0 ||
      tokens + budget.reserve + Math.ceil(question.length / 4) <= ceilingFor(budget)

    const formatTokens = (value: number) =>
      value >= 1_000 ? `${Math.round(value / 1_000)}K` : String(value)

    const sumTokens = (tokens: SideMessage["tokens"]) => {
      if (!tokens) return 0
      return (
        (tokens.input ?? 0) +
        (tokens.output ?? 0) +
        (tokens.reasoning ?? 0) +
        (tokens.cache?.read ?? 0) +
        (tokens.cache?.write ?? 0)
      )
    }

    const messageChars = (msg: SideMessage) => {
      switch (msg.type) {
        case "user":
        case "synthetic":
          return msg.text?.length ?? 0
        case "assistant": {
          let chars = 0
          for (const part of msg.content ?? []) {
            if (part.type === "text") chars += part.text?.length ?? 0
            else if (part.type === "tool") {
              chars += part.name?.length ?? 0
              if (part.state?.input !== undefined) {
                chars += JSON.stringify(part.state.input).slice(0, 400).length
              }
            }
          }
          return chars
        }
        case "system":
          return (msg.text ?? "").slice(0, 2_000).length
        case "compaction":
          if (msg.status !== "completed") return 0
          return (msg.summary?.length ?? 0) + (msg.recent?.length ?? 0)
        default:
          return 0
      }
    }

    // Estimate from the last assistant token usage plus the messages after it.
    // Archived side sessions are not always cached, so the message list is
    // synced first. `count` lets the caller refuse an empty conversation, where
    // there is nothing to fork.
    const estimateContext = async (sessionID: string) => {
      let messages = (context.data.session.message.list(sessionID) ?? []) as unknown as SideMessage[]
      if (!messages.length) {
        await context.data.session.message.sync(sessionID)
        messages = (context.data.session.message.list(sessionID) ?? []) as unknown as SideMessage[]
      }
      const count = messages.length
      for (let index = messages.length - 1; index >= 0; index--) {
        const msg = messages[index]
        if (msg.type !== "assistant" || !msg.tokens) continue
        let estimate = sumTokens(msg.tokens)
        for (let later = index + 1; later < messages.length; later++) {
          estimate += Math.ceil(messageChars(messages[later]) / 4)
        }
        return { tokens: estimate, count }
      }
      return {
        tokens: Math.ceil(messages.reduce((total, msg) => total + messageChars(msg), 0) / 4),
        count,
      }
    }

    const findModelInfo = async (sessionID: string, ref: SideModel | undefined) => {
      if (!ref) return undefined
      const find = () =>
        cachedModels.find((entry) => entry.providerID === ref.providerID && entry.id === ref.id)
      const known = find()
      if (known) return known
      if (!cachedModels.length) await loadModelList(sessionID).catch(() => undefined)
      return find()
    }

    // A refusal is shown in the panel as well as a toast, because the answer is
    // the reason the question was not sent.
    const refuse = (sessionID: string, message: string, persistent: boolean) => {
      context.ui.toast.show({ title: "Side chat", message, variant: "warning" })
      if (!persistent) return
      void update((draft) => {
        const thread = draft.threads[sessionID]
        if (thread) thread.error = message
      })
    }

    // Pure and synchronous: the panel footer renders this on every state change.
    const modelLabel = (ref: SideModel | undefined) => {
      if (!ref) return undefined
      void modelVersion()
      const model = cachedModels.find((entry) => entry.providerID === ref.providerID && entry.id === ref.id)
      const name =
        model?.name ?? `${cachedProviders.get(ref.providerID) ?? ref.providerID}/${ref.id}`
      const variant = ref.variant ? ` #${ref.variant}` : ""
      return `${name}${variant}`
    }

    const sideModelLabel = (sessionID: string) => {
      const thread = state.threads[sessionID]
      const parts = [modelLabel(thread?.model ?? sessionModel(sessionID))]
      if (thread?.contextTokens !== undefined && thread.contextLimit) {
        const percent = Math.min(100, Math.round((thread.contextTokens / thread.contextLimit) * 100))
        if (percent >= 70) parts.push(`${percent}%`)
      }
      return parts.filter((part): part is string => Boolean(part)).join(" · ") || undefined
    }

    const pickModel = async (
      sessionID: string,
      current: SideModel | undefined,
    ): Promise<SideModel | null | undefined> => {
      const { models, providers } = await loadModelList(sessionID)
      const available = models.filter(
        (model) => model.enabled && (model as ModelEntry & { type?: string }).type !== "image",
      )
      if (!available.length) {
        context.ui.toast.show({ message: "No models available", variant: "warning" })
        return undefined
      }

      const rank = (providerID: string) => (providerID === PREFERRED_PROVIDER ? 0 : 1)
      const options = available
        .toSorted(
          (a, b) =>
            rank(a.providerID) - rank(b.providerID) ||
            (providers.get(a.providerID) ?? a.providerID).localeCompare(
              providers.get(b.providerID) ?? b.providerID,
            ) ||
            a.name.localeCompare(b.name),
        )
        .map((model) => ({
          title: model.name,
          value: `${model.providerID}/${model.id}`,
          category: providers.get(model.providerID) ?? model.providerID,
        }))

      let reset = false
      const selected = await context.ui.dialog.select<string>({
        title: "Side chat model",
        placeholder: "Search",
        current: current ? `${current.providerID}/${current.id}` : undefined,
        options,
        actions: [
          {
            bind: "ctrl+d",
            title: "Use main model",
            side: "right",
            selection: "none",
            onTrigger: () => {
              reset = true
              context.ui.dialog.clear()
            },
          },
        ],
      })
      if (reset) return null
      if (!selected) return undefined

      const slash = selected.indexOf("/")
      const providerID = selected.slice(0, slash)
      const id = selected.slice(slash + 1)
      const model = models.find((entry) => entry.providerID === providerID && entry.id === id)
      if (!model) return undefined

      let variant: string | undefined
      if (model.variants?.length) {
        let resetVariant = false
        const currentVariant =
          current && current.providerID === providerID && current.id === id ? current.variant : undefined
        const chosen = await context.ui.dialog.select<string>({
          title: "Side chat variant",
          placeholder: "Search",
          current: currentVariant ?? "",
          options: [
            { title: "Default", value: "" },
            ...model.variants.map((entry) => ({ title: entry.id, value: entry.id })),
          ],
          actions: [
            {
              bind: "ctrl+d",
              title: "Model default",
              side: "right",
              selection: "none",
              onTrigger: () => {
                resetVariant = true
                context.ui.dialog.clear()
              },
            },
          ],
        })
        if (resetVariant) variant = undefined
        else if (chosen === undefined) return undefined
        else variant = chosen || undefined
      }
      return { providerID, id, variant }
    }

    const setSideModel = async (sessionID: string, model: SideModel | null) => {
      const target = model ?? sessionModel(sessionID)
      const sideSessionID = state.threads[sessionID]?.sessionID

      // The side chat never compacts, so a switch to a smaller model is refused
      // when the forked context no longer fits. Nothing is stored or switched on
      // a refusal, so the previous pin keeps working.
      if (model && sideSessionID && target) {
        const info = await findModelInfo(sessionID, target).catch(() => undefined)
        if (!info) {
          context.ui.toast.show({
            title: "Side chat model",
            message: `${model.providerID}/${model.id} is not available here`,
            variant: "warning",
          })
          return
        }
        const budget = budgetFor(info, await loadCompaction(sessionID))
        const tokens = (await estimateContext(sideSessionID).catch(() => ({ tokens: 0, count: 0 }))).tokens
        if (!fits(budget, tokens)) {
          context.ui.toast.show({
            title: "Side chat model",
            message: `Kept the current model: this side chat holds ~${formatTokens(tokens)} tokens and ${modelLabel(model) ?? model.id} compacts at ${formatTokens(ceilingFor(budget))}.`,
            variant: "warning",
          })
          return
        }
      }

      // Switch the live session first, so a failed switch leaves the stored pin
      // untouched and the footer keeps showing the model that is really in use.
      if (sideSessionID && target) {
        try {
          await context.client.session.switchModel({ sessionID: sideSessionID, model: target })
        } catch (cause) {
          context.ui.toast.show({
            title: "Side chat model",
            message: errorMessage(cause),
            variant: "error",
          })
          return
        }
      }

      await update((draft) => {
        const thread = draft.threads[sessionID] ?? (draft.threads[sessionID] = { turns: [] })
        if (model) thread.model = model
        else delete thread.model
      })
      const label = modelLabel(target)
      context.ui.toast.show({
        message: model
          ? `Side chat model: ${label ?? `${model.providerID}/${model.id}`}`
          : `Side chat model: main session (${label ?? "session model"})`,
        variant: "success",
      })
    }

    const chooseModel = async (sessionID: string) => {
      setPickerOpen(true)
      try {
        // Highlight the pin, not the resolved model: an unpinned side chat
        // follows the main session and should show the follow-main row.
        return await pickModel(sessionID, state.threads[sessionID]?.model)
      } finally {
        setPickerOpen(false)
      }
    }

    const pickSideModel = async (sessionID: string) => {
      try {
        const picked = await chooseModel(sessionID)
        if (picked === undefined) return
        await setSideModel(sessionID, picked)
      } catch (cause) {
        context.ui.toast.show({
          title: "Side chat model",
          message: errorMessage(cause),
          variant: "error",
        })
      }
    }

    const threadForFork = (forkID: string) => {
      const mainSessionID = sideToMain.get(forkID)
      if (!mainSessionID) return
      return { mainSessionID, thread: state.threads[mainSessionID] }
    }

    const mergedStream = (forkID: string) => {
      const parts = streamParts.get(forkID)
      if (!parts) return ""
      return [...parts.entries()]
        .sort(([left], [right]) => left - right)
        .map(([, text]) => text)
        .join("\n\n")
    }

    const updateStream = (forkID: string, ordinal: number, text: string, replace: boolean) => {
      const found = threadForFork(forkID)
      if (!found?.thread.pending) return
      const parts = streamParts.get(forkID) ?? new Map<number, string>()
      streamParts.set(forkID, parts)
      parts.set(ordinal, replace ? text : (parts.get(ordinal) ?? "") + text)
      const streaming = mergedStream(forkID)
      void update((draft) => {
        const thread = draft.threads[found.mainSessionID]
        if (thread?.pending) thread.streaming = streaming
      })
    }

    // Track the side session's size so the footer can show the budget, and so a
    // switch to a smaller model is refused instead of compacting. Runs in the
    // background; render stays pure.
    const refreshContext = async (mainSessionID: string) => {
      const thread = state.threads[mainSessionID]
      const sideSessionID = thread?.sessionID
      if (!thread || !sideSessionID) return
      const modelRef = thread.model ?? sessionModel(mainSessionID)
      const info = await findModelInfo(mainSessionID, modelRef)
      const budget = info ? budgetFor(info, await loadCompaction(mainSessionID)) : undefined
      const tokens = (await estimateContext(sideSessionID)).tokens
      await update((draft) => {
        const target = draft.threads[mainSessionID]
        if (!target || target.sessionID !== sideSessionID) return
        target.contextTokens = tokens
        if (budget && budget.threshold > 0) target.contextLimit = ceilingFor(budget)
        else delete target.contextLimit
      })
    }

    const finishSide = (sideSessionID: string, error?: string) => {
      const found = threadForFork(sideSessionID)
      if (!found) return
      const answer = mergedStream(sideSessionID).trim()
      streamParts.delete(sideSessionID)
      void update((draft) => {
        const thread = draft.threads[found.mainSessionID]
        if (!thread) return
        const question = thread.pending
        thread.pending = undefined
        thread.streaming = undefined
        if (error) {
          thread.error = error
          return
        }
        thread.error = undefined
        if (question && answer) thread.turns.push({ question, answer, at: Date.now() })
      }).then(() => {
        if (!error) void refreshContext(found.mainSessionID).catch(() => undefined)
      })
    }

    const stops = [
      context.data.on("session.text.delta", (event) => {
        if (!sideToMain.has(event.data.sessionID)) return
        updateStream(event.data.sessionID, event.data.ordinal, event.data.delta, false)
      }),
      context.data.on("session.text.ended", (event) => {
        if (!sideToMain.has(event.data.sessionID)) return
        updateStream(event.data.sessionID, event.data.ordinal, event.data.text, true)
      }),
      context.data.on("session.execution.succeeded", (event) => {
        if (!sideToMain.has(event.data.sessionID)) return
        finishSide(event.data.sessionID)
      }),
      context.data.on("session.execution.failed", (event) => {
        if (!sideToMain.has(event.data.sessionID)) return
        finishSide(event.data.sessionID, errorMessage(event.data.error))
      }),
      context.data.on("session.execution.interrupted", (event) => {
        if (!sideToMain.has(event.data.sessionID)) return
        finishSide(event.data.sessionID, "Side question interrupted")
      }),
      context.data.on("session.compaction.started", (event) => {
        const sideSessionID = event.data.sessionID
        const mainSessionID = sideToMain.get(sideSessionID)
        // The budget guard should make this unreachable. If OpenCode still starts
        // compacting, stop the run and throw the fork away rather than pay for a
        // summary the side chat never asked for.
        if (!mainSessionID) return
        void context.client.session.interrupt({ sessionID: sideSessionID }).catch(() => undefined)
        sideToMain.delete(sideSessionID)
        streamParts.delete(sideSessionID)
        void update((draft) => {
          const thread = draft.threads[mainSessionID]
          if (!thread || thread.sessionID !== sideSessionID) return
          delete thread.sessionID
          delete thread.contextTokens
          delete thread.contextLimit
          thread.pending = undefined
          thread.streaming = undefined
          thread.error = "Side chat reached the model limit and was stopped. Start a new side chat."
        }).then(() => context.client.session.remove({ sessionID: sideSessionID }).catch(() => undefined))
      }),
      context.data.on("config.updated", () => compactionCache.clear()),
    ]

    const dropSide = async (sideSessionID: string | undefined) => {
      if (!sideSessionID) return
      sideToMain.delete(sideSessionID)
      streamParts.delete(sideSessionID)
      await context.client.session.remove({ sessionID: sideSessionID }).catch(() => undefined)
    }

    // A side chat is exactly one archived fork of the main session. Reuse it for
    // follow-ups; create a new one when there is none, or when the stored fork
    // was deleted or lost its permissions.
    const ensureFork = async (mainSessionID: string) => {
      const currentSessionID = state.threads[mainSessionID]?.sessionID
      if (currentSessionID) {
        const existing = await context.client.session.get({ sessionID: currentSessionID }).catch(
          () => undefined,
        )
        if (existing) {
          // The permissions are re-applied before every prompt, so a reused fork
          // never runs with the main agent's ruleset.
          await context.client.session.update({
            sessionID: currentSessionID,
            permissions: READ_ONLY_PERMISSIONS,
          })
          sideToMain.set(currentSessionID, mainSessionID)
          return { id: currentSessionID, created: false as const }
        }
        sideToMain.delete(currentSessionID)
      }

      const fork = await context.client.session.fork({ sessionID: mainSessionID })
      const title = `${context.data.session.get(mainSessionID)?.title ?? "Session"} - side chat`
      // The title and archive flag are cosmetic; the permissions are not.
      await context.client.session.update({ sessionID: fork.id, title, archived: true }).catch(
        () => undefined,
      )
      try {
        await context.client.session.update({
          sessionID: fork.id,
          permissions: READ_ONLY_PERMISSIONS,
        })
      } catch (cause) {
        await context.client.session.remove({ sessionID: fork.id }).catch(() => undefined)
        throw cause
      }
      sideToMain.set(fork.id, mainSessionID)
      return { id: fork.id, created: true as const }
    }

    const closeSide = async (sessionID: string, thread: Thread | undefined) => {
      await dropSide(thread?.sessionID)
      await update((draft) => {
        delete draft.threads[sessionID]
      })
      context.ui.panel.close()
    }

    // The panel takes focus when it opens. Return focus to the session prompt so
    // the user can keep working while the side question stays visible.
    const focusSession = () => {
      setTimeout(() => {
        setPanelFocused(false)
        try {
          context.keymap.dispatch("pane.focus.left")
        } catch {
          // The pane command is unavailable on narrow fullscreen panels.
        }
      }, 50)
    }

    const openPanel = (focusPanel = false) => {
      if (!context.ui.panel.open(PANEL, { presentation: "panel" })) return false
      if (!focusPanel) focusSession()
      return true
    }

    const askQuestion = (title: string, placeholder: string, model?: string) =>
      new Promise<{ text: string; newChat: boolean } | undefined>((resolve) => {
        let settled = false
        const finish = (value?: { text: string; newChat: boolean }) => {
          if (settled) return
          settled = true
          context.ui.dialog.clear()
          resolve(value)
        }
        context.ui.dialog.show(
          () => (
            <AskDialog
              context={context}
              title={title}
              placeholder={placeholder}
              model={model}
              onSubmit={(text, newChat) => finish({ text, newChat })}
              onCancel={() => finish(undefined)}
              cancelKey={keys.dialogCancel}
            />
          ),
          () => finish(undefined),
        )
        // `show` resets dialog size and centering to medium/uncentered; apply
        // the wide centered layout after the stack entry is replaced.
        context.ui.dialog.set({ size: "large", centered: true })
      })

    const ask = async (input?: string) => {
      const route = context.ui.router.current()
      if (route.type !== "session") {
        context.ui.toast.show({ message: "Open a session first", variant: "warning" })
        return
      }

      const sessionID = route.sessionID
      const current = state.threads[sessionID]
      if (current?.pending) {
        context.ui.toast.show({ message: "A side question is already running", variant: "warning" })
        return
      }

      const keepPanelFocus = panelFocused()
      const parsed = parseSideInput(input)
      if (parsed.error) {
        context.ui.toast.show({ message: parsed.error, variant: "error" })
        return
      }
      if (parsed.close) {
        await closeSide(sessionID, current)
        return
      }

      // `--model` without a value opens the picker before the question dialog.
      let picked: SideModel | null | undefined
      if (parsed.pick) {
        try {
          picked = await chooseModel(sessionID)
        } catch (cause) {
          context.ui.toast.show({ title: "Side chat model", message: errorMessage(cause), variant: "error" })
          return
        }
      }
      if (parsed.pick && picked === undefined) return
      const chosen = picked !== undefined ? picked : parsed.model

      // Warm the model cache for the budget check, the dialog preview, and the
      // panel footer. Without it labels fall back to provider/model ids.
      if (!cachedModels.length) await loadModelList(sessionID).catch(() => undefined)

      const canContinue = !parsed.reset && Boolean(current?.turns.length)
      let question = parsed.question
      let newChat = false
      if (!question) {
        // A pin chosen before the first question belongs to this side chat.
        // Clear it only when the user explicitly starts a new one.
        const previewPin = chosen !== undefined ? chosen : !parsed.reset ? current?.model : undefined
        const preview = modelLabel(
          chosen === null ? sessionModel(sessionID) : (previewPin ?? sessionModel(sessionID)),
        )
        setDialogOpen(true)
        try {
          const answer = await askQuestion(
            "/side",
            canContinue ? "Continue the side question" : "Ask anything",
            preview,
          )
          question = answer?.text
          newChat = answer?.newChat ?? false
        } finally {
          setDialogOpen(false)
        }
      }
      if (!question) return

      const continuing = canContinue && !newChat
      const startsNew = Boolean(parsed.reset || newChat)
      const prior = continuing ? (current?.turns ?? []) : []
      const previousSession = !continuing ? current?.sessionID : undefined
      // Reflect the pin chosen above, before the state update lands.
      const modelRef =
        chosen !== undefined
          ? (chosen ?? sessionModel(sessionID))
          : (current?.model ?? sessionModel(sessionID))

      // A side chat never compacts. Refuse the question before any session is
      // created or prompted when it would reach the model's compaction point.
      const info = await findModelInfo(sessionID, modelRef).catch(() => undefined)
      if (!info) {
        refuse(
          sessionID,
          modelRef
            ? `${modelLabel(modelRef) ?? `${modelRef.providerID}/${modelRef.id}`} is not available here`
            : "Pick a side chat model first",
          Boolean(current?.turns.length),
        )
        return
      }
      const budget = budgetFor(info, await loadCompaction(sessionID))
      const estimate = await estimateContext(
        continuing && current?.sessionID ? current.sessionID : sessionID,
      ).catch(() => ({ tokens: 0, count: 1 }))
      // A fork needs a conversation to copy. Refuse rather than create an empty
      // side session that cannot answer anything.
      if (!estimate.count) {
        refuse(sessionID, "The main session has no messages yet.", false)
        return
      }
      if (!fits(budget, estimate.tokens, question)) {
        refuse(
          sessionID,
          `This side chat would reach the compaction point (~${formatTokens(estimate.tokens + budget.reserve)} of ${formatTokens(ceilingFor(budget))} usable tokens on ${modelLabel(modelRef) ?? "the model"}). Use a larger model, /compact the session, or start a new one.`,
          Boolean(current?.turns.length),
        )
        return
      }

      await update((draft) => {
        const thread = draft.threads[sessionID] ?? (draft.threads[sessionID] = { turns: [] })
        if (!continuing) {
          thread.turns = []
          delete thread.sessionID
          delete thread.contextTokens
          delete thread.contextLimit
        }
        // A pin chosen before the first question belongs to this side chat.
        // Clear it only when the user explicitly starts a new one.
        if (startsNew) delete thread.model
        if (chosen !== undefined) {
          if (chosen) thread.model = chosen
          else delete thread.model
        }
        thread.pending = question
        thread.streaming = ""
        thread.error = undefined
      })

      openPanel(keepPanelFocus)

      try {
        const side = await ensureFork(sessionID)
        await update((draft) => {
          const thread = draft.threads[sessionID]
          if (!thread) return
          if (thread.sessionID !== side.id) {
            delete thread.contextTokens
            delete thread.contextLimit
          }
          thread.sessionID = side.id
        })
        // The new session is in place; the one it replaced can go.
        if (previousSession && previousSession !== side.id) void dropSide(previousSession)
        // Archived side sessions are not guaranteed to be in `context.data.session`,
        // so always apply `switchModel` directly before prompting.
        if (modelRef) {
          try {
            await context.client.session.switchModel({ sessionID: side.id, model: modelRef })
          } catch (cause) {
            const message = errorMessage(cause)
            await update((draft) => {
              const thread = draft.threads[sessionID]
              if (!thread) return
              thread.pending = undefined
              thread.streaming = undefined
              thread.error = message
            })
            context.ui.toast.show({ title: "Side chat model", message, variant: "error" })
            return
          }
        }
        if (chosen !== undefined) {
          const label = modelLabel(modelRef)
          context.ui.toast.show({
            message: chosen
              ? `Side chat model: ${label ?? `${chosen.providerID}/${chosen.id}`}`
              : `Side chat model: main session (${label ?? "session model"})`,
            variant: "success",
          })
        }
        // A reused fork already holds its history. A fork created after the old
        // one went away only has the main history, so replay the side turns.
        const prompt =
          side.created && prior.length ? buildPrompt(prior, question, true) : buildPrompt([], question, false)
        await context.client.session.prompt({ sessionID: side.id, text: prompt })
        // A prompt unarchives the session, so hide it again before the turn runs.
        await context.client.session
          .update({ sessionID: side.id, archived: true })
          .catch(() => undefined)
      } catch (cause) {
        if (previousSession) void dropSide(previousSession)
        // If a side session cannot be created or prompted, fall back to the
        // transient generation API so the side question still gets an answer.
        try {
          const result = await context.client.session.generate({
            sessionID,
            prompt: buildPrompt(prior, question, continuing),
          })
          await update((draft) => {
            const thread = draft.threads[sessionID]
            if (!thread) return
            thread.pending = undefined
            thread.streaming = undefined
            thread.error = undefined
            thread.turns.push({ question, answer: result.text.trim(), at: Date.now() })
          })
          void refreshContext(sessionID).catch(() => undefined)
        } catch (fallbackCause) {
          const message = errorMessage(fallbackCause)
          await update((draft) => {
            const thread = draft.threads[sessionID]
            if (!thread) return
            thread.pending = undefined
            thread.streaming = undefined
            thread.error = message
          })
          context.ui.toast.show({ title: "Side question failed", message, variant: "error" })
        }
      }
    }

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "session.aside",
          title: "Ask side chat question",
          group: "Session",
          palette: true,
          bind: keys.ask,
          slash: { name: "side", arguments: true },
          enabled: () => !pickerOpen(),
          run: (input) => ask(input),
        },
        {
          id: "session.aside.model",
          title: "Set side chat model",
          group: "Session",
          palette: true,
          bind: keys.model,
          enabled: () => {
            if (pickerOpen()) return false
            const route = context.ui.router.current()
            return route.type === "session" && !state.threads[route.sessionID]?.pending
          },
          run: () => {
            const route = context.ui.router.current()
            if (route.type !== "session") {
              context.ui.toast.show({ message: "Open a session first", variant: "warning" })
              return
            }
            void pickSideModel(route.sessionID)
          },
        },
        {
          id: "session.aside.toggle",
          title: "Toggle side chat panel",
          group: "Session",
          palette: true,
          bind: keys.toggle,
          enabled: () => !pickerOpen(),
          run: () => {
            const route = context.ui.router.current()
            if (route.type !== "session") {
              context.ui.toast.show({ message: "Open a session first", variant: "warning" })
              return
            }
            if (context.ui.panel.current()?.name === PANEL) {
              context.ui.panel.close()
              return
            }
            const thread = state.threads[route.sessionID]
            if (!thread || (!thread.turns.length && !thread.pending)) {
              context.ui.toast.show({ message: "Ask /side first", variant: "warning" })
              return
            }
            openPanel(true)
            void loadModelList(route.sessionID).catch(() => undefined)
          },
        },
        {
          id: "session.aside.resetwidth",
          title: "Reset panel width to default",
          group: "Session",
          bind: "alt+0",
          palette: true,
          enabled: () => context.ui.panel.current()?.name === PANEL,
          run: resetPanelWidth,
        },
        {
          id: "session.aside.focus",
          title: "Toggle side chat focus",
          group: "Session",
          palette: true,
          bind: keys.focus,
          enabled: () => context.ui.panel.current()?.name === PANEL,
          run: () => {
            if (panelFocused()) {
              focusSession()
              return
            }
            if (focusPanelAction) {
              // The panel's own focus action is more reliable than dispatching
              // the host pane command from a plugin keymap layer.
              focusPanelAction()
              return
            }
            try {
              context.keymap.dispatch("pane.focus.right")
            } catch {
              // The pane command is unavailable on narrow fullscreen panels.
            }
          },
        },
      ],
    }))

    // Mirror the pending indicator in the prompt footer.
    context.ui.slot({
      append: "prompt.footer.status",
      render: (input) => {
        const pending = () => (input.sessionID ? state.threads[input.sessionID]?.pending : undefined)
        return (
          <Show when={pending()}>
            <text fg={theme.hue.interactive[200]}>/side</text>
          </Show>
        )
      },
    })

    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <AsidePanel
            context={context}
            panel={panel}
            state={state}
            syntax={syntax}
            theme={theme}
            onAsk={() => ask()}
            onClose={() => closeSide(panel.sessionID, state.threads[panel.sessionID])}
            onFocus={setPanelFocused}
            onReady={(focus) => (focusPanelAction = focus)}
            onModel={() => void pickSideModel(panel.sessionID)}
            modelLabel={() => sideModelLabel(panel.sessionID)}
            dialogOpen={() => dialogOpen() || pickerOpen()}
            keys={keys}
          />
        </Show>
      ),
    })

    return () => {
      for (const stop of stops) stop()
      syntax.destroy()
    }
  },
})

type SideParse = {
  question?: string
  reset?: boolean
  close?: boolean
  pick?: boolean
  model?: SideModel
  error?: string
}

// Leading flags only; the rest is the question. Unknown flags are an error.
function parseSideInput(input?: string): SideParse {
  const text = input?.trim()
  if (!text) return {}
  const tokens = text.split(/\s+/)
  let close = false
  let reset = false
  let pick = false
  let model: SideModel | undefined
  let index = 0
  while (index < tokens.length && tokens[index].startsWith("--")) {
    const token = tokens[index]
    if (token === "--close") {
      close = true
      index++
      continue
    }
    if (token === "--new") {
      reset = true
      index++
      continue
    }
    if (token === "--model") {
      const value = tokens[index + 1]
      if (value && !value.startsWith("--")) {
        const ref = parseModelRef(value)
        if (!ref) return { error: `Invalid model reference: ${value}` }
        model = ref
        index += 2
        continue
      }
      pick = true
      index++
      continue
    }
    // A removed or mistyped flag is an error, so it never becomes part of the
    // question the side chat receives.
    return { error: `Unknown flag: ${token}. Use --new, --close, or --model.` }
  }
  return {
    close: close || undefined,
    reset: reset || undefined,
    pick: pick || undefined,
    model,
    question: tokens.slice(index).join(" ").trim() || undefined,
  }
}

function parseModelRef(value: string): SideModel | undefined {
  const [ref, rawVariant] = value.split("#")
  const slash = ref.indexOf("/")
  if (slash <= 0 || slash === ref.length - 1) return undefined
  const providerID = ref.slice(0, slash)
  const id = ref.slice(slash + 1)
  if (!providerID || !id) return undefined
  return {
    providerID,
    id,
    variant: rawVariant && rawVariant !== "default" ? rawVariant : undefined,
  }
}

function buildPrompt(turns: Turn[], question: string, followup: boolean) {
  const history = turns
    .slice(-MAX_HISTORY_TURNS)
    .map(
      (turn, index) =>
        `Side question ${index + 1}: ${turn.question}\nSide answer ${index + 1}: ${turn.answer}`,
    )
    .join("\n\n")

  return [
    INSTRUCTIONS,
    followup
      ? "This is a continuation of a temporary side conversation. Use the prior side questions and answers below for context. Keep the exchange out of the main conversation."
      : undefined,
    history ? `Prior side conversation:\n\n${history}` : undefined,
    `${followup ? "Follow-up side question" : "Side question"}: ${question}`,
  ]
    .filter((part): part is string => Boolean(part))
    .join("\n\n")
}

function AskDialog(props: {
  context: Context
  title: string
  placeholder: string
  model?: string
  onSubmit: (value: string, newChat: boolean) => void
  onCancel: () => void
  cancelKey: string | false
}) {
  // Host dialogs run on the dialog surface token set; reading `context.theme`
  // directly yields the base surface and makes the footer bar match the dialog
  // background instead of its darker raised footer (`surface("dialog").background.raised.high`).
  const dialogTheme = () => props.context.theme.surface("dialog")
  let textarea: TextareaRenderable | undefined
  const submit = (newChat: boolean) => {
    const text = textarea?.plainText.trim() ?? ""
    if (!text) return
    props.onSubmit(text, newChat)
  }

  onMount(() => {
    setTimeout(() => {
      if (!textarea || textarea.isDestroyed) return
      textarea.focus()
    }, 1)
  })

  props.context.keymap.layer(() => ({
    mode: "modal",
    target: () => textarea,
    priority: 10,
    enabled: () => Boolean(textarea) && !textarea!.isDestroyed,
    commands: [
      {
        id: "session.aside.dialog.new",
        bind: "ctrl+return",
        title: "Ask in a new side chat",
        group: "/side",
        run: () => submit(true),
      },
      {
        id: "session.aside.dialog.cancel",
        bind: props.cancelKey,
        title: "Cancel side question",
        group: "/side",
        run: () => props.onCancel(),
      },
    ],
  }))

  return (
    <box flexDirection="column" gap={1}>
      <box
        flexDirection="row"
        flexShrink={0}
        paddingLeft={3}
        paddingRight={3}
        gap={1}
      >
        <text
          attributes={TextAttributes.BOLD}
          fg={dialogTheme().text.base}
          flexGrow={1}
          wrapMode="none"
        >
          {props.title}
        </text>
        <text fg={dialogTheme().text.muted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box paddingLeft={3} paddingRight={3}>
        <textarea
          ref={(value) => (textarea = value)}
          width="100%"
          minHeight={6}
          maxHeight={12}
          wrapMode="word"
          placeholder={props.placeholder}
          placeholderColor={dialogTheme().text.muted}
          textColor={dialogTheme().text.formfield.base}
          focusedTextColor={dialogTheme().text.formfield.base}
          cursorColor={dialogTheme().text.base}
          onSubmit={() => submit(false)}
        />
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        paddingLeft={3}
        paddingRight={3}
        paddingTop={1}
        paddingBottom={1}
        gap={1}
        backgroundColor={dialogTheme().background.raised.high}
      >
        <text wrapMode="none" truncate flexGrow={1} flexShrink={1}>
          <span style={{ fg: dialogTheme().text.base }}>enter</span>
          <span style={{ fg: dialogTheme().text.muted }}> send   </span>
          <span style={{ fg: dialogTheme().text.base }}>ctrl+enter</span>
          <span style={{ fg: dialogTheme().text.muted }}> new   </span>
          <span style={{ fg: dialogTheme().text.base }}>shift+enter</span>
          <span style={{ fg: dialogTheme().text.muted }}> newline</span>
        </text>
        <Show when={props.model}>
          <text
            fg={dialogTheme().text.muted}
            wrapMode="none"
            truncate
            flexShrink={1}
          >
            {props.model}
          </text>
        </Show>
      </box>
    </box>
  )
}

function AsidePanel(props: {
  context: Context
  panel: PanelInput
  state: State
  syntax: SyntaxStyle
  theme: Context["theme"]
  onAsk: () => void
  onClose: () => void
  onFocus: (focused: boolean) => void
  onReady: (focus: () => void) => void
  onModel: () => void
  modelLabel: () => string | undefined
  dialogOpen: () => boolean
  keys: PanelKeys
}) {
  const thread = () => props.state.threads[props.panel.sessionID]
  const [ready, setReady] = createSignal(false)
  const focused = () => props.panel.focused
  const keyColor = () => (focused() ? props.theme.text.base : props.theme.text.action.primary.disabled)
  const labelColor = () => (focused() ? props.theme.text.muted : props.theme.text.action.primary.disabled)
  const dim = () => (focused() ? undefined : TextAttributes.DIM)
  createEffect(() => props.onFocus(props.panel.focused))
  onMount(() => props.onReady(props.panel.focus))
  const header = () =>
    `${props.context.data.session.get(props.panel.sessionID)?.title ?? "Session"} - side chat`
  let scroll: ScrollBoxRenderable | undefined
  const maxScroll = () => Math.max(0, (scroll?.scrollHeight ?? 0) - (scroll?.viewport.height ?? 0))
  const resetScrollSettling = () => {
    const target = scroll as unknown as {
      resetScrollAccumulators?: () => void
      scrollAccel?: { reset?: () => void }
    }
    target?.resetScrollAccumulators?.()
    target?.scrollAccel?.reset?.()
  }
  const clampScrollBy = (delta: number) => {
    if (!scroll || scroll.isDestroyed) return
    const limit = maxScroll()
    const next = Math.max(0, Math.min(limit, scroll.scrollTop + delta))
    scroll.scrollTo(next)
    if (next === 0 || next === limit) resetScrollSettling()
  }
  onMount(() => {
    let tries = 0
    let settled = 0
    const timer = setInterval(() => {
      if (!scroll || scroll.isDestroyed) return
      if (scroll.scrollHeight <= 0 && tries < 30) {
        tries++
        return
      }
      scroll.scrollTo(maxScroll())
      if (settled++ < 2) return
      setReady(true)
      clearInterval(timer)
    }, 16)
    const fallback = setTimeout(() => {
      setReady(true)
      clearInterval(timer)
    }, 800)
    onCleanup(() => {
      clearInterval(timer)
      clearTimeout(fallback)
    })
  })
  const turnRows: BoxRenderable[] = []
  let pendingRow: BoxRenderable | undefined
  const jumpMessage = (direction: 1 | -1) => {
    if (!scroll || scroll.isDestroyed) return
    // row.y is a screen coordinate. Convert it to content coordinates the same
    // way the main session does before comparing it with scrollTop.
    const positions = [...turnRows, pendingRow]
      .filter((row): row is BoxRenderable => Boolean(row) && !row.isDestroyed)
      .map((row) => scroll.scrollTop + row.y - scroll.viewport.y)
      .sort((left, right) => left - right)
    if (positions.length === 0) return
    const current = scroll.scrollTop
    const target =
      direction > 0
        ? positions.find((position) => position > current + 1)
        : [...positions].reverse().find((position) => position < current - 1)
    scroll.scrollTo(target ?? (direction > 0 ? scroll.scrollHeight : 0))
  }
  props.context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    enabled: () => props.panel.focused && !props.dialogOpen(),
    commands: [
      {
        id: "session.aside.ask",
        bind: props.keys.panelAsk,
        title: "Ask another side question",
        group: "/side",
        run: () => props.onAsk(),
      },
      {
        id: "session.aside.model.panel",
        bind: props.keys.panelModel,
        title: "Set side chat model",
        group: "/side",
        enabled: () => !thread()?.pending,
        run: () => props.onModel(),
      },
      {
        id: "session.aside.hide",
        bind: props.keys.hide,
        title: "Hide the side question panel",
        group: "/side",
        run: () => props.panel.close(),
      },
      {
        id: "session.aside.close",
        bind: props.keys.close,
        title: "Close permanently and delete side chat",
        group: "/side",
        run: () => props.onClose(),
      },
      {
        id: "session.aside.fullscreen",
        bind: props.keys.fullscreen,
        title: "Toggle side question fullscreen",
        group: "/side",
        run: () => props.panel.toggleFullscreen(),
      },
      {
        id: "session.aside.line.down",
        bind: props.keys.lineDown,
        title: "Scroll side chat down",
        group: "/side",
        run: () => clampScrollBy(1),
      },
      {
        id: "session.aside.line.up",
        bind: props.keys.lineUp,
        title: "Scroll side chat up",
        group: "/side",
        run: () => clampScrollBy(-1),
      },
      {
        id: "session.aside.message.next",
        bind: props.keys.messageNext,
        title: "Jump to next side question",
        group: "/side",
        run: () => jumpMessage(1),
      },
      {
        id: "session.aside.message.previous",
        bind: props.keys.messagePrevious,
        title: "Jump to previous side question",
        group: "/side",
        run: () => jumpMessage(-1),
      },
      {
        id: "session.aside.home",
        bind: props.keys.home,
        title: "Jump to top of side chat",
        group: "/side",
        run: () => {
          if (!scroll || scroll.isDestroyed) return
          scroll.scrollTo(0)
          resetScrollSettling()
        },
      },
      {
        id: "session.aside.end",
        bind: props.keys.end,
        title: "Jump to bottom of side chat",
        group: "/side",
        run: () => {
          if (!scroll || scroll.isDestroyed) return
          scroll.scrollTo(scroll.scrollHeight)
          resetScrollSettling()
        },
      },
    ],
  }))

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      marginTop={-1}
      backgroundColor={props.theme.background.base}
    >
      <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} gap={1}>
        <text
          attributes={focused() ? TextAttributes.BOLD : TextAttributes.BOLD | TextAttributes.DIM}
          fg={keyColor()}
          flexGrow={1}
          wrapMode="none"
          truncate
        >
          {header()}
        </text>
      </box>

      <scrollbox
        ref={(value) => {
          scroll = value
          if (value) {
            value.handleKeyPress = () => false
            value.verticalScrollBar.handleKeyPress = () => false
            value.horizontalScrollBar.handleKeyPress = () => false
          }
        }}
        flexGrow={1}
        minHeight={0}
        focusable={false}
        stickyScroll
        stickyStart="bottom"
        opacity={ready() ? 1 : 0}
        verticalScrollbarOptions={{
          paddingLeft: 1,
          visible: true,
          trackOptions: {
            backgroundColor: "transparent",
            foregroundColor: props.theme.hue.neutral[700],
          },
        }}
      >
        <box
          flexDirection="column"
          gap={1}
          paddingLeft={2}
          paddingRight={2}
          paddingTop={1}
          backgroundColor={props.theme.background.base}
        >
          {thread()?.turns.map((turn, index) => (
            <box
              ref={(node) => (turnRows[index] = node)}
              flexDirection="column"
              gap={1}
              marginTop={index === 0 ? 0 : 1}
            >
              <SideQuestion theme={props.theme} question={turn.question} />
              <box paddingLeft={1} paddingRight={1}>
                <markdown
                  syntaxStyle={props.syntax}
                  content={turn.answer}
                  conceal
                  internalBlockMode="top-level"
                  tableOptions={{ style: "grid", cellPaddingX: 1 }}
                  fg={props.theme.markdown.text}
                  bg={props.theme.background.base}
                />
              </box>
            </box>
          ))}
          <Show when={thread()?.pending}>
            <box
              ref={(node) => (pendingRow = node)}
              flexDirection="column"
              gap={1}
              marginTop={thread()!.turns.length ? 1 : 0}
            >
              <SideQuestion theme={props.theme} question={thread()!.pending!} />
              <box paddingLeft={1} paddingRight={1}>
                <Show
                  when={thread()?.streaming}
                  fallback={<text fg={props.theme.text.feedback.warning.base}>Thinking…</text>}
                >
                  <markdown
                    syntaxStyle={props.syntax}
                    content={thread()!.streaming!}
                    streaming
                    conceal
                    internalBlockMode="top-level"
                    tableOptions={{ style: "grid", cellPaddingX: 1 }}
                    fg={props.theme.markdown.text}
                    bg={props.theme.background.base}
                  />
                </Show>
              </box>
            </box>
          </Show>
          <Show when={thread()?.error}>
            <box paddingLeft={1}>
              <text fg={props.theme.text.feedback.error.base}>{thread()!.error}</text>
            </box>
          </Show>
          <box height={1} flexShrink={0} />
        </box>
      </scrollbox>

      <box
        flexDirection="row"
        flexShrink={0}
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        gap={1}
        backgroundColor={props.theme.decrease(props.theme.background.base)}
      >
        <text
          wrapMode="none"
          truncate
          flexGrow={1}
          flexShrink={1}
          attributes={dim()}
        >
          <span style={{ fg: keyColor() }}>a</span>
          <span style={{ fg: labelColor() }}> ask · </span>
          <span style={{ fg: keyColor() }}>m</span>
          <span style={{ fg: labelColor() }}> model · </span>
          {props.panel.presentation === "fullscreen" && (
            <>
              <span style={{ fg: keyColor() }}>f</span>
              <span style={{ fg: labelColor() }}> fullscreen · </span>
            </>
          )}
          <span style={{ fg: keyColor() }}>esc</span>
          <span style={{ fg: labelColor() }}> hide · </span>
          <span style={{ fg: keyColor() }}>x</span>
          <span style={{ fg: labelColor() }}> close</span>
        </text>
        <Show when={props.modelLabel()}>
          <text
            fg={labelColor()}
            attributes={dim()}
            wrapMode="none"
            truncate
            flexShrink={1}
          >
            {props.modelLabel()}
          </text>
        </Show>
      </box>
    </box>
  )
}

function SideQuestion(props: { theme: Context["theme"]; question: string }) {
  return (
    <box
      border={["left"]}
      borderColor={props.theme.hue.interactive[200]}
      backgroundColor={props.theme.background.raised.base}
      paddingTop={1}
      paddingBottom={1}
      paddingLeft={2}
      paddingRight={2}
    >
      <text fg={props.theme.text.base}>{props.question}</text>
    </box>
  )
}

function errorMessage(cause: unknown) {
  if (cause instanceof Error) return cause.message
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    const message = (cause as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  return String(cause)
}
