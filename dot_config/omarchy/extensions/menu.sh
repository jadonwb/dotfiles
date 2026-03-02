#!/bin/bash

show_learn_menu() {
  case $(menu "Learn" "  Keybindings\n  Omarchy\n  Hyprland\n󰣇  Arch\n󰒲  LazyVim\n  Neovim\n󱆃  Bash\n󰻞  ChatGPT\n󰻞  Claude\n  Motions\n󰰕  Opencode\n  Wikipedia") in
  *Keybindings*) omarchy-menu-keybindings ;;
  *Omarchy*) omarchy-launch-webapp "https://learn.omacom.io/2/the-omarchy-manual" ;;
  *Hyprland*) omarchy-launch-webapp "https://wiki.hypr.land/" ;;
  *Arch*) omarchy-launch-webapp "https://wiki.archlinux.org/title/Main_page" ;;
  *Bash*) omarchy-launch-webapp "https://devhints.io/bash" ;;
  *LazyVim*) omarchy-launch-webapp "https://www.lazyvim.org/keymaps" ;;
  *Neovim*) omarchy-launch-webapp "https://neovim.io/" ;;
  *Motions*) omarchy-launch-webapp "https://quickref.me/vim.html" ;;
  *Opencode*) omarchy-launch-webapp "https://opencode.ai/docs" ;;
  *Wikipedia*) omarchy-launch-webapp "https://en.wikipedia.org/wiki/Main_Page" ;;
  *) show_main_menu ;;
  esac
}
