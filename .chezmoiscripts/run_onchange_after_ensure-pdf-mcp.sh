#!/usr/bin/env bash
set -euo pipefail

# pdf-mcp runs locally over stdio; OCR uses the system Tesseract executable.
# Install it as a uv tool, the same way this repository installs user tools.
uv=""
if command -v uv >/dev/null 2>&1; then
  uv="$(command -v uv)"
else
  for candidate in "$HOME/.local/bin/uv" /usr/bin/uv; do
    if [[ -x $candidate ]]; then
      uv="$candidate"
      break
    fi
  done
fi

if [[ -z $uv ]]; then
  echo "pdf-mcp: uv not found; skipping PDF MCP install" >&2
  exit 0
fi

if ! command -v tesseract >/dev/null 2>&1; then
  echo "pdf-mcp: Tesseract not found; skipping PDF MCP install" >&2
  exit 0
fi

# A pipx install owns the same command names. Remove it first so uv can take
# them over without --force.
pdf_mcp="$(command -v pdf-mcp || true)"
if [[ -n $pdf_mcp ]] && [[ $(readlink -f "$pdf_mcp") != "$HOME"/.local/share/uv/tools/* ]]; then
  pipx="$(command -v pipx || true)"
  if [[ -z $pipx && -x $HOME/.local/bin/pipx ]]; then
    pipx="$HOME/.local/bin/pipx"
  fi
  if [[ -n $pipx ]]; then
    "$pipx" uninstall pdf-mcp >/dev/null 2>&1 || true
  fi
fi

if ! command -v pdf-mcp >/dev/null 2>&1; then
  if ! "$uv" tool install --python 3.14 pdf-mcp; then
    echo "pdf-mcp: uv install failed; continuing without it" >&2
  fi
fi
