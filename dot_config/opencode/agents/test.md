---
description: Test agent
mode: primary
model: opencode/glm-5.3-flash#default
permissions:
  - action: save_evidence
    resource: "*"
    effect: allow
  - action: pdf_read
    resource: "*"
    effect: allow
  - action: pdf_search
    resource: "*"
    effect: allow
  - action: edit
    resource: "*"
    effect: allow
  - action: read
    resource: "*"
    effect: allow
  - action: read
    resource: "*.pdf"
    effect: deny
  - action: read
    resource: "*.PDF"
    effect: deny
  - action: glob
    resource: "*"
    effect: allow
  - action: grep
    resource: "*"
    effect: allow
  - action: shell
    resource: "*"
    effect: allow
  - action: question
    resource: "*"
    effect: allow
  - action: webfetch
    resource: "*"
    effect: allow
  - action: websearch
    resource: "*"
    effect: allow
  - action: subagent
    resource: "*"
    effect: allow
  - action: external_directory
    resource: "/tmp/*"
    effect: allow
  - action: external_directory
    resource: "~/*"
    effect: allow
---

# Tester

Test agent for the user to test new and custom tools, new models, ideas, or to
validate the agentic workflow from an unbiased perspective.
