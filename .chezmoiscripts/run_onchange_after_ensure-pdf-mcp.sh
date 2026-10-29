#!/usr/bin/env bash
set -euo pipefail

# pdf-mcp runs locally over stdio; OCR uses the system Tesseract executable.
command -v pipx >/dev/null || { echo "Install pipx before applying the PDF MCP configuration." >&2; exit 1; }
if ! command -v pdf-mcp >/dev/null; then
  pipx install pdf-mcp
fi
command -v tesseract >/dev/null || { echo "Install Tesseract and its OCR language packs for PDF OCR." >&2; exit 1; }
