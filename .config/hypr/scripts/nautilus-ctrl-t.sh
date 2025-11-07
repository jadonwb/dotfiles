#!/bin/bash

if hyprctl clients | grep -q "class: org.gnome.Nautilus"; then
    hyprctl dispatch focuswindow "class:^(org.gnome.Nautilus)$"

    sleep 0.2

    hyprctl dispatch sendshortcut "CTRL,T,class:^(org.gnome.Nautilus)$"
else
    hyprctl dispatch exec "uwsm app -- nautilus --new-window"
fi
