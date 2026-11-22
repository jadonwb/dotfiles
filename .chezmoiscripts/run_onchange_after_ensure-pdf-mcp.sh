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

if ! command -v pdf-mcp >/dev/null 2>&1; then
  "$uv" tool install --python 3.14 pdf-mcp
fi
