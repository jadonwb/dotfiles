---
description: Test agent
mode: primary
model: opencode/glm-5.3-flash
color: "secondary"
permission:
  save_evidence: allow
  pdf_read: allow
  pdf_search: allow
  edit: allow
  read:
    "*": allow
    "*.pdf": deny
    "*.PDF": deny
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

# Tester

Test agent for the user to test new and custom tools, new models, ideas, or to
validate the agentic workflow from an unbiased perspective.
