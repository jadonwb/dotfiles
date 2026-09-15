# TODO Items

## Diagrams and tables

Mermaid sequence diagrams in markdown, cleanup markdown rendering to reduce as
many virtual lines as possible.

Encourage agents to use sequence diagrams in reports and evidence.

## Neovim notifications

since we use notifications more now, cleanup styling of things like :NVEnv, and
other helpers send things to messages/pager instead of vim.notify, keep
vim.notify only for things that happen 'in background' ensure consistency of
debug/logging/notifications and do fuller ui2 audit again. make lsp progress be
a simple ascii block load bar instead of its current shape/style? make lsp
progress update without me moving my cursor, e.g. timer isn't seeming to run

can move command line and search line into the lualine via tiny-command line?

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

## opencode keymaps

Alt-r to restart

keymap to toggle subagent panel? or one to open one to close (prefer toggle)

where to find v2 docs?

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

---

# language and behavior tweaks

- planner use runner more? or just remove?

## general interaction outside of planning or review

be able to ask an opencode session questions 'headlessly' and get responses in
evidence or answer documents? make a custom agent for headless planner mode?

keep headless separate from interactive tui opencode (session wise)

## neovim + opencode session

keymap to create new session (and name it?)

## headless / mini session plugin in neovim companion panel

snacks terminal, is the session I ask questions to, possibly different agent
than planner?

# HUGE IDEA

custom markdown plugin or something or lsp that detects when I hover an evidence
file inside a plan, or `gx` it like a link or something, it takes me to the
evidence, I can ask questions in the evidence and flesh it out, and it sends
that directly to the search, I can mark evidence as read, which returns me to
the plan

this doesn't stop me from manually reading evidence

setup a grep in evidence picker, shows evidence, greps inside them, the preview
is also the view that runs when you open the file?

---
