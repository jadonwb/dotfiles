#!/bin/bash
COLOR_STATEFILE="/tmp/hypr-original-border-color"
SIZE_STATEFILE="/tmp/hypr-original-border-size"
COLOR_KEY="general:col.active_border"
SIZE_KEY="general:border_size"
COLOR_CONFIG_FILE="$HOME/.config/omarchy/current/theme/hyprland.conf"
SIZE_CONFIG_FILE="$HOME/.config/hypr/looknfeel.conf"

COLOR2_FILE="$HOME/.config/omarchy/current/theme/kitty.conf"

save_current_border() {
    local original
    original=$(grep "^\$activeBorderColor" "$COLOR_CONFIG_FILE" | sed 's/^[^=]*= *//')

    if [ -n "$original" ]; then
        echo "$original" > "$COLOR_STATEFILE"
    fi
}

restore_border() {
    if [ -f "$COLOR_STATEFILE" ]; then
        local original
        original=$(cat "$COLOR_STATEFILE")
        hyprctl keyword "$COLOR_KEY" "$original" >/dev/null
        rm -f "$COLOR_STATEFILE"
    fi
}


save_current_border_size() {
    local original
    original=$(grep 'border_size' "$SIZE_CONFIG_FILE" | sed 's/^[^=]*= *//')

    if [ -n "$original" ]; then
        echo "$original" > "$SIZE_STATEFILE"
    fi
}

restore_border_size() {
    if [ -f "$SIZE_STATEFILE" ]; then
        local original
        original=$(cat "$SIZE_STATEFILE")
        hyprctl keyword "$SIZE_KEY" "$original" >/dev/null
        rm -f "$SIZE_STATEFILE"
    fi
}


get_color2_from_kitty() {
    local kitty_conf="$HOME/.config/omarchy/current/theme/kitty.conf"
    if [ ! -f "$kitty_conf" ]; then
        echo ""
        return 1
    fi
    local color=$(grep "^color2" "$kitty_conf" | awk '{print $2}' | tr -d '#')
    if [ -n "$color" ]; then
        echo "rgba(${color}ff)"
    else
        echo ""
        return 1
    fi
}

case "$1" in
  on)
    save_current_border
    COLOR2=$(get_color2_from_kitty)

    if [ -n "$COLOR2" ]; then
        hyprctl keyword "$COLOR_KEY" "$COLOR2" >/dev/null
    else
        echo "Failed to get color2 from kitty.conf" >&2
        exit 1
    fi
    # save_current_border_size
    # hyprctl keyword "$SIZE_KEY" "4" >/dev/null
    ;;
  off)
    while tmux display-message -p '#{client_prefix}' | grep -q 1; do
        sleep 0.05
    done
    restore_border
    # restore_border_size
    ;;
esac
