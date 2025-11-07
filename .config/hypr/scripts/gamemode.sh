#!/bin/bash

ANIMATIONS_ENABLED=$(hyprctl getoption animations:enabled -j | jq -r '.int')

if [ "$ANIMATIONS_ENABLED" -eq 1 ]; then
    hyprctl --batch "\
        keyword animations:enabled 0;\
        keyword decoration:shadow:enabled 0;\
        keyword decoration:blur:enabled 0;\
        keyword general:gaps_in 0;\
        keyword general:gaps_out 0;\
        keyword general:border_size 1;\
        keyword decoration:rounding 0;\
        keyword decoration:dim_inactive 0;\
        keyword general:allow_tearing 1"
    if pgrep -x waybar >/dev/null; then
      pkill -x waybar
    fi
    notify-send "Game Mode" "Enabled" -t 2000
else
    hyprctl reload
    if ! pgrep -x waybar >/dev/null; then
      uwsm app -- waybar >/dev/null 2>&1 &
    fi
    notify-send "Game Mode" "Disabled" -t 2000
fi


