#!/bin/bash

TERMINAL_CLASS="org.jadon.popterm"

if pgrep -f "$TERMINAL_CLASS" > /dev/null; then
  terminal_workspace=$(hyprctl clients -j | jq -r --arg class "$TERMINAL_CLASS" '.[] | select(.class == $class) | .workspace.name')
  
  if [[ "$terminal_workspace" == "special:popterm" ]]; then
    current_workspace=$(hyprctl activeworkspace -j | jq -r '.id')
    hyprctl dispatch movetoworkspace "$current_workspace", class:"$TERMINAL_CLASS"
    hyprctl dispatch pin
  else
    hyprctl dispatch pin
    hyprctl dispatch movetoworkspacesilent "special:popterm"
  fi
else
  uwsm-app -- xdg-terminal-exec --app-id="$TERMINAL_CLASS"
  sleep 0.5
  hyprctl dispatch pin
fi
