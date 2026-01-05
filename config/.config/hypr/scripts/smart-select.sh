#!/bin/bash

active=$(hyprctl activewindow -j)
class=$(echo "$active" | jq -r '.class')
title=$(echo "$active" | jq -r '.title')
address=$(echo "$active" | jq -r '.address')

if [[ "$class" == "kitty" ]]; then
    if [[ "$title" == *"tmux"* ]]; then
        current_proc=$(tmux display-message -p '#{pane_current_command}')
        
        if [[ "$current_proc" =~ n?vim ]]; then
            hyprctl dispatch sendshortcut ",v,address:$address"
            sleep 0.05
            hyprctl dispatch sendshortcut ",a,address:$address"
            sleep 0.05
            hyprctl dispatch sendshortcut ",g,address:$address"
        fi
    else
        pid=$(echo "$active" | jq -r '.pid')

        if [[ $(ps -p "$pid" -o comm=) == *"nvim"* ]] || \
           [[ $(ps -p "$(pgrep -P "$pid" | xargs -I {} pgrep -P {})" -o comm=) ]]; then
            hyprctl dispatch sendshortcut ",v,address:$address"
            sleep 0.05
            hyprctl dispatch sendshortcut ",a,address:$address"
            sleep 0.05
            hyprctl dispatch sendshortcut ",g,address:$address"
        fi
    fi
else
    hyprctl dispatch sendshortcut "CTRL,A,address:$address"
fi
