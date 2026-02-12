#!/bin/bash

show_learn_menu() {
  case $(menu "Learn" "  Keybindings\n  Omarchy\n  Hyprland\n󰣇  Arch\n󰒲  LazyVim\n  Neovim\n󱆃  Bash\n󰻞  ChatGPT\n󰻞  Claude\n Motions\n󰰕  Opencode\n  Wikipedia") in
    *Keybindings*) omarchy-menu-keybindings ;;
    *Omarchy*) omarchy-launch-webapp "https://learn.omacom.io/2/the-omarchy-manual" ;;
    *Hyprland*) omarchy-launch-webapp "https://wiki.hypr.land/" ;;
    *Arch*) omarchy-launch-webapp "https://wiki.archlinux.org/title/Main_page" ;;
    *Bash*) omarchy-launch-webapp "https://devhints.io/bash" ;;
    *LazyVim*) omarchy-launch-webapp "https://www.lazyvim.org/keymaps" ;;
    *Neovim*) omarchy-launch-webapp "https://neovim.io/" ;;
    *Motions*) omarchy-launch-webapp "https://quickref.me/vim.html" ;;
    *ChatGPT*) omarchy-launch-webapp "https://chatgpt.com/" ;;
    *Claude*) omarchy-launch-webapp "https://claude.ai/" ;;
    *Opencode*) omarchy-launch-webapp "https://opencode.ai/docs" ;;
    *Wikipedia*) omarchy-launch-webapp "https://en.wikipedia.org/wiki/Main_Page" ;;
    *) show_main_menu ;;
  esac
}

get_workspace_windows() {
  local current_workspace=$(hyprctl activeworkspace -j | jq -r '.id')

  hyprctl clients -j | jq -r --arg current_ws "$current_workspace" '
    .[] | 
    select(.mapped == true) | 
    {
      display: if .workspace.name | startswith("special:") then 
        if .workspace.id == ($current_ws | tonumber) then
          "*S | \(.class // "Unknown")"
        else
          "S | \(.class // "Unknown")"
        end
      else 
        if .workspace.id == ($current_ws | tonumber) then
          "*\(.workspace.id) | \(.class // "Unknown")"
        else
          "\(.workspace.id) | \(.class // "Unknown")"
        end
      end,
    } | 
    "\(.display)"
  ' | sort -t'|' -k4,4 -k1,1n
}

show_workspace_menu() {
  local windows_list

  windows_list=$(get_workspace_windows)

  if [[ -z "$windows_list" ]]; then
    notify-send "Workspace" "No windows found in other workspaces"
    return
  fi

  declare -A class_map
  local menu_options=""

  while IFS='|' read -r workspace_num window_class; do
    if [[ -n "$workspace_num" ]]; then
      local friendly_name
      friendly_name=$(known_windows "$window_class")
      local display_string="${workspace_num} | ${friendly_name}"

      class_map["$display_string"]="$window_class"
      menu_options="${menu_options}${display_string}\n"
    fi
  done <<< "$windows_list"

  selection=$(workspace_menu "Workspace" "$menu_options")

  if [[ -n "$selection" ]]; then
    local real_class
    real_class=$(echo "${class_map["$selection"]}" | xargs)

    if [[ -n "$real_class" ]]; then
      hyprctl dispatch focuswindow "class:$real_class"
    fi
  else
     back_to show_main_menu
  fi
}

workspace_menu() {
  local prompt="$1"
  local options="$2"
  local extra="$3"
  local preselect="$4"

  read -r -a args <<< "$extra"

  if [[ -n "$preselect" ]]; then
    local index
    index=$(echo -e "$options" | grep -nxF "$preselect" | cut -d: -f1)
    if [[ -n "$index" ]]; then
      args+=("-c" "$index")
    fi
  fi

  monitor_height=$(hyprctl monitors -j | jq -r '.[] | select(.focused == true) | .height')
  menu_height=$((monitor_height * 40 / 100))

  echo -e "$options" | omarchy-launch-walker --dmenu --width 500 --height "$menu_height" -p "$prompt…" "${args[@]}" 2> /dev/null
}

known_windows() {
  case "${1}" in
    *brave-browser*) echo "Brave Browser" ;;
    *vesktop*) echo "Discord" ;;
    *com.mitchellh.ghostty*) echo "Ghostty" ;;
    *brave-music.apple.com__-Default*) echo "Apple Music" ;;
    *brave-www.icloud.com__-Default*) echo "iCloud" ;;
    *brave-www.reddit.com__-Default*) echo "Reddit" ;;
    *) echo "$1" ;;
  esac
}

go_to_menu() {
  case "${1,,}" in
    *apps*) walker -p "Launch…" ;;
    *learn*) show_learn_menu ;;
    *trigger*) show_trigger_menu ;;
    *share*) show_share_menu ;;
    *capture*) show_capture_menu ;;
    *workspace*) show_workspace_menu ;;
    *style*) show_style_menu ;;
    *theme*) show_theme_menu ;;
    *screenshot*) show_screenshot_menu ;;
    *screenrecord*) show_screenrecord_menu ;;
    *setup*) show_setup_menu ;;
    *power*) show_setup_power_menu ;;
    *install*) show_install_menu ;;
    *remove*) show_remove_menu ;;
    *update*) show_update_menu ;;
    *about*) omarchy-launch-about ;;
    *system*) show_system_menu ;;
  esac
}
