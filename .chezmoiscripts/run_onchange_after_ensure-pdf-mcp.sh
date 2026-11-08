#!/usr/bin/env bash
set -euo pipefail

# pdf-mcp runs locally over stdio; OCR uses the system Tesseract executable.
# Skip instead of failing the whole apply on machines that do not have the
# optional desktop toolchain installed.
if ! command -v pipx >/dev/null 2>&1; then
  echo "pdf-mcp: pipx not found; skipping PDF MCP install" >&2
  exit 0
fi

if ! command -v tesseract >/dev/null 2>&1; then
  echo "pdf-mcp: Tesseract not found; skipping PDF MCP install" >&2
  exit 0
fi

if ! command -v pdf-mcp >/dev/null 2>&1; then
  pipx install pdf-mcp
fi
