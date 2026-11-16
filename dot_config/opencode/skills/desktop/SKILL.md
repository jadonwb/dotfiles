---
name: Desktop
description: Automated desktop UI testing through one Markdown mission (desktop op=run). Jev executes it locally; you judge the returned evidence. Triggers: desktop, UI test, click, computer control, computer use, live test, desktop automation, Jev.
---

# Desktop

For anything beyond one simple action, write one Markdown mission and call
`desktop op=run`. The tool's `mission` field documents the grammar; it is
authoritative.

## Write the mission

```text
App: application-window-class
Purpose: Smooth scrolling setting
Launch: ["/usr/bin/my-app"]

1. Open Preferences and go to Scrolling settings.
   Expect: The Smooth scrolling check box is visible.
2. Disable Smooth scrolling.
   Assert: {"target":{"role":"check box","name":"Smooth scrolling"},"property":"checked","equals":false}
3. Open a long document and scroll down.
   Expect: The document moved down smoothly.
   Record: scrolling-off
4. Re-enable Smooth scrolling.
   Assert: {"target":{"role":"check box","name":"Smooth scrolling"},"property":"checked","equals":true}
```

- One milestone per outcome you want to check; a milestone may take several actions.
- `Assert:` anything measurable (checked, text, value, present, scroll_delta).
  Code checks it, and a milestone whose Asserts pass completes at once.
- `Expect:` describes what you will judge from the frame. Jev also uses it to
  know when the milestone is finished, so describe the visible end state.
- Exact text goes in `Values:` or in quotes. Keys go in `Press:` lines. Jev
  never invents text or keys.
- `Record:` for animation, scrolling or flicker. `Target:` for a custom-drawn control.
- Undo what the test changed with explicit final milestones.

## Read the result

- `status` is execution; `verification.status` is the test verdict
  (`failed`, `needs_agent_verification`, `passed`).
- Open `summary.md` and `contact-sheet.png`, then the frames cited as #N and any
  recording sheets. Judge each Expect yourself and report Assert results and
  your judgments separately.
- A paused run (uncertain, stalled, target_not_found, focus left) keeps the
  desktop. Read its failure and last frames, then resume, or cancel and rewrite
  the mission more specifically.

## Shared desktop

- Run tests on a server started with `--isolated`: headless, and it never
  touches the user's windows. On the live desktop, stop if the user takes over.
- Login, payment, 2FA, captcha and destructive confirmations are the user's.
