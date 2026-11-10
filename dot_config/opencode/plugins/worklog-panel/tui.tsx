import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import type {
  SessionMessageAssistant,
  SessionMessageAssistantReasoning,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client"
import { SyntaxStyle, TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch } from "solid-js"
import { createStore, reconcile } from "solid-js/store"

const PANEL = "jadon.worklog"
const TOGGLE_KEY = "alt+w"
const FILTERS = ["all", "commands", "files", "reads", "thoughts", "other"] as const
type Filter = (typeof FILTERS)[number]

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
              if (panelFocused()) context.ui.panel.close()
              else context.keymap.dispatch("pane.focus.right")
              return
            }
            context.ui.panel.open(PANEL, { presentation: "panel" })
          },
        },
      ],
    }))

    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL}>
          <WorklogPanel context={context} panel={panel} syntax={syntax} theme={theme} onFocus={setPanelFocused} />
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

  const history = props.context.data.session.message as typeof props.context.data.session.message & {
    more?: (sessionID: string) => boolean
    loadMore?: (sessionID: string, options?: { all?: boolean }) => Promise<void>
  }
  const messages = createMemo(() => props.context.data.session.message.list(props.panel.sessionID) ?? [])
  const turns = createMemo(() => buildTurns(messages()))
  const [filter, setFilter] = createSignal<Filter>("all")
  const projected = createMemo(() => buildRows(turns(), filter()))
  const [rows, setRows] = createStore<Row[]>([])
  createEffect(
    on(projected, (next) => {
      setRows(reconcile(next, { key: "key" }))
    }),
  )

  const [selectedKey, setSelectedKey] = createSignal<string>()
  const [detailKey, setDetailKey] = createSignal<string>()

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
      if (!history.more?.(props.panel.sessionID)) break
      await history.loadMore?.(props.panel.sessionID).catch(() => undefined)
    }
    reveal(selectedKey())
  }
  createEffect(() => {
    if (ensuredBatches || messages().length === 0) return
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
  const nodes = new Map<string, BoxRenderable>()
  const registerRow = (key: string, node: BoxRenderable | undefined) => {
    if (node) nodes.set(key, node)
    else nodes.delete(key)
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
      if (top < scroll.scrollTop) scroll.scrollTo(Math.max(0, top))
      else if (bottom > scroll.scrollTop + scroll.height) scroll.scrollTo(Math.max(0, bottom - scroll.height))
    })
  }
  const revealDetail = (key: string) => {
    schedule([0, 60, 160], () => {
      const node = nodes.get(key)
      if (!node || node.isDestroyed || !scroll || scroll.isDestroyed) return
      const top = scroll.scrollTop + node.y - scroll.viewport.y
      if (top > scroll.scrollTop + scroll.height / 2) scroll.scrollTo(Math.max(0, top - 1))
    })
  }
  const select = (key: string | undefined) => {
    if (!key) return
    setSelectedKey(key)
    setDetailKey(undefined)
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
  const top = () => select(itemRows()[0]?.key)
  const bottom = () => select(itemRows().at(-1)?.key)
  const toggleDetail = () => {
    const item = selected()
    if (!item) return
    // Thoughts and the in-place child work log are later passes; their rows are
    // intentionally inert for now.
    if (item.tool === "subagent" || item.tool === "thought") return
    const open = detailKey() !== item.key
    setDetailKey(open ? item.key : undefined)
    if (open) revealDetail(item.key)
    else reveal(item.key)
  }

  const [loadingOlder, setLoadingOlder] = createSignal(false)
  const loadOlder = async () => {
    if (loadingOlder()) return
    const anchor = selected()?.key
    if (!history.more?.(props.panel.sessionID)) return
    setLoadingOlder(true)
    try {
      for (let page = 0; page < 12; page++) {
        if (!history.more?.(props.panel.sessionID)) break
        await history.loadMore?.(props.panel.sessionID).catch(() => undefined)
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
  const cycleFilter = () => {
    const index = FILTERS.indexOf(filter())
    const next = FILTERS[(index + 1) % FILTERS.length]!
    setFilter(next)
    setDetailKey(undefined)
    const projectedRows = projected()
    setRows(reconcile(projectedRows, { key: "key" }))
    const items = projectedRows.filter((row): row is ItemRow => row.kind === "item")
    if (!items.some((row) => row.key === selectedKey())) setSelectedKey(items.at(-1)?.key)
    reveal()
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
        run: () => scroll?.scrollBy(2),
      },
      {
        id: "session.worklog.scroll.up",
        bind: "alt+k",
        title: "Scroll work log up",
        group: "Work log",
        run: () => scroll?.scrollBy(-2),
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
        title: "Cycle work log filter",
        group: "Work log",
        run: cycleFilter,
      },
      {
        id: "session.worklog.fullscreen",
        bind: "f",
        title: "Toggle work log fullscreen",
        group: "Work log",
        run: () => props.panel.toggleFullscreen(),
      },
      {
        id: "session.worklog.hide",
        bind: "escape,q",
        title: "Hide work log",
        group: "Work log",
        run: () => props.panel.close(),
      },
    ],
  }))

  const sessionTitle = () =>
    `${props.context.data.session.get(props.panel.sessionID)?.title ?? "Session"} - work log`
  const turnLabel = () => {
    const turn = currentTurn()
    if (!turn) return "No work yet"
    const list = dividerRows()
    const position = list.findIndex((row) => row.turnKey === turn.key)
    const numbering = position >= 0 ? `Batch ${position + 1}/${list.length} · ` : "Batch · "
    return `${numbering}${timeLabel(turn.at)} · ${countLabel(turn)}`
  }
  const emptyLabel = () => (filter() === "all" ? "No work yet." : `No ${filter()} in this session.`)

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} backgroundColor={theme.background.base}>
      <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} paddingTop={1} gap={1}>
        <text
          attributes={focused() ? TextAttributes.BOLD : TextAttributes.BOLD | TextAttributes.DIM}
          fg={keyColor()}
          flexGrow={1}
          wrapMode="none"
          truncate
        >
          {sessionTitle()}
        </text>
      </box>
      <box flexDirection="row" flexShrink={0} paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
        <text fg={labelColor()} attributes={dim()} wrapMode="none" truncate flexGrow={1} minWidth={0}>
          {turnLabel()}
        </text>
        <text fg={labelColor()} attributes={dim()} flexShrink={0}>
          ·
        </text>
        <text fg={labelColor()} attributes={dim()} flexShrink={0}>
          {filterLabel(filter())}
        </text>
        <Show when={loadingOlder()}>
          <text fg={labelColor()} attributes={dim()}>
            · loading older…
          </text>
        </Show>
      </box>

      <scrollbox
        ref={(value) => (scroll = value)}
        flexGrow={1}
        minHeight={0}
        stickyScroll
        stickyStart="bottom"
        viewportCulling={false}
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
              {(row) => (
                <Switch>
                  <Match when={row.kind === "divider"}>
                    <BatchDivider row={row as DividerRow} theme={theme} />
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
                      <WorkDetail
                        item={(row as ItemRow).item}
                        theme={theme}
                        context={props.context}
                        syntax={props.syntax}
                        width={props.panel.width}
                      />
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
        <KeyHint key="alt+j/k" label="scroll" focused={focused()} theme={theme} />
        <Dot focused={focused()} theme={theme} />
        <KeyHint key="enter" label="detail" focused={focused()} theme={theme} />
        <Dot focused={focused()} theme={theme} />
        <KeyHint key="[ ]" label="batch" focused={focused()} theme={theme} />
        <Dot focused={focused()} theme={theme} />
        <KeyHint key="t" label="filter" focused={focused()} theme={theme} />
        <Dot focused={focused()} theme={theme} />
        <KeyHint key="f" label="fullscreen" focused={focused()} theme={theme} />
        <Dot focused={focused()} theme={theme} />
        <KeyHint key="esc" label="hide" focused={focused()} theme={theme} />
      </box>
    </box>
  )
}

function BatchDivider(props: { row: DividerRow; theme: Context["theme"] }) {
  return (
    <box
      border={["top"]}
      borderColor={props.theme.decrease(props.theme.background.base)}
      marginTop={1}
      paddingTop={1}
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
  const duration = () => (thought() ? "" : itemDuration(item()))
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
          <text fg={theme().text.base} wrapMode="word">
            {shellCommand(item(), props.context)}
          </text>
          <Show when={item().output}>
            <text fg={theme().text.muted} wrapMode="word">
              {capLines(item().output, 300)}
            </text>
          </Show>
          <Show when={isBackground(item())}>
            <text fg={theme().text.muted} bg={theme().decrease(theme().background.base)}>
              {" Background "}
            </text>
          </Show>
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

        <Show when={item().tool === "read"}>
          <text fg={theme().text.base} wrapMode="word">
            → Read {displayPath(props.context, stringValue(item().input.path))}
            {readRange(item())}
          </text>
          <For each={loadedFiles(item())}>
            {(file) => (
              <text fg={theme().text.muted} wrapMode="none" truncate>
                ↳ Loaded {middle(displayPath(props.context, file), maxPathWidth())}
              </text>
            )}
          </For>
        </Show>

        <Show when={item().tool === "glob" || item().tool === "grep"}>
          <text fg={theme().text.base} wrapMode="word">
            {item().tool === "glob" ? "Glob" : "Grep"} "{stringValue(item().input.pattern)}"
            {stringValue(item().input.path)
              ? ` in ${displayPath(props.context, stringValue(item().input.path)!)}`
              : ""}
          </text>
          <Show when={countMatches(item())}>
            <text fg={theme().text.muted}>{countMatches(item())}</text>
          </Show>
        </Show>

        <Show when={item().tool === "webfetch"}>
          <text fg={theme().text.base} wrapMode="word">
            WebFetch {stringValue(item().input.url)}
          </text>
        </Show>
        <Show when={item().tool === "websearch"}>
          <text fg={theme().text.base} wrapMode="word">
            Web Search "{stringValue(item().input.query)}"
          </text>
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

        <Show when={item().tool === "skill"}>
          <text fg={theme().text.muted} wrapMode="word">
            Skill {stringValue(item().input.id) ?? stringValue(item().input.name) ?? ""}
          </text>
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
  return turns
}

function buildRows(turns: readonly WorkTurn[], filter: Filter): Row[] {
  const rows: Row[] = []
  for (const turn of turns) {
    const items = turn.items.filter((item) => matches(item, filter))
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

function matches(item: WorkItem, filter: Filter) {
  if (filter === "all") return true
  if (filter === "commands") return item.tool === "shell" || item.tool === "execute"
  if (filter === "files") return FILES.has(item.tool)
  if (filter === "reads") return EXPLORATION.has(item.tool)
  if (filter === "thoughts") return item.tool === "thought"
  return !["shell", "execute", ...FILES, ...EXPLORATION, "thought"].includes(item.tool)
}

// ---------------------------------------------------------------------------
// Native-like summaries

function summarize(item: WorkItem, context: Context) {
  if (item.call) return executeCallSummary(item.call)
  const input = item.input
  switch (item.tool) {
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
    case "subagent":
      return `Subagent called${stringValue(input.description) ? ` — ${stringValue(input.description)}` : ""}`
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
  if (item.status === "error") return "✗"
  if (item.status === "streaming" || item.status === "running") return "│"
  if (item.tool === "thought") return "✻"
  if (item.tool === "read") return "→"
  if (item.tool === "glob" || item.tool === "grep") return "✱"
  if (item.tool === "webfetch") return "%"
  if (item.tool === "websearch") return "◈"
  if (item.tool === "edit" || item.tool === "patch") return "←"
  if (item.tool === "write") return "#"
  return "✓"
}

function countLabel(turn: WorkTurn | undefined) {
  if (!turn) return "0 work items"
  const counts = { command: 0, edit: 0, read: 0, thought: 0, tool: 0 }
  const top = turn.items.filter((item) => item.depth === 0)
  for (const item of top.length > 0 ? top : turn.items) {
    if (item.tool === "thought") counts.thought++
    else if (item.tool === "shell") counts.command++
    else if (FILES.has(item.tool)) counts.edit++
    else if (EXPLORATION.has(item.tool)) counts.read++
    else counts.tool++
  }
  return (
    Object.entries(counts)
      .filter(([, count]) => count > 0)
      .map(([name, count]) => `${count} ${name}${count === 1 ? "" : "s"}`)
      .join(" · ") || "0 work items"
  )
}

function filterLabel(filter: Filter) {
  switch (filter) {
    case "all":
      return "All"
    case "commands":
      return "Commands"
    case "files":
      return "Files"
    case "reads":
      return "Reads"
    case "thoughts":
      return "Thoughts"
    case "other":
      return "Other"
  }
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
