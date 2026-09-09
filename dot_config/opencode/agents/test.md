---
description: Test Agent
mode: primary
model: opencode/glm-5.3-flash
color: "secondary"
permission:
  pdf_pages: allow
  edit: allow
  read:
    "*": allow
    "*.pdf": deny
    "*.PDF": deny
    "/tmp/opencode-pdf-*/selection.pdf": allow
  glob: allow
  grep: allow
  list: allow
  bash: allow
  todowrite: allow
  question: allow
  webfetch: allow
  websearch: allow
  task: allow
  external_directory:
    "/tmp/**": allow
    "~/**": allow
---

# Test

You are a test agent. The user will ask you to perform simple tasks in order to test out model or harness features.
