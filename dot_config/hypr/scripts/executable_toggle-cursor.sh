#!/bin/bash

CONFIG_FILE=/home/jadon/.config/hypr/hyprland.conf
TOGGLE_FILE=/home/jadon/.config/hypr/cursor_toggle.conf

if grep -q "^source = $TOGGLE_FILE" "$CONFIG_FILE"; then
    sed -i "s|^source = $TOGGLE_FILE|# source = $TOGGLE_FILE|g" "$CONFIG_FILE"
else
    sed -i "s|^# source = $TOGGLE_FILE|source = $TOGGLE_FILE|g" "$CONFIG_FILE"
fi

hyprctl reload
