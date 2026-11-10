---
description:
  Primary agent for engineering, research, system work, and artifact-driven
  sessions.
mode: primary
model: deepseek/deepseek-flash#default
color: "#6660AF"
# The body is empty on purpose. An agent with a non-empty body replaces
# OpenCode's base prompt, including the tool guidance OpenCode builds from the
# enabled tools, and the guidance plugin then skips the agent. Leaving the body
# empty keeps that base prompt; plugins/system-prompt inserts prompts/system.md
# as the next system part. Edit the agent's wording in prompts/system.md.
---
