import { Plugin } from "@opencode/plugin/tui"
import type { Context, PanelInput } from "@opencode/plugin/tui/context"
import type {
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
} from "@opencode/client"
import { SyntaxStyle, TextAttributes, type BoxRenderable, type ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, on, onMount, Show } from "solid-js"

const PANEL = "jadon.worklog"
const TOGGLE_KEY = "alt+w"
const FILTERS = ["all", "commands", "files", "reads", "other"] as const
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
}

type WorkTurn = { key: string; at: number; items: WorkItem[] }

type ExecuteCall = {
  tool: string
  status: "running" | "completed" | "error"
  input?: Record<string, unknown>
}

const EXPLORATION = new Set(["read", "glob", "grep", "webfetch", "websearch"])
const FILES = new Set(["edit", "write", "patch"])

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
  onMount(() => {
    // Message history can land after the panel mounts; settle the initial
    // selection when the list has had time to lay out.
    setTimeout(() => reveal(selectedKey()), 800)
    setTimeout(() => reveal(selectedKey()), 1800)
  })

  const history = props.context.data.session.message as typeof props.context.data.session.message & {
    more?: (sessionID: string) => boolean
    loadMore?: (sessionID: string, options?: { all?: boolean }) => Promise<void>
  }
  const messages = createMemo(() => props.context.data.session.message.list(props.panel.sessionID) ?? [])
  const turns = createMemo(() => buildTurns(messages()))
  const [filter, setFilter] = createSignal<Filter>("all")
  const [selectedKey, setSelectedKey] = createSignal<string>()
  const [detailKey, setDetailKey] = createSignal<string>()

  const visibleTurns = createMemo(() =>
    turns()
      .map((turn) => ({ ...turn, items: turn.items.filter((item) => matches(item, filter())) }))
      .filter((turn) => turn.items.length > 0),
  )
  const flat = createMemo(() => visibleTurns().flatMap((turn) => turn.items))
  const selectedIndex = createMemo(() => {
    const items = flat()
    const index = items.findIndex((item) => item.key === selectedKey())
    return index >= 0 ? index : Math.max(0, items.length - 1)
  })
  const selected = createMemo(() => flat()[selectedIndex()])
  const selectedTurn = createMemo(() => {
    const item = selected()
    if (item) return item.turn
    return visibleTurns().at(-1)?.key ?? turns().at(-1)?.key
  })

  let scroll: ScrollBoxRenderable | undefined
  const rows = new Map<string, BoxRenderable>()
  const registerRow = (key: string, node: BoxRenderable | undefined) => {
    if (node) rows.set(key, node)
    else rows.delete(key)
  }
  let scrollGeneration = 0
  const schedule = (delays: readonly number[], run: () => void) => {
    const generation = ++scrollGeneration
    for (const delay of delays) setTimeout(() => {
      if (generation === scrollGeneration) run()
    }, delay)
  }
  const reveal = (key?: string) => {
    const target = key ?? selected()?.key
    if (!target) return
    schedule([0, 150, 400, 900, 1600], () => {
      const row = rows.get(target)
      if (!row || row.isDestroyed || !scroll || scroll.isDestroyed) return
      const top = scroll.scrollTop + row.y - scroll.viewport.y
      const bottom = top + row.height
      if (top < scroll.scrollTop) scroll.scrollTo(Math.max(0, top))
      else if (bottom > scroll.scrollTop + scroll.height) scroll.scrollTo(Math.max(0, bottom - scroll.height))
    })
  }
  const revealDetail = (key: string) => {
    schedule([0, 80, 200], () => {
      const row = rows.get(key)
      if (!row || row.isDestroyed || !scroll || scroll.isDestroyed) return
      const top = scroll.scrollTop + row.y - scroll.viewport.y
      if (top > scroll.scrollTop + scroll.height / 2) scroll.scrollTo(Math.max(0, top - 1))
    })
  }
  let initialized = false
  createEffect(() => {
    const items = flat()
    if (!initialized && items.length > 0) {
      initialized = true
      setSelectedKey(items.at(-1)!.key)
    }
  })
  createEffect(on(selectedKey, (key) => reveal(key), { defer: true }))

  const select = (key: string | undefined) => {
    if (!key) return
    setSelectedKey(key)
    setDetailKey(undefined)
    reveal(key)
  }
  const move = (delta: number) => {
    const items = flat()
    if (items.length === 0) return
    const next = items[Math.min(items.length - 1, Math.max(0, selectedIndex() + delta))]
    select(next?.key)
  }
  const page = (direction: 1 | -1) => {
    const items = flat()
    if (items.length === 0) return
    select(items[Math.min(items.length - 1, Math.max(0, selectedIndex() + direction * 10))]?.key)
  }
  const top = () => select(flat()[0]?.key)
  const bottom = () => select(flat().at(-1)?.key)
  const toggleDetail = () => {
    const item = selected()
    if (!item) return
    // The in-place child work log is a later pass; subagent rows are intentionally inert.
    if (item.tool === "subagent") return
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
        const list = visibleTurns()
        const currentKey = flat().find((item) => item.key === anchor)?.turn
        const position = list.findIndex((turn) => turn.key === currentKey)
        if (position > 0) {
          select(list[position - 1]?.items[0]?.key)
          break
        }
        // A page boundary can split the current turn; keep loading until the
        // turn before it is available or history is exhausted.
        if (position < 0) break
      }
      reveal(selectedKey())
    } finally {
      setLoadingOlder(false)
    }
  }
  const jumpTurn = (direction: 1 | -1) => {
    const list = visibleTurns()
    if (list.length === 0) return
    const current = list.findIndex((turn) => turn.key === selectedTurn())
    const index = (current < 0 ? list.length - 1 : current) + direction
    if (index < 0) {
      void loadOlder()
      return
    }
    if (index >= list.length) return
    const target = list[index]
    if (!target) return
    select(target.items[0]?.key)
  }
  const cycleFilter = () => {
    const index = FILTERS.indexOf(filter())
    setFilter(FILTERS[(index + 1) % FILTERS.length]!)
    setDetailKey(undefined)
    const items = flat()
    if (!items.some((item) => item.key === selectedKey())) setSelectedKey(items.at(-1)?.key)
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
      { id: "session.worklog.detail", bind: "return", title: "Toggle work item detail", group: "Work log", run: toggleDetail },
      { id: "session.worklog.page.down", bind: "pagedown,ctrl+d", title: "Next page", group: "Work log", run: () => page(1) },
      { id: "session.worklog.page.up", bind: "pageup,ctrl+u", title: "Previous page", group: "Work log", run: () => page(-1) },
      { id: "session.worklog.top", bind: "g,home", title: "First work item", group: "Work log", run: top },
      { id: "session.worklog.bottom", bind: "shift+g,end", title: "Last work item", group: "Work log", run: bottom },
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
      { id: "session.worklog.filter", bind: "t", title: "Cycle work log filter", group: "Work log", run: cycleFilter },
      { id: "session.worklog.fullscreen", bind: "f", title: "Toggle work log fullscreen", group: "Work log", run: () => props.panel.toggleFullscreen() },
      { id: "session.worklog.hide", bind: "escape,q", title: "Hide work log", group: "Work log", run: () => props.panel.close() },
    ],
  }))

  const sessionTitle = () =>
    `${props.context.data.session.get(props.panel.sessionID)?.title ?? "Session"} - work log`
  const currentTurn = () => {
    const key = selectedTurn()
    if (key === undefined) return
    return turns().find((turn) => turn.key === key)
  }
  const turnLabel = () => {
    const turn = currentTurn()
    if (!turn) return "No work yet"
    const list = visibleTurns()
    const position = list.findIndex((item) => item.key === turn.key)
    const numbering = position >= 0 ? `Batch ${position + 1}/${list.length} · ` : "Batch · "
    return `${numbering}${timeLabel(turn.at)} · ${countLabel(turn)}`
  }
  const emptyLabel = () => (filter() === "all" ? "No tool calls yet." : `No ${filter()} in this session.`)

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
        <text fg={labelColor()} attributes={dim()} wrapMode="none" truncate>
          {turnLabel()}
        </text>
        <text fg={labelColor()} attributes={dim()}>
          ·
        </text>
        <text fg={labelColor()} attributes={dim()}>
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
        verticalScrollbarOptions={{
          paddingLeft: 1,
          visible: true,
          trackOptions: {
            backgroundColor: "transparent",
            foregroundColor: theme.hue.neutral[700],
          },
        }}
      >
        <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingTop={1} paddingBottom={1}>
          <Show
            when={flat().length > 0}
            fallback={
              <box paddingLeft={1} paddingTop={1}>
                <text fg={theme.text.muted}>{emptyLabel()}</text>
              </box>
            }
          >
            <For each={visibleTurns()}>
              {(turn) => (
                <box flexDirection="column">
                  <box border={["top"]} borderColor={theme.decrease(theme.background.base)} marginTop={1} paddingTop={1}>
                    <text fg={theme.text.muted} attributes={TextAttributes.DIM} wrapMode="none" truncate>
                      Batch · {timeLabel(turn.at)} · {countLabel(turn)}
                    </text>
                  </box>
                  <For each={turn.items}>
                    {(item) => (
                      <>
                        <WorkRow
                          item={item}
                          selected={selected()?.key === item.key}
                          theme={theme}
                          context={props.context}
                          syntax={props.syntax}
                          register={(node) => registerRow(item.key, node)}
                          onSelect={() => {
                            select(item.key)
                            props.panel.focus()
                          }}
                          onToggle={() => {
                            if (selected()?.key !== item.key) select(item.key)
                            toggleDetail()
                          }}
                        />
                        <Show when={detailKey() === item.key}>
                          <WorkDetail item={item} theme={theme} context={props.context} syntax={props.syntax} width={props.panel.width} />
                        </Show>
                      </>
                    )}
                  </For>
                </box>
              )}
            </For>
          </Show>
          <box height={1} flexShrink={0} />
        </box>
      </scrollbox>

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
        <KeyHint key="esc" label="hide" focused={focused()} theme={theme} />
      </box>
    </box>
  )
}

function WorkRow(props: {
  item: WorkItem
  selected: boolean
  theme: Context["theme"]
  context: Context
  syntax: SyntaxStyle
  register: (node: BoxRenderable | undefined) => void
  onSelect: () => void
  onToggle: () => void
}) {
  const item = () => props.item
  const color = () => {
    if (item().status === "error") return props.theme.text.feedback.error.base
    if (props.selected) return props.theme.text.base
    return props.theme.text.muted
  }
  const duration = () => {
    const start = item().time.ran ?? item().time.created
    const end = item().time.completed
    if (start === undefined || end === undefined) return ""
    return formatDuration(Math.max(0, end - start))
  }
  const summary = () => summarize(item(), props.context, props.theme).replace(/\s+/g, " ").trim()
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
        {icon(item())}
      </text>
      <box paddingLeft={item().depth > 0 ? 2 : 0} flexGrow={1} minWidth={0}>
        <text
          fg={color()}
          wrapMode="none"
          truncate
          attributes={props.selected ? TextAttributes.BOLD : undefined}
        >
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

        <Show when={item().tool === "subagent"}>
          <text fg={theme().text.muted}>Child work log is not implemented yet.</text>
        </Show>

        <Show when={item().tool === "skill"}>
          <text fg={theme().text.muted} wrapMode="word">
            Skill {stringValue(item().input.id) ?? stringValue(item().input.name) ?? ""}
          </text>
        </Show>

        <Show when={item().tool === "execute"}>
          <For each={executeCalls(item().metadata.toolCalls)}>
            {(call) => (
              <text fg={call.status === "error" ? theme().text.feedback.error.base : theme().text.muted} wrapMode="none" truncate>
                › {executeCallSummary(call)}
              </text>
            )}
          </For>
          <Show when={item().output}>
            <text fg={theme().text.muted} wrapMode="word">
              {capLines(item().output, 200)}
            </text>
          </Show>
        </Show>

        <Show when={!["shell", "edit", "patch", "write", "read", "glob", "grep", "webfetch", "websearch", "subagent", "execute", "skill"].includes(item().tool)}>
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

        <Show when={item().error}>
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
      <text fg={props.focused ? props.theme.text.base : props.theme.text.action.primary.disabled} attributes={props.focused ? undefined : TextAttributes.DIM}>
        {props.key}
      </text>
      <text fg={props.focused ? props.theme.text.muted : props.theme.text.action.primary.disabled} attributes={props.focused ? undefined : TextAttributes.DIM}>
        {props.label}
      </text>
    </>
  )
}

function Dot(props: { focused: boolean; theme: Context["theme"] }) {
  return (
    <text fg={props.focused ? props.theme.text.muted : props.theme.text.action.primary.disabled} attributes={props.focused ? undefined : TextAttributes.DIM}>
      ·
    </text>
  )
}

// ---------------------------------------------------------------------------
// Projection

function buildTurns(messages: readonly SessionMessageInfo[]): WorkTurn[] {
  const turns: WorkTurn[] = []
  let current: WorkTurn | undefined
  const ensure = (at: number, key: string) => {
    if (!current) {
      current = { key, at, items: [] }
      turns.push(current)
    }
    return current
  }
  for (const message of messages) {
    if (message.type === "user") {
      current = { key: message.id, at: message.time.created, items: [] }
      turns.push(current)
      continue
    }
    if (message.type !== "assistant") continue
    const turn = ensure(message.time.created, `start:${message.id}`)
    for (const part of message.content) {
      if (part.type !== "tool") continue
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
    }
  }
  return turns
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

function matches(item: WorkItem, filter: Filter) {
  if (filter === "all") return true
  if (filter === "commands") return item.tool === "shell" || item.tool === "execute"
  if (filter === "files") return FILES.has(item.tool)
  if (filter === "reads") return EXPLORATION.has(item.tool)
  return !["shell", "execute", ...FILES, ...EXPLORATION].includes(item.tool)
}

// ---------------------------------------------------------------------------
// Native-like summaries

function summarize(item: WorkItem, context: Context, theme: Context["theme"]) {
  if (item.call) return executeCallSummary(item.call)
  const input = item.input
  switch (item.tool) {
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
      return `TodoWrite`
    case "question":
      return `Question`
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

function isBackground(item: WorkItem) {
  return item.status === "completed" && item.metadata.status === "running"
}

function icon(item: WorkItem) {
  if (item.status === "error") return "✗"
  if (item.status === "streaming" || item.status === "running") return "│"
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
  const counts = { command: 0, edit: 0, read: 0, tool: 0 }
  const top = turn.items.filter((item) => item.depth === 0)
  for (const item of top.length > 0 ? top : turn.items) {
    if (item.tool === "shell") counts.command++
    else if (FILES.has(item.tool)) counts.edit++
    else if (EXPLORATION.has(item.tool)) counts.read++
    else counts.tool++
  }
  return Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => `${count} ${name}${count === 1 ? "" : "s"}`)
    .join(" · ") || "0 work items"
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
