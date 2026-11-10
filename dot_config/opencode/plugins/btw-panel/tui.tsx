import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import {
  SyntaxStyle,
  TextAttributes,
  type BoxRenderable,
  type ScrollBoxRenderable,
  type TextareaRenderable,
} from "@opentui/core"
import { createEffect, createSignal, onMount, Show } from "solid-js"

// Replaces the built-in opencode.btw plugin, which is disabled in cli.json.
const PANEL = "jadon.btw-panel"
const MAX_HISTORY_TURNS = 8

const DEFAULT_KEYS = {
  ask: "alt+a",
  toggle: "alt+l",
  focus: "alt+h",
  panelAsk: "a",
  hide: "escape,q",
  close: "x",
  fullscreen: "f",
  lineUp: "alt+k",
  lineDown: "alt+j",
  messagePrevious: "alt+shift+k",
  messageNext: "alt+shift+j",
  home: "home",
  end: "end",
  dialogCancel: "escape",
} as const
type PanelKeys = Record<keyof typeof DEFAULT_KEYS, string | false>

const INSTRUCTIONS = [
  "The user is asking a quick side question about the conversation so far.",
  "Answer directly and concisely in markdown from what you already know.",
  "Do not call any tools and do not take any actions.",
].join(" ")

type Turn = { question: string; answer: string; at: number }
type Thread = {
  turns: Turn[]
  pending?: string
  streaming?: string
  forkID?: string
  error?: string
}
type State = { threads: Record<string, Thread> }

export default Plugin.define({
  id: "jadon.btw-panel",
  setup(context) {
    const [state, update] = context.storage.store<State>("aside", { initial: { threads: {} } })
    const [panelFocused, setPanelFocused] = createSignal(false)
    const [dialogOpen, setDialogOpen] = createSignal(false)
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

    // A side thread is an archived fork of the main session. The fork keeps the
    // full conversation context and streams text deltas like a normal session.
    const forkToMain = new Map<string, string>()
    for (const [mainSessionID, thread] of Object.entries(state.threads)) {
      if (thread.forkID) forkToMain.set(thread.forkID, mainSessionID)
    }
    const streamParts = new Map<string, Map<number, string>>()

    const threadForFork = (forkID: string) => {
      const mainSessionID = forkToMain.get(forkID)
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

    const finishFork = (forkID: string, error?: string) => {
      const found = threadForFork(forkID)
      if (!found) return
      const answer = mergedStream(forkID).trim()
      streamParts.delete(forkID)
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
      })
    }

    const stops = [
      context.data.on("session.text.delta", (event) => {
        if (!forkToMain.has(event.data.sessionID)) return
        updateStream(event.data.sessionID, event.data.ordinal, event.data.delta, false)
      }),
      context.data.on("session.text.ended", (event) => {
        if (!forkToMain.has(event.data.sessionID)) return
        updateStream(event.data.sessionID, event.data.ordinal, event.data.text, true)
      }),
      context.data.on("session.execution.succeeded", (event) => {
        if (!forkToMain.has(event.data.sessionID)) return
        finishFork(event.data.sessionID)
      }),
      context.data.on("session.execution.failed", (event) => {
        if (!forkToMain.has(event.data.sessionID)) return
        finishFork(event.data.sessionID, errorMessage(event.data.error))
      }),
      context.data.on("session.execution.interrupted", (event) => {
        if (!forkToMain.has(event.data.sessionID)) return
        finishFork(event.data.sessionID, "Side question interrupted")
      }),
    ]

    const ensureFork = async (mainSessionID: string) => {
      const current = state.threads[mainSessionID]
      if (current?.forkID) {
        const existing = await context.client.session.get({ sessionID: current.forkID }).catch(() => undefined)
        if (existing) {
          forkToMain.set(current.forkID, mainSessionID)
          return { id: current.forkID, created: false as const }
        }
        forkToMain.delete(current.forkID)
      }

      const fork = await context.client.session.fork({ sessionID: mainSessionID })
      forkToMain.set(fork.id, mainSessionID)
      const title = `${context.data.session.get(mainSessionID)?.title ?? "Session"} - side chat`
      await context.client.session
        .update({
          sessionID: fork.id,
          title,
          archived: true,
          permissions: [{ action: "*", resource: "*", effect: "deny" as const }],
        })
        .catch(() => undefined)
      return { id: fork.id, created: true as const }
    }

    const dropFork = async (forkID: string | undefined) => {
      if (!forkID) return
      forkToMain.delete(forkID)
      streamParts.delete(forkID)
      await context.client.session.remove({ sessionID: forkID }).catch(() => undefined)
    }

    const closeSide = async (sessionID: string, thread: Thread | undefined) => {
      await dropFork(thread?.forkID)
      await update((draft) => {
        delete draft.threads[sessionID]
      })
      context.ui.panel.close()
    }

    // The panel takes focus when it opens. Return focus to the session prompt so
    // the user can keep working while the side question stays visible.
    const focusSession = () => {
      setTimeout(() => {
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

    const askQuestion = (title: string, placeholder: string) =>
      new Promise<{ text: string; newChat: boolean } | undefined>((resolve) => {
        let settled = false
        const finish = (value?: { text: string; newChat: boolean }) => {
          if (settled) return
          settled = true
          context.ui.dialog.clear()
          resolve(value)
        }
        context.ui.dialog.set({ size: "xlarge", centered: true })
        context.ui.dialog.show(
          () => (
            <AskDialog
              context={context}
              title={title}
              placeholder={placeholder}
              onSubmit={(text, newChat) => finish({ text, newChat })}
              onCancel={() => finish(undefined)}
              cancelKey={keys.dialogCancel}
            />
          ),
          () => finish(undefined),
        )
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
      if (parsed.close) {
        await closeSide(sessionID, current)
        return
      }

      const canContinue = !parsed.reset && Boolean(current?.turns.length)
      let question = parsed.question
      let newChat = false
      if (!question) {
        setDialogOpen(true)
        try {
          const answer = await askQuestion(
            "/side",
            canContinue ? "Continue the side question" : "Ask anything",
          )
          question = answer?.text
          newChat = answer?.newChat ?? false
        } finally {
          setDialogOpen(false)
        }
      }
      if (!question) return

      const continuing = canContinue && !newChat
      const prior = continuing ? (current?.turns ?? []) : []
      const previousFork = !continuing ? current?.forkID : undefined

      await update((draft) => {
        const thread = draft.threads[sessionID] ?? (draft.threads[sessionID] = { turns: [] })
        if (!continuing) {
          thread.turns = []
          thread.forkID = undefined
        }
        thread.pending = question
        thread.streaming = ""
        thread.error = undefined
      })
      if (previousFork) void dropFork(previousFork)
      openPanel(keepPanelFocus)

      try {
        const fork = await ensureFork(sessionID)
        await update((draft) => {
          const thread = draft.threads[sessionID]
          if (thread) thread.forkID = fork.id
        })
        // A reused fork already holds the prior side turns. A new fork only has
        // the main session history, so replay the side thread when it starts over.
        const prompt =
          fork.created && prior.length ? buildPrompt(prior, question, true) : buildPrompt([], question, false)
        await context.client.session.prompt({ sessionID: fork.id, text: prompt })
      } catch (cause) {
        // If a fork cannot be created or prompted, fall back to the transient
        // generation API so the side question still gets an answer.
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
          run: (input) => ask(input),
        },
        {
          id: "session.aside.toggle",
          title: "Toggle side chat panel",
          group: "Session",
          palette: true,
          bind: keys.toggle,
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
          },
        },
        {
          id: "session.aside.focus",
          title: "Toggle side chat focus",
          group: "Session",
          palette: true,
          bind: keys.focus,
          run: () => {
            if (context.ui.panel.current()?.name !== PANEL) return
            context.keymap.dispatch(panelFocused() ? "pane.focus.left" : "pane.focus.right")
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
            dialogOpen={dialogOpen}
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

function parseSideInput(input?: string): { question?: string; reset?: boolean; close?: boolean } {
  const text = input?.trim()
  if (!text) return {}
  if (text === "--close") return { close: true }
  if (text === "--new") return { reset: true }
  if (text.startsWith("--new ")) {
    return { reset: true, question: text.slice("--new ".length).trim() || undefined }
  }
  return { question: text }
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
  onSubmit: (value: string, newChat: boolean) => void
  onCancel: () => void
  cancelKey: string | false
}) {
  const theme = props.context.theme
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
    <box
      flexDirection="column"
      gap={1}
      backgroundColor={theme.background.raised.base}
    >
      <box
        flexDirection="row"
        flexShrink={0}
        paddingLeft={3}
        paddingRight={2}
        gap={1}
      >
        <text
          attributes={TextAttributes.BOLD}
          fg={theme.text.base}
          flexGrow={1}
          wrapMode="none"
        >
          {props.title}
        </text>
        <text attributes={TextAttributes.DIM} fg={theme.text.muted}>
          esc
        </text>
      </box>
      <box paddingLeft={3} paddingRight={2}>
        <textarea
          ref={(value) => (textarea = value)}
          width="100%"
          minHeight={2}
          maxHeight={6}
          wrapMode="word"
          placeholder={props.placeholder}
          placeholderColor={theme.text.muted}
          textColor={theme.text.formfield.base}
          focusedTextColor={theme.text.formfield.base}
          backgroundColor={theme.background.raised.base}
          focusedBackgroundColor={theme.background.raised.base}
          cursorColor={theme.text.base}
          onSubmit={() => submit(false)}
        />
      </box>
      <box
        flexDirection="row"
        flexShrink={0}
        paddingLeft={3}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        backgroundColor={theme.decrease(theme.background.raised.base)}
      >
        <text wrapMode="none" flexShrink={0}>
          <span style={{ fg: theme.text.base }}>enter</span>
          <span style={{ fg: theme.text.muted }}> send · </span>
          <span style={{ fg: theme.text.base }}>ctrl+enter</span>
          <span style={{ fg: theme.text.muted }}> new · </span>
          <span style={{ fg: theme.text.base }}>shift+enter</span>
          <span style={{ fg: theme.text.muted }}> newline</span>
        </text>
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
  dialogOpen: () => boolean
  keys: PanelKeys
}) {
  const thread = () => props.state.threads[props.panel.sessionID]
  const focused = () => props.panel.focused
  const keyColor = () => (focused() ? props.theme.text.base : props.theme.text.action.primary.disabled)
  const labelColor = () => (focused() ? props.theme.text.muted : props.theme.text.action.primary.disabled)
  const dim = () => (focused() ? undefined : TextAttributes.DIM)
  createEffect(() => props.onFocus(props.panel.focused))
  const header = () =>
    `${props.context.data.session.get(props.panel.sessionID)?.title ?? "Session"} - side chat`
  let scroll: ScrollBoxRenderable | undefined
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
  const toBottom = () => {
    const run = () => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(scroll.scrollHeight)
    }
    // The panel mounts and the markdown reflows over the next few frames.
    // Scroll after each phase so reopening a long thread lands at the bottom.
    setTimeout(run, 0)
    setTimeout(run, 50)
    setTimeout(run, 200)
  }
  onMount(toBottom)
  createEffect(() => {
    thread()?.turns.length
    thread()?.pending
    toBottom()
  })

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
        run: () => scroll?.scrollBy(1),
      },
      {
        id: "session.aside.line.up",
        bind: props.keys.lineUp,
        title: "Scroll side chat up",
        group: "/side",
        run: () => scroll?.scrollBy(-1),
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
        run: () => scroll?.scrollTo(0),
      },
      {
        id: "session.aside.end",
        bind: props.keys.end,
        title: "Jump to bottom of side chat",
        group: "/side",
        run: () => {
          if (!scroll || scroll.isDestroyed) return
          scroll.scrollTo(scroll.scrollHeight)
        },
      },
    ],
  }))

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      minHeight={0}
      backgroundColor={props.theme.background.base}
    >
      <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
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
        ref={(value) => (scroll = value)}
        flexGrow={1}
        minHeight={0}
        stickyScroll
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
        paddingBottom={1}
        gap={1}
      >
        <text fg={keyColor()} attributes={dim()}>a</text>
        <text fg={labelColor()} attributes={dim()}>ask</text>
        <text fg={labelColor()} attributes={dim()}>·</text>
        <text fg={keyColor()} attributes={dim()}>f</text>
        <text fg={labelColor()} attributes={dim()}>fullscreen</text>
        <text fg={labelColor()} attributes={dim()}>·</text>
        <text fg={keyColor()} attributes={dim()}>esc</text>
        <text fg={labelColor()} attributes={dim()}>hide</text>
        <text fg={labelColor()} attributes={dim()}>·</text>
        <text fg={keyColor()} attributes={dim()}>x</text>
        <text fg={labelColor()} attributes={dim()}>close</text>
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
