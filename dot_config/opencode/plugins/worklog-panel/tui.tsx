import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import type {
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client"
import { SyntaxStyle, TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"
import { readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"

const PANEL = "jadon.worklog"
const TOGGLE_KEY = "alt+w"
type ToolGroup = "commands" | "edits" | "explored" | "subagents" | "thoughts" | "execute" | "other"
const GROUPS: readonly { id: ToolGroup; label: string }[] = [
  { id: "commands", label: "Commands" },
  { id: "edits", label: "Edits / writes" },
  { id: "explored", label: "Explored" },
  { id: "subagents", label: "Subagents" },
  { id: "thoughts", label: "Thoughts" },
  { id: "execute", label: "Execute" },
  { id: "other", label: "Other" },
]
const DEFAULT_GROUPS = GROUPS.map((group) => group.id)
const LEGACY_GROUPS: Record<string, ToolGroup> = {
  reads: "explored",
  searches: "explored",
  web: "explored",
}
type FilterState = { sessions: Record<string, string[]> }

function normalizeGroups(values: readonly string[]): ToolGroup[] {
  const next = new Set<ToolGroup>()
  for (const value of values) {
    const group = GROUPS.find((entry) => entry.id === value)
    if (group) next.add(group.id)
    else {
      const legacy = LEGACY_GROUPS[value]
      if (legacy) next.add(legacy)
    }
  }
  return [...next]
}

type WorkItem = {
  key: string
  depth: number
  tool: string
  status: SessionMessageAssistantTool["state"]["status"] | "running"
  input: Record<string, unknown>
  metadata: Record<string, unknown>
  output: string
  error?: string
  time: { created?: number; ran?: number; completed?: number }
  part?: SessionMessageAssistantTool
  message?: SessionMessageAssistant
  call?: ExecuteCall
  turn: string
  thought?: { text: string }
  children?: WorkItem[]
}

type WorkTurn = {
  key: string
  at: number
  kind: "user" | "assistant"
  items: WorkItem[]
}

type ItemRow = { key: string; kind: "item"; turnKey: string; item: WorkItem }
type DividerRow = {
  key: string
  kind: "divider"
  turnKey: string
  at: number
  variant: "user" | "assistant"
  counts: string
}
type Row = ItemRow | DividerRow

type WorkView = {
  sessionID: string
  title?: string
  selectedKey?: string
  detailKey?: string
  scrollTop?: number
  atBottom?: boolean
}

type ExecuteCall = {
  tool: string
  status: "running" | "completed" | "error"
  input?: Record<string, unknown>
}

const EXPLORATION = new Set(["read", "glob", "grep", "webfetch", "websearch"])
const FILES = new Set(["edit", "write", "patch"])
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

export default Plugin.define({
  id: "jadon.worklog",
  setup(context) {
    const theme = context.theme
    const [panelFocused, setPanelFocused] = createSignal(false)
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

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "session.worklog.toggle",
          title: "Toggle work log panel",
          group: "Session",
          bind: TOGGLE_KEY,
          palette: true,
          slash: { name: "worklog", aliases: ["wl"] },
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
            context.ui.panel.open(PANEL, { presentation: "panel" })
          },
        },
        {
          id: "session.worklog.resetwidth",
          title: "Reset panel width to default",
          group: "Session",
          bind: "alt+0",
          palette: true,
          enabled: () => context.ui.panel.current()?.name === PANEL,
          run: resetPanelWidth,
        },
        {
          id: "session.worklog.focus",
          title: "Toggle work log focus",
          group: "Session",
          bind: "alt+f",
          palette: true,
          enabled: () => context.ui.panel.current()?.name === PANEL,
          run: () => {
            if (panelFocused()) {
              focusSession()
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

    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <WorklogPanel
            context={context}
            panel={panel}
            syntax={syntax}
            theme={theme}
            onFocus={setPanelFocused}
          />
        </Show>
      ),
    })

    return () => syntax.destroy()
  },
})

function WorklogPanel(props: {
  context: Context
  panel: PanelInput
  syntax: SyntaxStyle
  theme: Context["theme"]
  onFocus: (focused: boolean) => void
}) {
  const theme = props.theme
  const focused = () => props.panel.focused
  const keyColor = () => (focused() ? theme.text.base : theme.text.action.primary.disabled)
  const labelColor = () => (focused() ? theme.text.muted : theme.text.action.primary.disabled)
  const dim = () => (focused() ? undefined : TextAttributes.DIM)

  createEffect(() => props.onFocus(props.panel.focused))

  const [path, setPath] = createSignal<WorkView[]>([{ sessionID: props.panel.sessionID }])
  const activeView = () => path().at(-1)!
  const activeSessionID = () => activeView().sessionID
  const isChild = () => path().length > 1
  const history = props.context.data.session.message as typeof props.context.data.session.message & {
    more?: (sessionID: string) => boolean
    loadMore?: (sessionID: string, options?: { all?: boolean }) => Promise<void>
  }
  const messages = createMemo(() => props.context.data.session.message.list(activeSessionID()) ?? [])
  const turns = createMemo(() => buildTurns(messages()))
  const [filters, updateFilters] = props.context.storage.store<FilterState>("filters", {
    initial: { sessions: {} },
  })
  const selectedGroups = createMemo(() => {
    const stored = filters.sessions[activeSessionID()]
    return new Set(stored === undefined ? DEFAULT_GROUPS : normalizeGroups(stored))
  })
  const projected = createMemo(() => buildRows(turns(), selectedGroups()))
  const setGroups = (next: ToolGroup[]) => {
    void updateFilters((draft) => {
      draft.sessions[activeSessionID()] = next
    })
  }
  const toggleGroup = (id: ToolGroup) => {
    const next = new Set(selectedGroups())
    if (next.has(id)) next.delete(id)
    else next.add(id)
    setGroups([...next])
  }
  const openFilter = () => {
    props.context.ui.dialog.set({ size: "small", centered: true })
    props.context.ui.dialog.show(
      () => (
        <FilterDialog
          context={props.context}
          theme={theme}
          selected={selectedGroups}
          onToggle={toggleGroup}
          onAll={() => setGroups([...DEFAULT_GROUPS])}
          onNone={() => setGroups([])}
          onClose={() => props.context.ui.dialog.clear()}
        />
      ),
      () => props.panel.focus(),
    )
  }
  const [rows, setRows] = createStore<Row[]>([])
  createEffect(
    on(projected, (next) => {
      setRows(reconcile(next, { key: "key" }))
    }),
  )

  const [selectedKey, setSelectedKey] = createSignal<string>()
  const [detailKey, setDetailKey] = createSignal<string>()
  const [expandedShells, setExpandedShells] = createSignal<Set<string>>(new Set())
  const [ready, setReady] = createSignal(false)
  const [loadingOlder, setLoadingOlder] = createSignal(false)

  const itemRows = createMemo(() => rows.filter((row): row is ItemRow => row.kind === "item"))
  const dividerRows = createMemo(() => rows.filter((row): row is DividerRow => row.kind === "divider"))
  const selectedIndex = createMemo(() => {
    const items = itemRows()
    const index = items.findIndex((row) => row.key === selectedKey())
    return index >= 0 ? index : Math.max(0, items.length - 1)
  })
  const selectedRow = createMemo(() => itemRows()[selectedIndex()])
  const selected = createMemo(() => selectedRow()?.item)
  const selectedTurn = createMemo(() => selectedRow()?.turnKey)
  const currentTurn = createMemo(() => {
    const key = selectedTurn()
    return key ? turns().find((turn) => turn.key === key) : undefined
  })

  let initialized = false
  createEffect(() => {
    const items = itemRows()
    if (!initialized) {
      if (items.length > 0) {
        initialized = true
        setSelectedKey(items.at(-1)!.key)
      }
      return
    }
    if (items.length > 0 && !items.some((row) => row.key === selectedKey())) setSelectedKey(items.at(-1)!.key)
  })

  let ensuredBatches = false
  const ensureBatches = async () => {
    // The session route owns the initial sync. Only extend the window, never
    // replace it, so the native transcript keeps whatever history it loaded.
    for (let page = 0; page < 20; page++) {
      if (messages().filter((message) => message.type === "user").length >= 2) break
      if (!history.more?.(activeSessionID())) break
      await history.loadMore?.(activeSessionID()).catch(() => undefined)
    }
    reveal(selectedKey())
  }
  createEffect(() => {
    if (isChild() || ensuredBatches || messages().length === 0) return
    ensuredBatches = true
    void ensureBatches()
  })

  const [spinnerTick, setSpinnerTick] = createSignal(0)
  const hasRunningThought = createMemo(() =>
    itemRows().some((row) => row.item.tool === "thought" && row.item.status === "running"),
  )
  createEffect(
    on(hasRunningThought, (running) => {
      if (!running) return
      const timer = setInterval(() => setSpinnerTick((value) => value + 1), 80)
      onCleanup(() => clearInterval(timer))
    }),
  )
  const spinner = () => SPINNER[spinnerTick() % SPINNER.length]!

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
      if (itemRows().length === 0 && tries < 30) {
        tries++
        return
      }
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
  const nodes = new Map<string, BoxRenderable>()
  const detailNodes = new Map<string, BoxRenderable>()
  const registerRow = (key: string, node: BoxRenderable | undefined) => {
    if (node) nodes.set(key, node)
    else nodes.delete(key)
  }
  const registerDetail = (key: string, node: BoxRenderable | undefined) => {
    if (node) detailNodes.set(key, node)
    else detailNodes.delete(key)
  }
  let scrollGeneration = 0
  const schedule = (delays: readonly number[], run: () => void) => {
    const generation = ++scrollGeneration
    for (const delay of delays)
      setTimeout(() => {
        if (generation === scrollGeneration) run()
      }, delay)
  }
  const reveal = (key?: string) => {
    const target = key ?? selected()?.key
    if (!target) return
    schedule([0, 50, 150], () => {
      const node = nodes.get(target)
      if (!node || node.isDestroyed || !scroll || scroll.isDestroyed) return
      const top = scroll.scrollTop + node.y - scroll.viewport.y
      const bottom = top + node.height
      if (top < scroll.scrollTop) scroll.scrollTo(Math.max(0, Math.min(maxScroll(), top)))
      else if (bottom > scroll.scrollTop + scroll.height)
        scroll.scrollTo(Math.max(0, Math.min(maxScroll(), bottom - scroll.height)))
    })
  }
  const revealExpanded = (key: string) => {
    schedule([0, 60, 160], () => {
      const node = nodes.get(key)
      if (!node || node.isDestroyed || !scroll || scroll.isDestroyed) return
      const detail = detailNodes.get(key)
      const top = scroll.scrollTop + node.y - scroll.viewport.y
      const bottom = detail && !detail.isDestroyed
        ? scroll.scrollTop + detail.y + detail.height - scroll.viewport.y
        : top + node.height
      const viewTop = scroll.scrollTop
      const viewBottom = viewTop + scroll.height
      if (top >= viewTop && bottom <= viewBottom) return
      scroll.scrollTo(Math.max(0, Math.min(maxScroll(), top - 1)))
    })
  }
  const select = (key: string | undefined) => {
    if (!key) return
    setSelectedKey(key)
    reveal(key)
  }
  const move = (delta: number) => {
    const items = itemRows()
    if (items.length === 0) return
    const next = items[Math.min(items.length - 1, Math.max(0, selectedIndex() + delta))]
    select(next?.key)
  }
  const page = (direction: 1 | -1) => {
    const items = itemRows()
    if (items.length === 0) return
    select(items[Math.min(items.length - 1, Math.max(0, selectedIndex() + direction * 10))]?.key)
  }
  const top = () => {
    const first = itemRows()[0]
    if (first) setSelectedKey(first.key)
    schedule([0, 60, 160], () => {
      if (!scroll || scroll.isDestroyed) return
      scroll.scrollTo(0)
      resetScrollSettling()
    })
  }
  const bottom = () => select(itemRows().at(-1)?.key)
  let viewGeneration = 0
  const saveCurrentView = () => {
    const stack = path()
    const current = stack.at(-1)
    if (!current) return
    const atBottom = scroll && !scroll.isDestroyed ? scroll.scrollTop >= maxScroll() - 1 : undefined
    const updated: WorkView = {
      ...current,
      selectedKey: selectedKey(),
      detailKey: detailKey(),
      scrollTop: scroll && !scroll.isDestroyed ? scroll.scrollTop : undefined,
      atBottom,
    }
    setPath([...stack.slice(0, -1), updated])
  }
  const settleView = (target: "bottom" | number) => {
    setReady(false)
    const generation = ++viewGeneration
    const apply = () => {
      if (generation !== viewGeneration) return
      if (!scroll || scroll.isDestroyed) return
      const limit = maxScroll()
      scroll.scrollTo(target === "bottom" ? limit : Math.max(0, Math.min(limit, target)))
    }
    for (const delay of [0, 60, 160]) setTimeout(apply, delay)
    setTimeout(() => {
      if (generation !== viewGeneration) return
      apply()
      setReady(true)
    }, 220)
  }
  createEffect(
    on(
      () => props.panel.sessionID,
      (sessionID, previous) => {
        if (previous === undefined || previous === sessionID) return
        initialized = false
        ensuredBatches = false
        setPath([{ sessionID }])
        setSelectedKey(undefined)
        setDetailKey(undefined)
        setLoadingOlder(false)
        settleView("bottom")
      },
      { defer: true },
    ),
  )
  const goBack = () => {
    const stack = path()
    if (stack.length <= 1) return
    const parent = stack[stack.length - 2]!
    setPath(stack.slice(0, -1))
    setSelectedKey(parent.selectedKey)
    setDetailKey(parent.detailKey)
    settleView(parent.atBottom ? "bottom" : parent.scrollTop ?? "bottom")
  }
  const enterChild = async (sessionID: string, title?: string) => {
    saveCurrentView()
    setPath((previous) => [...previous, { sessionID, title }])
    setSelectedKey(undefined)
    setDetailKey(undefined)
    setLoadingOlder(false)
    setReady(false)
    let failed = false
    await Promise.all([
      props.context.data.session.sync(sessionID).catch(() => {
        failed = true
      }),
      props.context.data.session.message.sync(sessionID).catch(() => {
        failed = true
      }),
    ])
    if (activeSessionID() !== sessionID) return
    if (failed) {
      props.context.ui.toast.show({ message: "Subagent session could not be loaded", variant: "warning" })
      goBack()
      return
    }
    settleView("bottom")
  }
  const toggleDetail = () => {
    const item = selected()
    if (!item) return
    // Subagents open their child session as a nested work log. The other
    // non-expandable rows stay inert; exploration groups expand inline.
    if (item.tool === "subagent") {
      const child = subagentSessionID(item)
      if (!child) {
        props.context.ui.toast.show({ message: "Subagent session is not available", variant: "warning" })
        return
      }
      void enterChild(child, stringValue(item.input.description))
      return
    }
    if (item.tool === "thought" || item.tool === "skill" || EXPLORATION.has(item.tool)) return
    const open = detailKey() !== item.key
    setDetailKey(open ? item.key : undefined)
    if (open) revealExpanded(item.key)
    else reveal(item.key)
  }
  const toggleShell = (key: string) => {
    const expanding = !expandedShells().has(key)
    setExpandedShells((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
    if (expanding) revealExpanded(key)
  }
  const toggleSelectedShell = () => {
    const item = selected()
    if (!item || item.tool !== "shell") return
    if (detailKey() !== item.key) {
      setDetailKey(item.key)
      setExpandedShells((previous) => new Set(previous).add(item.key))
      revealExpanded(item.key)
    } else {
      toggleShell(item.key)
    }
  }

  const loadOlder = async () => {
    if (loadingOlder()) return
    const anchor = selected()?.key
    if (!history.more?.(activeSessionID())) return
    setLoadingOlder(true)
    try {
      for (let page = 0; page < 12; page++) {
        if (!history.more?.(activeSessionID())) break
        await history.loadMore?.(activeSessionID()).catch(() => undefined)
        const list = dividerRows()
        const currentKey = itemRows().find((row) => row.key === anchor)?.turnKey
        const position = list.findIndex((row) => row.turnKey === currentKey)
        if (position > 0) {
          const first = itemRows().find((row) => row.turnKey === list[position - 1]!.turnKey)
          select(first?.key)
          break
        }
        if (position < 0) break
      }
      reveal(selectedKey())
    } finally {
      setLoadingOlder(false)
    }
  }
  const jumpTurn = (direction: 1 | -1) => {
    const list = dividerRows()
    if (list.length === 0) return
    const current = list.findIndex((row) => row.turnKey === selectedTurn())
    const index = (current < 0 ? list.length - 1 : current) + direction
    if (index < 0) {
      void loadOlder()
      return
    }
    if (index >= list.length) return
    const target = list[index]!
    const first = itemRows().find((row) => row.turnKey === target.turnKey)
    select(first?.key)
  }
  props.context.keymap.layer(() => ({
    mode: "global",
    priority: 10,
    enabled: () => props.panel.focused,
    commands: [
      { id: "session.worklog.next", bind: "j,down", title: "Next work item", group: "Work log", run: () => move(1) },
      {
        id: "session.worklog.previous",
        bind: "k,up",
        title: "Previous work item",
        group: "Work log",
        run: () => move(-1),
      },
      {
        id: "session.worklog.detail",
        bind: "return",
        title: "Toggle work item detail",
        group: "Work log",
        run: toggleDetail,
      },
      {
        id: "session.worklog.shell",
        bind: "space",
        title: "Expand shell output",
        group: "Work log",
        run: toggleSelectedShell,
      },
      {
        id: "session.worklog.page.down",
        bind: "pagedown,ctrl+d",
        title: "Next page",
        group: "Work log",
        run: () => page(1),
      },
      {
        id: "session.worklog.page.up",
        bind: "pageup,ctrl+u",
        title: "Previous page",
        group: "Work log",
        run: () => page(-1),
      },
      { id: "session.worklog.top", bind: "g,home", title: "First work item", group: "Work log", run: top },
      {
        id: "session.worklog.bottom",
        bind: "shift+g,end",
        title: "Last work item",
        group: "Work log",
        run: bottom,
      },
      {
        id: "session.worklog.scroll.down",
        bind: "alt+j",
        title: "Scroll work log down",
        group: "Work log",
        run: () => clampScrollBy(2),
      },
      {
        id: "session.worklog.scroll.up",
        bind: "alt+k",
        title: "Scroll work log up",
        group: "Work log",
        run: () => clampScrollBy(-2),
      },
      {
        id: "session.worklog.turn.previous",
        bind: "[",
        title: "Previous work batch",
        group: "Work log",
        run: () => jumpTurn(-1),
      },
      {
        id: "session.worklog.turn.next",
        bind: "]",
        title: "Next work batch",
        group: "Work log",
        run: () => jumpTurn(1),
      },
      {
        id: "session.worklog.filter",
        bind: "t",
        title: "Choose work log tools",
        group: "Work log",
        run: openFilter,
      },
      {
        id: "session.worklog.fullscreen",
        bind: "f",
        title: "Toggle work log fullscreen",
        group: "Work log",
        run: () => props.panel.toggleFullscreen(),
      },
      {
        id: "session.worklog.back",
        bind: "backspace",
        title: "Back to parent work log",
        group: "Work log",
        enabled: () => isChild(),
        run: goBack,
      },
      {
        id: "session.worklog.hide",
        bind: "escape,q",
        title: "Hide work log",
        group: "Work log",
        run: () => {
          if (isChild()) goBack()
          else props.panel.close()
        },
      },
    ],
  }))

  const sessionTitle = () => {
    const view = activeView()
    const title = props.context.data.session.get(view.sessionID)?.title ?? view.title ?? "Session"
    return `${title} - work log`
  }
  const turnLabel = () => {
    const turn = currentTurn()
    if (!turn) return "No work yet"
    const list = dividerRows()
    const position = list.findIndex((row) => row.turnKey === turn.key)
    const numbering = position >= 0 ? `Batch ${position + 1}/${list.length} · ` : "Batch · "
    return `${numbering}${timeLabel(turn.at)} · ${countLabel(turn)}`
  }
  const filterText = () => {
    const selected = selectedGroups()
    if (selected.size === GROUPS.length) return "All"
    const hidden = GROUPS.filter((group) => !selected.has(group.id)).map((group) => group.label)
    return hidden.length === 1 ? `Hide ${hidden[0]}` : `Show ${selected.size}/${GROUPS.length}`
  }
  const emptyLabel = () =>
    selectedGroups().size === GROUPS.length ? "No work yet." : "No work items match the filter."

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} marginTop={-1} backgroundColor={theme.background.base}>
      <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} gap={1}>
        <text
          attributes={focused() ? TextAttributes.BOLD : TextAttributes.BOLD | TextAttributes.DIM}
          fg={keyColor()}
          flexGrow={1}
          minWidth={0}
          wrapMode="none"
          truncate
        >
          {sessionTitle()}
        </text>
        <text fg={labelColor()} attributes={dim()} flexShrink={0} wrapMode="none" truncate>
          {filterText()}
        </text>
      </box>
      <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
        <text fg={labelColor()} attributes={dim()} wrapMode="none" truncate flexGrow={1} minWidth={0}>
          {turnLabel()}
        </text>
        <Show when={isChild()}>
          <text fg={labelColor()} attributes={dim()} flexShrink={0} wrapMode="none">
            ‹ back
          </text>
        </Show>
        <Show when={loadingOlder()}>
          <text fg={labelColor()} attributes={dim()}>
            · loading older…
          </text>
        </Show>
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
        viewportCulling={false}
        opacity={ready() ? 1 : 0}
        verticalScrollbarOptions={{
          paddingLeft: 1,
          visible: true,
          trackOptions: {
            backgroundColor: "transparent",
            foregroundColor: theme.hue.neutral[700],
          },
        }}
      >
        <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1}>
          <Show
            when={rows.length > 0}
            fallback={
              <box paddingLeft={1} paddingTop={1}>
                <text fg={theme.text.muted}>{emptyLabel()}</text>
              </box>
            }
          >
            <For each={rows}>
              {(row, index) => (
                <Switch>
                  <Match when={row.kind === "divider"}>
                    <BatchDivider row={row as DividerRow} theme={theme} first={index() === 0} />
                  </Match>
                  <Match when={row.kind === "item"}>
                    <WorkRow
                      row={row as ItemRow}
                      selected={selectedRow()?.key === row.key}
                      theme={theme}
                      context={props.context}
                      spinner={spinner}
                      register={(node) => registerRow(row.key, node)}
                      onSelect={() => {
                        select(row.key)
                        props.panel.focus()
                      }}
                      onToggle={() => {
                        if (selected()?.key !== row.key) select(row.key)
                        toggleDetail()
                      }}
                    />
                    <Show when={detailKey() === row.key}>
                      <box
                        ref={(node) => registerDetail(row.key, node)}
                        flexDirection="column"
                        flexShrink={0}
                      >
                        <Show
                          when={(row as ItemRow).item.tool === "exploration"}
                          fallback={
                            <WorkDetail
                              item={(row as ItemRow).item}
                              theme={theme}
                              context={props.context}
                              syntax={props.syntax}
                              width={props.panel.width}
                              shellExpanded={expandedShells().has(row.key)}
                              onToggleShell={() => toggleShell(row.key)}
                            />
                          }
                        >
                          <ExplorationChildren item={(row as ItemRow).item} theme={theme} context={props.context} />
                        </Show>
                      </box>
                    </Show>
                  </Match>
                </Switch>
              )}
            </For>
          </Show>
        </box>
      </scrollbox>

      <box height={2} flexShrink={0} />

      <box
        flexDirection="row"
        flexShrink={0}
        flexWrap="wrap"
        paddingLeft={2}
        paddingRight={2}
        paddingBottom={1}
        gap={1}
      >
        <KeyHint key="j/k" label="move" focused={focused()} theme={theme} />
        <Dot focused={focused()} theme={theme} />
        <KeyHint key="enter" label="detail" focused={focused()} theme={theme} />
        <Dot focused={focused()} theme={theme} />
        <KeyHint key="[ ]" label="batch" focused={focused()} theme={theme} />
        <Dot focused={focused()} theme={theme} />
        <KeyHint key="t" label="filter" focused={focused()} theme={theme} />
        <Dot focused={focused()} theme={theme} />
        <KeyHint key="f" label="fullscreen" focused={focused()} theme={theme} />
        <Dot focused={focused()} theme={theme} />
        <KeyHint key="esc" label={isChild() ? "back" : "hide"} focused={focused()} theme={theme} />
      </box>
    </box>
  )
}

function BatchDivider(props: { row: DividerRow; theme: Context["theme"]; first: boolean }) {
  return (
    <box
      border={props.first ? false : ["top"]}
      borderColor={props.first ? undefined : props.theme.decrease(props.theme.background.base)}
      marginTop={props.first ? 0 : 1}
      paddingTop={props.first ? 0 : 1}
    >
      <text fg={props.theme.text.muted} attributes={TextAttributes.DIM} wrapMode="none" truncate>
        {props.row.variant === "assistant" ? "Assistant" : "Batch"} · {timeLabel(props.row.at)} ·{" "}
        {props.row.counts}
      </text>
    </box>
  )
}

function WorkRow(props: {
  row: ItemRow
  selected: boolean
  theme: Context["theme"]
  context: Context
  spinner: () => string
  register: (node: BoxRenderable | undefined) => void
  onSelect: () => void
  onToggle: () => void
}) {
  const item = () => props.row.item
  const thought = () => item().tool === "thought"
  const color = () => {
    if (thought()) return props.theme.text.feedback.warning.base
    if (item().status === "error") return props.theme.text.feedback.error.base
    if (props.selected) return props.theme.text.base
    return props.theme.text.muted
  }
  const duration = () => (thought() || item().tool === "exploration" ? "" : itemDuration(item()))
  const summary = () => summarize(item(), props.context).replace(/\s+/g, " ").trim()
  const rowIcon = () => {
    if (!thought()) return icon(item())
    return item().status === "running" ? props.spinner() : "✻"
  }
  return (
    <box
      ref={(node) => props.register(node)}
      flexDirection="row"
      flexShrink={0}
      paddingLeft={1}
      onMouseUp={() => {
        if (props.context.renderer.getSelection()?.getSelectedText()) return
        if (!props.selected) props.onSelect()
        props.onToggle()
      }}
    >
      <text width={1} fg={props.selected ? props.theme.hue.interactive[200] : undefined}>
        {props.selected ? "▌" : " "}
      </text>
      <text width={2} fg={color()}>
        {rowIcon()}
      </text>
      <box paddingLeft={item().depth > 0 ? 2 : 0} flexGrow={1} minWidth={0}>
        <text fg={color()} wrapMode="none" truncate attributes={props.selected ? TextAttributes.BOLD : undefined}>
          {summary()}
        </text>
      </box>
      <Show when={duration()}>
        <box width={1} flexShrink={0} />
        <text fg={props.theme.text.muted} flexShrink={0}>
          {duration()}
        </text>
      </Show>
    </box>
  )
}

function WorkDetail(props: {
  item: WorkItem
  theme: Context["theme"]
  context: Context
  syntax: SyntaxStyle
  width: number
  shellExpanded: boolean
  onToggleShell: () => void
}) {
  const theme = () => props.theme
  const item = () => props.item
  const maxPathWidth = () => Math.max(12, (props.width ?? 60) - 14)
  return (
    <box paddingLeft={3} flexShrink={0} paddingBottom={1}>
      <box
        flexDirection="column"
        gap={1}
        border={["left"]}
        borderColor={theme().background.base}
        backgroundColor={theme().background.raised.base}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
      >
        <Show when={item().tool === "shell"}>
          {(() => {
            const collapsed = collapsedShell(item(), props.context, props.width)
            const expandable = collapsed.overflow || isBackground(item())
            return (
              <box
                flexDirection="column"
                gap={1}
                onMouseUp={() => {
                  if (!expandable || props.context.renderer.getSelection()?.getSelectedText()) return
                  props.onToggleShell()
                }}
              >
                <text fg={theme().text.base} wrapMode="word">
                  {props.shellExpanded && expandable ? shellCommand(item(), props.context) : collapsed.input}
                </text>
                <Show when={item().output}>
                  <text fg={theme().text.muted} wrapMode="word">
                    {props.shellExpanded && expandable ? capLines(item().output, 300) : collapsed.output}
                  </text>
                </Show>
                <Show when={isBackground(item())}>
                  <text fg={theme().text.muted} bg={theme().decrease(theme().background.base)}>
                    {" Background "}
                  </text>
                </Show>
                <Show when={expandable}>
                  <text fg={theme().text.muted}>
                    {props.shellExpanded ? "Click to collapse" : "Click to expand"}
                  </text>
                </Show>
              </box>
            )
          })()}
        </Show>

        <Show when={item().tool === "edit" || item().tool === "patch"}>
          <For each={parseApplyPatchFiles(item().metadata.files)}>
            {(file) => (
              <box flexDirection="column" gap={1}>
                <text fg={theme().text.muted} wrapMode="none" truncate>
                  {fileLabel(file)} {middle(displayPath(props.context, file.relativePath), maxPathWidth())}
                </text>
                <diff
                  diff={file.patch}
                  filetype={filetype(file.relativePath)}
                  syntaxStyle={props.syntax}
                  view="unified"
                  wrapMode="word"
                  fg={theme().text.base}
                  addedBg={theme().diff.background.added}
                  removedBg={theme().diff.background.removed}
                  contextBg={theme().diff.background.context}
                  addedSignColor={theme().diff.highlight.added}
                  removedSignColor={theme().diff.highlight.removed}
                  lineNumberFg={theme().diff.lineNumber.text}
                  lineNumberBg={theme().diff.background.context}
                  addedLineNumberBg={theme().diff.lineNumber.background.added}
                  removedLineNumberBg={theme().diff.lineNumber.background.removed}
                />
              </box>
            )}
          </For>
          <Show when={parseApplyPatchFiles(item().metadata.files).length === 0}>
            <text fg={theme().text.muted}>Preparing edit…</text>
          </Show>
        </Show>

        <Show when={item().tool === "write"}>
          <text fg={theme().text.muted} wrapMode="none" truncate>
            # Wrote {middle(displayPath(props.context, stringValue(item().input.path)), maxPathWidth())}
          </text>
          <line_number fg={theme().text.muted} minWidth={3} paddingRight={1}>
            <code
              conceal={false}
              fg={theme().text.base}
              filetype={filetype(stringValue(item().input.path))}
              syntaxStyle={props.syntax}
              content={capLines(stringValue(item().input.content) ?? "", 200)}
            />
          </line_number>
        </Show>

        <Show when={item().tool === "execute"}>
          <text fg={theme().text.muted} attributes={TextAttributes.BOLD}>
            Code
          </text>
          <Show when={executeCode(item())} fallback={<text fg={theme().text.muted}>Waiting for code…</text>}>
            {(code) => (
              <line_number fg={theme().text.muted} minWidth={3} paddingRight={1}>
                <code
                  conceal={false}
                  fg={theme().text.base}
                  filetype="typescript"
                  syntaxStyle={props.syntax}
                  content={capLines(code(), 200)}
                />
              </line_number>
            )}
          </Show>
          <text fg={theme().text.muted} attributes={TextAttributes.BOLD}>
            Output
          </text>
          <Show
            when={!item().error}
            fallback={
              <text fg={theme().text.feedback.error.base} wrapMode="word">
                {item().error}
              </text>
            }
          >
            <Show when={item().output} fallback={<text fg={theme().text.muted}>No output</text>}>
              <Show
                when={jsonOutput(item().output)}
                fallback={
                  <text
                    fg={item().status === "error" ? theme().text.feedback.error.base : theme().text.base}
                    wrapMode="word"
                  >
                    {capLines(item().output, 300)}
                  </text>
                }
              >
                {(parsed) => (
                  <>
                    <line_number fg={theme().text.muted} minWidth={3} paddingRight={1}>
                      <code
                        conceal={false}
                        fg={theme().text.base}
                        filetype="json"
                        syntaxStyle={props.syntax}
                        content={parsed().json}
                      />
                    </line_number>
                    <Show when={parsed().rest}>
                      <text fg={theme().text.base} wrapMode="word">
                        {parsed().rest}
                      </text>
                    </Show>
                  </>
                )}
              </Show>
            </Show>
          </Show>
        </Show>

        <Show
          when={
            ![
              "shell",
              "edit",
              "patch",
              "write",
              "read",
              "glob",
              "grep",
              "webfetch",
              "websearch",
              "subagent",
              "thought",
              "execute",
              "skill",
            ].includes(item().tool)
          }
        >
          <For each={Object.entries(item().input)}>
            {([key, value]) => (
              <box flexDirection="row">
                <text flexShrink={0} fg={theme().text.muted}>
                  {key}:{" "}
                </text>
                <text flexGrow={1} fg={theme().text.base} wrapMode="word">
                  {typeof value === "string" ? capLines(value, 60) : capLines(JSON.stringify(value, null, 2), 60)}
                </text>
              </box>
            )}
          </For>
          <Show when={item().output}>
            <text fg={theme().text.muted} wrapMode="word">
              {capLines(item().output, 200)}
            </text>
          </Show>
        </Show>

        <Show when={item().error && item().tool !== "execute"}>
          <text fg={theme().text.feedback.error.base} wrapMode="word">
            {item().error}
          </text>
        </Show>
      </box>
    </box>
  )
}

function FilterDialog(props: {
  context: Context
  theme: Context["theme"]
  selected: () => ReadonlySet<ToolGroup>
  onToggle: (id: ToolGroup) => void
  onAll: () => void
  onNone: () => void
  onClose: () => void
}) {
  const [index, setIndex] = createSignal(0)
  const move = (delta: number) => setIndex((value) => Math.min(GROUPS.length - 1, Math.max(0, value + delta)))
  props.context.keymap.layer(() => ({
    mode: "modal",
    priority: 20,
    commands: [
      { bind: "j,down", title: "Next filter row", group: "Work log filter", run: () => move(1) },
      { bind: "k,up", title: "Previous filter row", group: "Work log filter", run: () => move(-1) },
      {
        bind: "space,return",
        title: "Toggle filter row",
        group: "Work log filter",
        run: () => {
          const group = GROUPS[index()]
          if (group) props.onToggle(group.id)
        },
      },
      { bind: "a", title: "Show all tools", group: "Work log filter", run: props.onAll },
      { bind: "n", title: "Hide all tools", group: "Work log filter", run: props.onNone },
      { bind: "escape,q", title: "Close filter", group: "Work log filter", run: props.onClose },
    ],
  }))

  return (
    <box
      flexDirection="column"
      paddingLeft={3}
      paddingRight={3}
      paddingTop={1}
      paddingBottom={1}
      gap={1}
      backgroundColor={props.theme.background.raised.base}
    >
      <box flexDirection="row" flexShrink={0}>
        <text fg={props.theme.text.base} attributes={TextAttributes.BOLD} flexGrow={1}>
          Tool filter
        </text>
        <text fg={props.theme.text.muted} attributes={TextAttributes.DIM}>
          esc
        </text>
      </box>
      <box flexDirection="column">
        <For each={GROUPS}>
          {(group, i) => {
            const active = () => i() === index()
            const checked = () => props.selected().has(group.id)
            const fg = () =>
              active()
                ? props.theme.hue.accent[200]
                : checked()
                  ? props.theme.hue.interactive[200]
                  : props.theme.text.muted
            return (
              <box
                flexDirection="row"
                paddingLeft={1}
                paddingRight={1}
                onMouseUp={() => {
                  setIndex(i())
                  props.onToggle(group.id)
                }}
              >
                <text width={4} fg={fg()}>
                  {checked() ? "[x]" : "[ ]"}
                </text>
                <text fg={fg()}>{group.label}</text>
              </box>
            )
          }}
        </For>
      </box>
      <text wrapMode="none" truncate flexShrink={0}>
        <span style={{ fg: props.theme.text.base }}>j/k</span>
        <span style={{ fg: props.theme.text.muted }}> move · </span>
        <span style={{ fg: props.theme.text.base }}>space</span>
        <span style={{ fg: props.theme.text.muted }}> toggle · </span>
        <span style={{ fg: props.theme.text.base }}>a</span>
        <span style={{ fg: props.theme.text.muted }}> all · </span>
        <span style={{ fg: props.theme.text.base }}>n</span>
        <span style={{ fg: props.theme.text.muted }}> none</span>
      </text>
    </box>
  )
}

function ExplorationChildren(props: { item: WorkItem; theme: Context["theme"]; context: Context }) {
  return (
    <box flexDirection="column" paddingLeft={3} paddingBottom={1} flexShrink={0}>
      <For each={props.item.children ?? []}>
        {(child) => (
          <box flexDirection="row" paddingLeft={1}>
            <text
              width={2}
              fg={child.status === "error" ? props.theme.text.feedback.error.base : props.theme.text.muted}
            >
              {icon(child)}
            </text>
            <box flexGrow={1} minWidth={0}>
              <text
                fg={child.status === "error" ? props.theme.text.feedback.error.base : props.theme.text.muted}
                wrapMode="none"
                truncate
              >
                {summarize(child, props.context).replace(/\s+/g, " ").trim()}
              </text>
            </box>
            <Show when={itemDuration(child)}>
              <box width={1} flexShrink={0} />
              <text fg={props.theme.text.muted} flexShrink={0}>
                {itemDuration(child)}
              </text>
            </Show>
          </box>
        )}
      </For>
    </box>
  )
}

function KeyHint(props: { key: string; label: string; focused: boolean; theme: Context["theme"] }) {
  return (
    <>
      <text
        fg={props.focused ? props.theme.text.base : props.theme.text.action.primary.disabled}
        attributes={props.focused ? undefined : TextAttributes.DIM}
      >
        {props.key}
      </text>
      <text
        fg={props.focused ? props.theme.text.muted : props.theme.text.action.primary.disabled}
        attributes={props.focused ? undefined : TextAttributes.DIM}
      >
        {props.label}
      </text>
    </>
  )
}

function Dot(props: { focused: boolean; theme: Context["theme"] }) {
  return (
    <text
      fg={props.focused ? props.theme.text.muted : props.theme.text.action.primary.disabled}
      attributes={props.focused ? undefined : TextAttributes.DIM}
    >
      ·
    </text>
  )
}

// ---------------------------------------------------------------------------
// Projection

function buildTurns(messages: readonly SessionMessageInfo[]): WorkTurn[] {
  const turns: WorkTurn[] = []
  let current: WorkTurn | undefined
  const start = (key: string, at: number, kind: WorkTurn["kind"]) => {
    current = { key, at, kind, items: [] }
    turns.push(current)
    return current
  }
  const ensure = (at: number, key: string) => current ?? start(key, at, "assistant")

  for (const message of messages) {
    if (message.type === "user") {
      start(message.id, message.time.created, "user")
      continue
    }
    if (message.type !== "assistant") continue
    let textOrdinal = 0
    let reasoningOrdinal = 0
    for (const part of message.content) {
      if (part.type === "tool") {
        const turn = ensure(message.time.created, `start:${message.id}`)
        const key = `${message.id}:${part.id}`
        turn.items.push(itemFromPart(part, message, key, 0, turn.key))
        if (canonicalToolName(part.name) !== "execute") continue
        const calls = executeCalls(part.state.status === "streaming" ? undefined : part.state.metadata?.toolCalls)
        calls.forEach((call, index) => {
          turn.items.push({
            key: `${key}:call:${index}`,
            depth: 1,
            tool: canonicalToolName(call.tool),
            status: call.status,
            input: call.input ?? {},
            metadata: {},
            output: "",
            time: {},
            call,
            turn: turn.key,
          })
        })
        continue
      }
      if (part.type === "reasoning") {
        const text = part.text.replace("[REDACTED]", "").trim()
        if (!text) continue
        const turn = ensure(message.time.created, `start:${message.id}`)
        const key = `${message.id}:reasoning:${reasoningOrdinal++}`
        turn.items.push(thoughtFromPart(part, message, key, turn.key))
        continue
      }
      if (part.type === "text") {
        if (!part.text.trim()) continue
        textOrdinal++
        // A text part closes the current activity group in the native
        // transcript. Keep the break only once the current batch has work.
        if (current && current.items.length > 0) {
          start(`text:${message.id}:${textOrdinal}`, message.time.created, "assistant")
        }
      }
    }
  }
  for (const turn of turns) turn.items = groupExploration(turn.items)
  return turns
}

function groupExploration(items: WorkItem[]): WorkItem[] {
  const result: WorkItem[] = []
  let run: WorkItem[] = []
  const flush = () => {
    if (run.length === 0) return
    const first = run[0]!
    result.push({
      key: `explore:${first.key}`,
      depth: first.depth,
      tool: "exploration",
      status: run.some((item) => item.status === "running" || item.status === "streaming") ? "running" : "completed",
      input: {},
      metadata: {},
      output: "",
      time: {},
      turn: first.turn,
      children: run,
    })
    run = []
  }
  for (const item of items) {
    if (item.depth === 0 && EXPLORATION.has(item.tool)) {
      run.push(item)
      continue
    }
    flush()
    result.push(item)
  }
  flush()
  return result
}

function buildRows(turns: readonly WorkTurn[], selected: ReadonlySet<ToolGroup>): Row[] {
  const rows: Row[] = []
  for (const turn of turns) {
    const items = turn.items.flatMap((item) => {
      if (item.tool === "exploration") {
        const children = (item.children ?? []).filter((child) => matches(child, selected))
        if (children.length === 0) return []
        const active = children.some((child) => child.status === "running" || child.status === "streaming")
        return [{ ...item, children, status: active ? "running" as const : "completed" as const }]
      }
      return matches(item, selected) ? [item] : []
    })
    if (items.length === 0) continue
    rows.push({
      key: `divider:${turn.key}`,
      kind: "divider",
      turnKey: turn.key,
      at: turn.at,
      variant: turn.kind,
      counts: countLabel(turn),
    })
    for (const item of items) rows.push({ key: item.key, kind: "item", turnKey: turn.key, item })
  }
  return rows
}

function itemFromPart(
  part: SessionMessageAssistantTool,
  message: SessionMessageAssistant,
  key: string,
  depth: number,
  turn: string,
): WorkItem {
  const state = part.state
  return {
    key,
    depth,
    tool: canonicalToolName(part.name),
    status: state.status,
    input: typeof state.input === "string" ? {} : state.input,
    metadata: state.status === "streaming" ? {} : (state.metadata ?? {}),
    output: toolOutput(part),
    error: state.status === "error" ? stripAnsi(state.error.message) : undefined,
    time: part.time,
    part,
    message,
    turn,
  }
}

function thoughtFromPart(
  part: SessionMessageAssistantReasoning,
  message: SessionMessageAssistant,
  key: string,
  turn: string,
): WorkItem {
  const completed = part.time.completed !== undefined || message.time.completed !== undefined
  return {
    key,
    depth: 0,
    tool: "thought",
    status: completed ? "completed" : "running",
    input: {},
    metadata: {},
    output: "",
    time: part.time,
    message,
    turn,
    thought: { text: part.text },
  }
}

function groupForTool(tool: string): ToolGroup {
  if (tool === "shell") return "commands"
  if (FILES.has(tool)) return "edits"
  if (EXPLORATION.has(tool) || tool === "exploration") return "explored"
  if (tool === "subagent") return "subagents"
  if (tool === "thought") return "thoughts"
  if (tool === "execute") return "execute"
  return "other"
}

function matches(item: WorkItem, selected: ReadonlySet<ToolGroup>) {
  return selected.has(groupForTool(item.tool))
}

// ---------------------------------------------------------------------------
// Native-like summaries

function explorationLabel(item: WorkItem) {
  const counts = new Map<string, number>()
  for (const child of item.children ?? []) {
    const name =
      child.tool === "glob" || child.tool === "grep" || child.tool === "websearch"
        ? "search"
        : child.tool === "webfetch"
          ? "fetch"
          : child.tool
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  const names = [...counts].map(
    ([name, count]) =>
      `${count} ${count === 1 ? name : name === "search" || name === "fetch" ? `${name}es` : `${name}s`}`,
  )
  return `${item.status === "running" ? "Exploring" : "Explored"}: ${names.join(", ") || "nothing"}`
}

function subagentSessionID(item: WorkItem) {
  const metadata = item.metadata
  const id =
    stringValue(metadata.sessionId) ??
    stringValue(metadata.sessionID) ??
    stringValue(metadata.childID) ??
    stringValue(metadata.childId)
  if (id) return id
  return item.output.match(/<task\s+id=["'](ses_[^"']+)["']/)?.[1]
}

function summarize(item: WorkItem, context: Context) {
  if (item.call) return executeCallSummary(item.call)
  const input = item.input
  switch (item.tool) {
    case "exploration":
      return explorationLabel(item)
    case "thought":
      return item.status === "running" ? "Thinking…" : `Thought${itemDuration(item) ? ` · ${itemDuration(item)}` : ""}`
    case "shell":
      return shellCommand(item, context)
    case "edit":
      return `Edit ${displayPath(context, editPath(item))}`
    case "patch":
      return `Patch ${displayPath(context, editPath(item))}`
    case "write":
      return `Wrote ${displayPath(context, stringValue(input.path))}`
    case "read":
      return `Read ${displayPath(context, stringValue(input.path))}${readRange(item)}`
    case "glob":
      return `Glob "${stringValue(input.pattern)}"${input.path ? ` in ${displayPath(context, stringValue(input.path))}` : ""}${countMatches(item) ? ` (${countMatches(item)})` : ""}`
    case "grep":
      return `Grep "${stringValue(input.pattern)}"${input.path ? ` in ${displayPath(context, stringValue(input.path))}` : ""}${countMatches(item) ? ` (${countMatches(item)})` : ""}`
    case "webfetch":
      return `WebFetch ${stringValue(input.url)}`
    case "websearch":
      return `Web Search "${stringValue(input.query)}"`
    case "subagent": {
      const continuation = Boolean(stringValue(input.sessionID))
      const agent = stringValue(input.agent) ?? stringValue(input.subagent_type)
      const name = agent ? agent.charAt(0).toUpperCase() + agent.slice(1) : "General"
      const description = stringValue(input.description) ?? "Subagent"
      return `${continuation ? "Continue subagent" : `${name} Subagent`} — ${description}`
    }
    case "execute":
      return `execute${executeCalls(item.metadata.toolCalls).length ? ` · ${executeCalls(item.metadata.toolCalls).length} call${executeCalls(item.metadata.toolCalls).length === 1 ? "" : "s"}` : ""}`
    case "todowrite":
      return "TodoWrite"
    case "question":
      return "Question"
    case "skill":
      return `Skill${stringValue(input.id) ?? stringValue(input.name) ? ` ${stringValue(input.id) ?? stringValue(input.name)}` : ""}`
    default:
      return `${item.tool}${primitiveInputSummary(input) ? ` ${primitiveInputSummary(input)}` : ""}`
  }
}

function shellCommand(item: WorkItem, context: Context) {
  const command = stringValue(item.input.command)
  if (!command) return "Writing command…"
  const workdir = stringValue(item.input.workdir)
  const prefix = workdir && workdir !== "." ? `cd ${displayPath(context, workdir)} && ` : ""
  return `$ ${prefix}${command}`
}

function collapsedShell(item: WorkItem, context: Context, width: number) {
  const command = shellCommand(item, context)
  const commandLines = command.split("\n")
  const input = commandLines.length > 2 ? commandLines.slice(0, 2).join("\n") + "…" : command
  const output = item.output
  const lines = output.split("\n")
  const maxLines = 10
  const maxChars = maxLines * Math.max(20, width - 8)
  const characters = Array.from(output).length
  if (lines.length <= maxLines && characters <= maxChars) {
    return { input, output, overflow: commandLines.length > 2 }
  }
  const count = Math.max(1, lines.length - (maxLines - 1))
  const label = `(${count} earlier ${count === 1 ? "line" : "lines"})`
  const tail = Array.from(lines.slice(-(maxLines - 1)).join("\n"))
  const available = Math.max(0, maxChars - Array.from(label).length - 1)
  return {
    input,
    output: `${label}\n${tail.slice(-available).join("")}`,
    overflow: true,
  }
}

function editPath(item: WorkItem) {
  const file = parseApplyPatchFiles(item.metadata.files)[0]
  return file?.relativePath ?? stringValue(item.input.path) ?? ""
}

function readRange(item: WorkItem) {
  if (item.input.offset === undefined && item.input.limit === undefined) return ""
  const start = finiteNumber(item.input.offset) || 1
  const end = item.input.limit ? start + (finiteNumber(item.input.limit) || 0) - 1 : ""
  return `:${start}-${end}`
}

function loadedFiles(item: WorkItem) {
  const loaded = item.metadata.loaded
  if (!Array.isArray(loaded)) return []
  return loaded.filter((value): value is string => typeof value === "string")
}

function countMatches(item: WorkItem) {
  const count = finiteNumber(item.metadata.count ?? item.metadata.matches)
  if (count === undefined) return ""
  return `${count} ${count === 1 ? "match" : "matches"}`
}

function itemDuration(item: WorkItem) {
  const start = item.time.ran ?? item.time.created ?? item.message?.time.created
  const end = item.time.completed ?? item.message?.time.completed
  if (start === undefined || end === undefined) return ""
  return formatDuration(Math.max(0, end - start))
}

function isBackground(item: WorkItem) {
  return item.status === "completed" && item.metadata.status === "running"
}

function icon(item: WorkItem) {
  if (item.tool === "exploration") return item.status === "running" ? "✱" : "→"
  if (item.status === "error") return "✗"
  if (item.status === "streaming" || item.status === "running") return "│"
  if (item.tool === "thought") return "✻"
  if (item.tool === "read") return "→"
  if (item.tool === "glob" || item.tool === "grep") return "✱"
  if (item.tool === "webfetch") return "%"
  if (item.tool === "websearch") return "◈"
  if (item.tool === "edit" || item.tool === "patch") return "←"
  if (item.tool === "write") return "#"
  if (item.tool === "subagent") return stringValue(item.input.sessionID) ? "↳" : "✓"
  return "✓"
}

function countLabel(turn: WorkTurn | undefined) {
  if (!turn) return "0 work items"
  const counts = { command: 0, edit: 0, read: 0, thought: 0, tool: 0 }
  const top = turn.items.filter((item) => item.depth === 0)
  const list = top.length > 0 ? top : turn.items
  for (const item of list) {
    const entries = item.tool === "exploration" ? (item.children ?? []) : [item]
    for (const entry of entries) {
      if (entry.tool === "thought") counts.thought++
      else if (entry.tool === "shell") counts.command++
      else if (FILES.has(entry.tool)) counts.edit++
      else if (EXPLORATION.has(entry.tool)) counts.read++
      else counts.tool++
    }
  }
  return (
    Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${count} ${name}${count === 1 ? "" : "s"}`)
      .join(" · ") || "0 work items"
  )
}

function fileLabel(file: { type: string }) {
  if (file.type === "add") return "# Created"
  if (file.type === "delete") return "# Deleted"
  return "← Patched"
}

// ---------------------------------------------------------------------------
// Utilities mirrored from the TUI

function canonicalToolName(name: string) {
  if (name === "bash") return "shell"
  if (name === "task") return "subagent"
  if (name === "apply_patch") return "patch"
  return name
}

function toolOutput(part: SessionMessageAssistantTool) {
  if (part.state.status === "streaming") return ""
  const content = part.state.content ?? []
  return stripAnsi(
    content
      .flatMap((item) => (item.type === "text" ? [item.text] : [item.name ?? item.uri]))
      .join("\n")
      .trim(),
  )
}

function primitiveInputSummary(input: Record<string, unknown>) {
  const entries = Object.entries(input).filter(([, value]) => {
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  })
  if (entries.length === 0) return ""
  return `[${entries.map(([key, value]) => `${key}=${String(value)}`).join(", ")}]`
}

function executeCalls(value: unknown): ExecuteCall[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((call) => {
    if (!isRecord(call)) return []
    if (typeof call.tool !== "string") return []
    if (call.status !== "running" && call.status !== "completed" && call.status !== "error") return []
    return [{ tool: call.tool, status: call.status, input: isRecord(call.input) ? call.input : undefined }]
  })
}

function executeCallSummary(call: ExecuteCall) {
  const args = primitiveInputSummary(call.input ?? {}).replace(/\s+/g, " ")
  return `${call.tool}${args ? ` ${args}` : ""}`
}

function executeCode(item: WorkItem) {
  return stringValue(item.input.code)
}

function jsonOutput(text: string) {
  const trimmed = text.trim()
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return
  const end = trimmed.search(/\n\n(Warnings|Logs):\n/)
  const json = end === -1 ? trimmed : trimmed.slice(0, end)
  try {
    JSON.parse(json)
  } catch {
    return
  }
  return { json, rest: end === -1 ? undefined : trimmed.slice(json.length).trim() || undefined }
}

function parseApplyPatchFiles(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!isRecord(item)) return []
    const status = stringValue(item.status)
    const type =
      stringValue(item.type) ??
      (status === "added" ? "add" : status === "deleted" ? "delete" : status === "modified" ? "update" : undefined)
    const relativePath = stringValue(item.file) ?? stringValue(item.relativePath)
    const filePath = stringValue(item.filePath) ?? relativePath
    const patch = stringValue(item.patch)
    if (!type || !relativePath || !filePath || patch === undefined) return []
    return [{ type, relativePath, filePath, patch }]
  })
}

function finiteNumber(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) return
  return value
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function displayPath(context: Context, value: string | undefined) {
  if (!value) return ""
  return context.ui.format.path(value)
}

function middle(value: string, max: number) {
  if (value.length <= max) return value
  const half = Math.floor((max - 1) / 2)
  return value.slice(0, half) + "…" + value.slice(-(max - half - 1))
}

function capLines(value: string, max: number) {
  const lines = value.split("\n")
  if (lines.length <= max) return value
  return `${lines.slice(0, max).join("\n")}\n… ${lines.length - max} more lines`
}

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const OSC = /\x1b\][^\x07]*\x07/g
function stripAnsi(value: string) {
  return value.replace(ANSI, "").replace(OSC, "")
}

function formatDuration(input: number) {
  if (input < 1000) return `${input}ms`
  if (input < 60000) return `${(input / 1000).toFixed(1)}s`
  if (input < 3600000) {
    const minutes = Math.floor(input / 60000)
    const seconds = Math.floor((input % 60000) / 1000)
    return `${minutes}m ${seconds}s`
  }
  const hours = Math.floor(input / 3600000)
  const minutes = Math.floor((input % 3600000) / 60000)
  return `${hours}h ${minutes}m`
}

function timeLabel(input: number) {
  return new Date(input).toLocaleTimeString(undefined, { timeStyle: "short" })
}

const FILETYPES: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".json": "json",
  ".jsonc": "json",
  ".md": "markdown",
  ".markdown": "markdown",
  ".py": "python",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash",
  ".rs": "rust",
  ".go": "go",
  ".css": "css",
  ".scss": "scss",
  ".html": "html",
  ".htm": "html",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".sql": "sql",
  ".diff": "diff",
  ".patch": "diff",
}

function filetype(path: string | undefined) {
  if (!path) return "none"
  const dot = path.lastIndexOf(".")
  if (dot <= path.lastIndexOf("/")) return "none"
  return FILETYPES[path.slice(dot).toLowerCase()] ?? "none"
}
