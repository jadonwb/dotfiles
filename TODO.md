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

# Opencode determinism (via tools)

- Every single thing a model does that I would want it to do again, I just
  implement as a pre-made tool.
  - working on a dotfile submodule, and it works? then a tool that auto-commits
    and pushes, but let's model provide a title or message.
  - working inside chezmoi? then a tool to force apply chezmoi?
  - further template the plan file, and other artifacts and make tools to format
    them? might enable easier patching, model doesn't have to write entire file,
    boilerplate is injected automatically, further enhances the view vs saved
    content idea
  - minimizes both the output tokens needed by a model, and the chance that it
    does things strangely
  - make tools themselves short and descriptive, and then the system prompts for
    tools looks like a scratch (scratch as in the gui+puzzle based toy
    programming game) workflow of using tools:

    e.g.

    ```
    # Builder

    ...

    ## Workflow

    - plan_load(args...)
    - evidence_load(args...)
    - (read, grep, glob, etc.)
    - (tools to run checks, or runner)
    - if issue:
        - issue_report(args...)
        - continue
    -

    ```

- Split up workflows, introduce skills and references so models have more
  on-the-fly context that doesn't need to be ingrained in the system prompt

- Make search agents shorter, make evidence files clearer and easier to read,
  try to limit token spend on any agent, make search cheaper?
