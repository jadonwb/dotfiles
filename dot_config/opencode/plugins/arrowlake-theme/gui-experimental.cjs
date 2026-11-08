const { Plugin, Theme } = require("@opencode/plugin/gui")

const theme = {
  "$schema": "https://opencode.ai/desktop-theme.json",
  "name": "Arrowlake",
  "id": "arrowlake",
  "light": {
    "palette": {
      "neutral": "#ebe0cf",
      "ink": "#54473f",
      "primary": "#6660AF",
      "interactive": "#56AEA9",
      "success": "#4E7469",
      "warning": "#AE984C",
      "error": "#BC495D",
      "info": "#4A74A8",
      "diffAdd": "#4E7469",
      "diffDelete": "#BC495D"
    },
    "overrides": {
      "text-strong": "#54473f",
      "text-base": "#54473f",
      "text-weak": "#6c5e55",
      "text-weaker": "#87786c",
      "syntax-comment": "#87786c",
      "syntax-keyword": "#C16C90",
      "syntax-function": "#6660AF",
      "syntax-variable": "#54473f",
      "syntax-string": "#4E7469",
      "syntax-number": "#AE984C",
      "syntax-type": "#4A74A8",
      "syntax-operator": "#6a8b89",
      "syntax-punctuation": "#6c5e55",
      "syntax-primitive": "#6284ae",
      "syntax-property": "#6c5e55",
      "syntax-constant": "#AE984C",
      "syntax-critical": "#BC495D",
      "syntax-diff-add": "#4E7469",
      "syntax-diff-delete": "#BC495D",
      "syntax-diff-unknown": "#C16C90"
    }
  },
  "dark": {
    "palette": {
      "neutral": "#0D0C25",
      "ink": "#bec8e8",
      "primary": "#3F3BF5",
      "interactive": "#FB9B00",
      "success": "#2A8A6B",
      "warning": "#FB9B00",
      "error": "#E50050",
      "info": "#5352CD",
      "diffAdd": "#2A8A6B",
      "diffDelete": "#E50050"
    },
    "overrides": {
      "text-strong": "#bec8e8",
      "text-base": "#bec8e8",
      "text-weak": "#7e85b8",
      "text-weaker": "#5c6296",
      "syntax-comment": "#5c6296",
      "syntax-keyword": "#D91C87",
      "syntax-function": "#3F3BF5",
      "syntax-variable": "#bec8e8",
      "syntax-string": "#2A8A6B",
      "syntax-number": "#FFD888",
      "syntax-type": "#5352CD",
      "syntax-operator": "#9AC1E5",
      "syntax-punctuation": "#7e85b8",
      "syntax-primitive": "#4948b4",
      "syntax-property": "#7e85b8",
      "syntax-constant": "#FFD888",
      "syntax-critical": "#E50050",
      "syntax-diff-add": "#2A8A6B",
      "syntax-diff-delete": "#E50050",
      "syntax-diff-unknown": "#D91C87"
    }
  }
}

const plugin = Plugin.define({
  setup(ctx) {
    ctx.add(Theme, theme)
  },
})

module.exports = plugin
module.exports.default = plugin
