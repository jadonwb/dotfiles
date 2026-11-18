---
description: Owns the user request, works directly, and delegates bounded work.
mode: primary
color: "#6660AF"
permissions:
  - action: subagent
    resource: "*"
    effect: deny
  - action: subagent
    resource: worker
    effect: allow
# Guidance: prompts/lead.md
---
