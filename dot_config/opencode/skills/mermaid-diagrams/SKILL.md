---
name: Mermaid diagrams
description: Use when an explanation involves a flow, sequence, state machine, architecture, class model, or ER model. Emit a Mermaid fenced code block so the client renders it inline. Triggers: diagram, flowchart, sequence diagram, state machine, architecture, ER diagram, class diagram, visualize, draw, mermaid. Do not use when prose or a short list is clearer.
---

# Mermaid diagrams

OpenCode's TUI and graphical clients render ` ```mermaid ` fenced blocks as
diagrams. That is the only way to show a diagram: write the Mermaid source, not
ASCII art and not a custom tool call.

## When to use

Use a diagram when the relationships are easier to see than to read:

- a flow or decision path (`flowchart`)
- a request/response exchange (`sequenceDiagram`)
- a lifecycle or state machine (`stateDiagram-v2`)
- an architecture or component boundary (`flowchart` with subgraphs)
- a data model (`erDiagram` or `classDiagram`)

Skip the diagram when a short paragraph or a list is clearer. Pair every diagram
with one or two sentences that say what it shows and why it matters.

## Format

- Keep a diagram small: aim for 4–12 nodes, and split a large one rather than
  shrinking it.
- Prefer `flowchart TD` for top-down flows and `flowchart LR` for pipelines.
- Use short node IDs and readable labels: `A[User]`, `B[Evidence]`.
- Quote labels that contain spaces, punctuation, or parentheses:
  `A["Store (v2)"]`.
- Do not put Markdown links, HTML, or backticks inside labels.
- Use subgraphs for ownership or deployment boundaries, not decoration.
- Do not include a title inside the Mermaid source; put the title in the prose
  before the block.

Examples:

````markdown
The request path keeps writes single-threaded while research and review run in
isolated contexts:

```mermaid
flowchart LR
  U[User] --> S[system]
  S --> M[(evidence)]
  S --> P[(plans)]
  S --> Q[search]
  S --> R[review]
```
````

````markdown
The review loop only reruns the affected check:

```mermaid
sequenceDiagram
  participant S as system
  participant T as tests
  S->>T: run focused check
  alt passes
    T-->>S: pass
  else fails
    T-->>S: failure
    S->>S: fix in scope
    S->>T: rerun
  end
```
````

## Rendering

OpenCode renders the fence natively in the TUI and in graphical clients. Do not
call a separate diagram tool and do not paste rendered ASCII: the fence is the
durable, copyable source, and the client draws it. If a future client does not
render Mermaid, the source is still readable and can be opened later.
