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

## put sub-repos in dotfiles

see if I can put my opencode config and neovim config as repositories inside my
dotfiles, and the target is just the repository, and the run_on_change is just
pulling the repo?

this lets me track the individual configurations as repositories, but have all
the files tracked by my dotfiles repo?

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

- search use runner in background more often? or reuse runner?
-

## Builder report?

maybe make the builder report also an artifact that can be passed to review?
keep it out of planner context?

all agents just report: `Done report saved at: {$path}`

## tools and artifacts

MAYBE

Keep base artifact layer, but personalize the tools a bit more per agent, that
way they don't call artifact-publish(kind=plan, ..) they just do
publish_plan(...), publish_evidence(...), publish_review(...) and the kind is
prefilled. Additionally the kind can be encoded into the name, instead of art_xx
it is plan_xxx, evid_xxx, revw_xxx, but that is second priority if it makes it
harder.
