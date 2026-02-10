show_learn_menu() {
  case $(menu "Learn" "  Keybindings\n  Omarchy\n  Hyprland\n󰣇  Arch\n󰒲  LazyVim\n  Neovim\n󱆃  Bash\n󰻞  ChatGPT\n󰻞  Claude\n Motions") in
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
    *) show_main_menu ;;
  esac
}
