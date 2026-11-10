---
name: Desktop
description: Guidance for using the desktop MCP. Choose one `op=goal` call for any workflow beyond a single one- or two-step action, let Jev decide each step, and verify every objective. The MCP tool description is authoritative for schema. Triggers: desktop, UI test, click, computer control, computer use, live test, desktop automation, Jev.
---

# Desktop

This skill is about how to use the desktop MCP. It does not restate the goal
schema or examples; the MCP's own description is authoritative for tool behavior
and schema.

## Hard rule

**Anything beyond a single one- or two-step desktop action MUST be one `op=goal`
call.** Do not build the workflow out of primitive calls. If you are about to
make a second or third primitive call for one task, stop and rewrite it as a
goal.

## Pick the entry point

- One simple action (close, focus, launch, wait, screenshot): use the matching
  primitive.
- More than one or two observable steps: one `op=goal` call.
- `op=plan` is for replaying a fixed test, not normal work.

## Write the goal for the agent, not the tool

- One objective per observable state change, in order. Make navigation its own
  objective when the control is on another page.
- Put the values that vary in `bindings`, keyed by the control name.
- Each predicate must identify the target page or state, not a shared label.
- When control names are unknown, observe the page first and use the real roles
  and names; do not guess them.
- If the app exposes no accessible tree, choose a visual surface rather than a
  tree predicate that cannot succeed.

## Keep the workflow honest

- The predicate is the completion condition. An action returning `ok` does not
  finish the objective.
- Let Jev choose the actions; do not pre-compute a click or key sequence.
- On failure, read the objectives and trace, then fix the ambiguous predicate or
  instruction. Do not fall back to a manual primitive chain.
- If one objective keeps failing, narrow it to that objective and make the
  predicate page-specific before retrying.

## Shared desktop

- Announce before a goal that opens or focuses a window the user will see.
- Close every window you launched; make cleanup the last objective or use one
  close primitive.
- If the user takes over, stop.

## Hand off

- Login, payment, 2FA, captcha, and destructive confirmations are the user's.
