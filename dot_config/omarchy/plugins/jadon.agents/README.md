# My Agents

Personal clone of Omarchy's agents widget. Shows Codex, Claude and Fireworks
limits, OpenCode Go allowances and DeepSeek API balance. It lives in the user
plugin directory, so the same checkout works on any Omarchy install and
survives system updates. The manifest follows Omarchy's clonedFrom contract.

Collection is bounded: the updater runs named collectors only — the native
Claude, Codex and Fireworks collectors when Omarchy provides them, plus this
plugin's OpenCode Go and DeepSeek collectors — and never scans a bin directory
or invokes the native wildcard updater. Native collector roots come from
OMARCHY_PATH, with the standard packaged and per-user locations as fallbacks.
Credentials stay in OpenCode or the session environment; they are read into
process memory only and are never written to dotfiles or usage records. An
explicit disable marker at `~/.local/state/omarchy/agents/usage-disabled` (or
`~/.local/state/omarchy-ubuntu/agent-usage-disabled` on the compat setup)
stops collection without deleting credentials.

The native UI files were cloned from Omarchy 4.0.6. Compare with the built-in
agents plugin when updating Omarchy and merge UI changes here deliberately.
Collection follows the widget's refreshIntervalSec setting in shell.json.
Deploy code and manifest changes from the dotfiles checkout. Remove by
disabling jadon.agents and deleting this plugin directory; leave OpenCode
credentials intact.

Provider SVG marks come from anomalyco/opencode,
packages/ui/src/assets/icons/provider/.
