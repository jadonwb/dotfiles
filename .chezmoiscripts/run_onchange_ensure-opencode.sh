#!/usr/bin/env bash
set -euo pipefail

# Temporary migration: move OpenCode from mise's npm backend to npm global.
# Remove this script from the chezmoi source once every machine has applied it.

if ! command -v npm >/dev/null 2>&1; then
  printf 'OpenCode migration skipped: npm is not installed.\n' >&2
  exit 1
fi

printf 'Migrating OpenCode to a regular global npm install...\n'
npm install --global --allow-scripts='@opencode/cli' '@opencode/cli@latest'

# Only remove mise-managed copies after npm installation succeeds.
if command -v mise >/dev/null 2>&1; then
  while read -r tool version; do
    [[ -n "${tool:-}" && -n "${version:-}" ]] || continue
    mise uninstall -y "${tool}@${version}"
  done < <(mise ls --installed 2>/dev/null | awk '$1 == "npm:@opencode/cli" { print $1, $2 }')
  mise reshim >/dev/null 2>&1 || true
fi

printf '\nOpenCode is now installed globally with npm.\n'
printf 'Migration complete. Remove .chezmoiscripts/run_after_ensure-opencode.sh from the chezmoi source.\n'
