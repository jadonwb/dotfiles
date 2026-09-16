#!/usr/bin/env bash
set -euo pipefail

# Ensure OpenCode V2 is installed through mise's npm backend
# ("npm:@opencode/cli" in ~/.config/mise/config.toml, with the aube
# allow_low_downloads/allow_builds approvals). `mise install` is idempotent
# and also installs any other missing configured tools.
mise install