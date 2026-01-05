#!/bin/bash

active=$(hyprctl activewindow -j)
class=$(echo "$active" | jq -r '.class')
# title=$(echo "$active" | jq -r '.title')
address=$(echo "$active" | jq -r '.address')

if [[ "$class" == "com.mitchellh.ghostty" ]]; then
    pid=$(echo "$active" | jq -r '.pid')

    if [[ $(ps -p "$pid" -o comm=) == *"nvim"* ]] ||
        [[ $(ps -p "$(pgrep -P "$pid" | xargs -I {} pgrep -P {})" -o comm=) ]]; then
        hyprctl dispatch sendshortcut ",y,address:$address"
    else
        hyprctl dispatch sendshortcut "CTRL,INSERT,address:$address"
    fi
else
    hyprctl dispatch sendshortcut "CTRL,INSERT,address:$address"
fi
