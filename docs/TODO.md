# TODO Items

## Diagrams and tables

Mermaid sequence diagrams in markdown, cleanup markdown rendering to reduce as
many virtual lines as possible.

Encourage agents to use sequence diagrams in reports and evidence?

## neovim cleanup config and custom code

cleanup my files and globals and requires and make everything more plugin shaped
so I can improve my startup time again. make everything that is independent be a
plugin with setup() ?

lsp default keymaps? also lsp-popup formatting improvements in some places, and
lsp code actions with snacks needs styling, ca cd and some other lsp keymaps

## neovim misc.

try to find areas where lazyvim / a plugin already handled something I
overengineered in my configuration

bring back minipairs or autopair, use tab-out plugin, treesitter indent,

gitsigns keymaps for hunk preview

## yazi as file manager

yazi functionality and plugins to make it a full nautilus replacement for
omarchy:

- clipboard management, $EDITOR support ($SUDOEDITOR too)
- drag-and-drop
- image preview
- sudo / fingerprint hook
- tailscale send
- rsync or other features
- mount management
- tabs, and nice default navigation and bookmarking
- consistent omarchy themeing (preview as well? sublime)
- xdg-filechooser / portal (hunkyburrito-git)

Additionally:

- yazi.nvim (eventual pr to help with snacks.terminal migration?)

## general interaction outside of planning or review

be able to ask an opencode session questions 'headlessly' and get responses in
evidence or answer documents? make a custom agent for headless planner mode?

keep headless separate from interactive tui opencode (session wise)

## headless / mini session plugin in neovim companion panel

snacks terminal, is the session I ask questions to, possibly different agent
than planner?

doesn't seem to have a session switcher?

private server for headless neovim stuff?

send filepath + line number, it reads, it answers or launches background
searchers if needed, notifies me when done, in the background.

separate session from my interactive session?

make this the avenue that can direct use search subagents? or still have
headless version of planner that knows not to output, and only communicate via
files and neovim notifications, pure orchestration of the workflow?

make my own 'prompt' buffer, it will be a scratch-pad like float, inside of
which I can put notes, attach file references, etc. and then have option to send
to a session, functions as scratch-pad at first, isn't always enforced to
connect to session until I use the send keymap (lazy session selection)

multiple options:

- send filepath, selection, or question directly to headless agent
- directly to interactive agent in tui session (basically send to any session)
- send to scratch buffer, maybe scratch buffer has a template and any send to
  the buffer inserts it at the correct location? how to enforce with my custom
  edits?

multiple ways to get answers or feedback:

- notification that a new evidence is ready to read?
- agent responds in interactive tui, or in opencode mini session, or if headless
  responds in a file?

headless agents can edit files directly for quick edits?

## IDEA

custom markdown plugin or something or lsp that detects when I hover an evidence
file inside a plan, or `gx` it like a link or something, it takes me to the
evidence, I can ask questions in the evidence and flesh it out, and it sends
that directly to the search, I can mark evidence as read, which returns me to
the plan

this doesn't stop me from manually reading evidence, and marking as read.

setup a grep in evidence picker, shows evidence, greps inside them, the preview
is also the view that runs when you open the file? would need more opencode
integration?

## another good idea

this is related to core ui2 and having more of the notifications and mesages
appear in the messages/pager buffers

I could have headless agents respond in the pager or messages, and I can open
the pager and read it, but it doesn't have to be a file?

---

## Plan or artifact read marker

change logic to approve plan on close keymap, or mark other artifacts as read.
before it actually closes it will bring up selection menu to mark read/approved
or do nothing? selection menu seems fine, even with explicit keymap it still
asks.

# Issues and tweaks:

- snacks picker not searchable, fix
- grep inside evidence, or plan, etc. using rendered view files
- make picker filterable by type, either via keymap or a tag like plan! or :plan
  or something
- make two pickers: all artifacts, pending artifacts? or keep the A-a toggle?
- some type of notification or indication in neovim when new artifact is ready?
- less notifications, less verbose titles, cleaner UI

- session disconnect, other session management ideas
  - neovim connects to session on a running oc server, not scoped to cwd?

- checks section in the plan from planner -> builder too many checks that aren't
  useful most of the time (makes builder waste time running or searching things
  unrelated)

- append follow-up questions into top level evidence section?

- cleanup and removal of old sessions and old artifacts?

- review outcome vs summary, and planner reading wrong one?

- when launching a runner purely to get the full dump of the command anyway,
  just have it pipe to a file in /tmp and report the path, so as to not waste
  output tokens

- when an artifact becomes stale or superseded, allow either neovim side
  functionality to hide it/mark stale, or add a tool that agents can mark it
  stale and which artifacts supersedes it?

- if a correction is being done, allow it to just append a follow-up, and then
  resume the builder, without needing a separate plan + approval?

- when planner starts builder, it then offers next task idea, or something to
  guide the session

builder report too similar to review's review in name; maybe builder brief?

## Session hand-off

With the artifact system set up, should be very easy to essentially make my own
compaction via a formatted session artifact that the next planner loads as its
first prompt. This would allow me to run super cheap low input context token
sessions that implement decent working chunks at a time, and save money.

Not too aggressive to take advantage of built-up session context and input
caching, and we can also ensure that subagents hand-off smoothly between
sessions,same with artifacts. Would be even better if opencode would allow
subagents to move working directories and I could flag all artifacts in my
plugin with a special hand-off flag that lets them be 'claimed' by another
session?

---

# Very cool plugin for annotations

Display a virtual mark or sign where the annotation is located, save them
according to git branch, have them searchable in picker

they are recorded against location in the file, possibly save and match against
the line's content, in case other content moves?

allow all annotations, one annotation, all annotation in same buffer to be
copied/yanked, or sent places.

then when at the location a user command or keymap will bring up a nice preview
like lsp hover

# Potential Idea for artifact review

pop the artifacts up into a float such that they can either be hidden, or when
closed that marks them as read.

leaving the float window hides it,

The float window could even be a special listing of only open artifact buffers,
meaning when one is closed, another could open, or it could switch to a list of
them, or a special UI like lazy or mason that has them organized on a dashboard

# Potential settings menu or command prompt type feature

Potentially implement a float command prompt on ctrl+space, similar to
opencodes, that has configured settings options and sections of things you might
want to do, smart matching, on the side shows the keymap, potential which-key
replacement?

types of keymaps that would live in this instead:

1. `<leader>u*` - all of the ui toggle type keymaps would be better in a menu
   (submenu for toggles)

2. some git actions, git worktree selection, lazygit specific views

3. diffview, only the during diffview keymaps stay active

4. focus mode

5. tab creation or rename or things like that, buffer rename

6. move cwd

7. new file/buffer, with path input prompt?

8. better keymap helper than which-key. One that shows file local keymaps, and
   other keymaps, potentially searchable

9. special copy/paste clipboard items such as:

- image embedding
- filename, relative path, absolute path, filestem, working directory
- annotations?

basically keep keymaps for my most used things, and interactive editing type
things?

# Very cool layout manager idea

Convert the right side empty buffer into a special space for:

pending notifications, instead of snacks, implement my own vim.notify that takes
all notifications, and styles them on the right top to bottom, and they can be
dismissed, or have a timeout if transient, or have an action (e.g. new artifact
from opencode).

style:

e for expand, d for dismiss

```
Source
Message
---
d dismiss          e expand
```

make them wrap, or truncate? well definitely truncate since we will have expand
feature

The notifications can be focused and expanded up into center to review more
closely or copy the content

the list of notifications will be scrollable?

there will be a small status bar at bottom with info or keymap hints, yeah and
make the actual status go into lualine, like a pending notification number.

make whole thing hideable of course.

items that will still go into pager or messages will, and lsp stays in
statusline, find next/prev stays in statusline

make hunk go into statusline

## Left side

Left side will be reserved for:

a special new yazi plugin using snacks terminal, (or finally help yazi.nvim with
the snacks lazygit features)

I want to have it left side, turn off the preview pane (pure navigation),
opening file opens it in neovim, without having to exit yazi, make it toggleable
(hide or show), it can support tabs, etc.

---

# Interactive both sides editable, opencode artifacts

Potentially make some type of custom treesitter or markdown parser or lsp that
matches against the artifact filetype and templates, and when I update a section
inside a matching section of the template, on save it writes back my changes to
the record.

If there is text outside of a section or a new section that was not in the
record, it does its best to either:

- remove it
- snap it into nearest section
- make a new section in the record

Since the view should regenerate from the record, it will be a type of
autoformat?

neovim prettier is disabled for this type of file?

If there is a conflict due to an agent edit of the record, it will inform me
with a notification, make a copy of my changes to a tmp file, and upon resolving
any changes, I can close the tmp one

If it is in a section like evidence that isn't meant to be editable, on save it
doesn't write back to record and just undoes it

if the buffer can become context aware of the sections, then the tool on the
opnecode side could become much more refined, where we reintroduce the ID for
every single item in the file, so that when I provide feedback over a section,
or a range of sections depending on selection, those exact section IDs and the
relevant context get sent to the agent for feedback, clarification, etc. and it
can use the patch tool to target the exact sections

allow for selecting multiple sections before sending feedback

Benefits:

1. I can make edits to the plan myself before approval.
2. I can make edits and then ask for the agent to expand that across the plan,
   or verify a fact
3. The agent can successfully patch every section I mention and it works
   directly with the schema via the exact item ID and a tool

This does not have to be exclusive to planner, this would also allow am eventual
direct clarification or rewrite from a search agent.

Imagine I am in the buffer, hovered over a piece of evidence or a code snippet,
and I give feedback / ask the agent to explain the evidence in a different way,
or rewrite the code in another style, and it takes the section, has the
knowledge already, and outputs the result via the ID and the tool

This is also extensible to anything tree-sitter related, context aware snippet
help and stuff, idk

---

## Gitsigns history of hunk over time? per hunk blame/log popup?

idk

## Neovim / Dotfiles

- split opencode-artifacts
  - separate picker
  - separate rpc backend
  - separate keymaps and interactive behavior stuff
  - shared opencode backend for later headless or mini support
- investigate leaving LazyVim (for now copy lsp/text-objects/extras I use?)
  - very custom config, how much left is LazyVim providing?
  - the <leader>u ui toggles
  - extras like chezmoi and stuff
- update neovim to 0.13 for new features
  - images, immediate file watcher, etc.

---
