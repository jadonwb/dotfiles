# zmodload zsh/zprof

if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

stty -ixon < /dev/tty

[ -f ~/.fzf.zsh ] && source ~/.fzf.zsh
eval "$(fzf --zsh)"

# export ENV
export FZF_DEFAULT_OPTS="$FZF_DEFAULT_OPTS --ansi --color=16"
export _ZO_EXCLUDE_DIRS="/net/*:/media/*:/tmp/*"
export MANPAGER='nvim +Man!'

# Set the directory we want to store zinit and plugins
ZINIT_HOME="${XDG_DATA_HOME:-${HOME}/.local/share}/zinit/zinit.git"

# Download Zinit, if it's not there yet
if [ ! -d "$ZINIT_HOME" ]; then
   mkdir -p "$(dirname $ZINIT_HOME)"
   git clone https://github.com/zdharma-continuum/zinit.git "$ZINIT_HOME"
fi

# Source/Load zinit
source "${ZINIT_HOME}/zinit.zsh"

# prompt
zinit ice depth=1; zinit light romkatv/powerlevel10k

# Add in zsh plugins
zinit light zsh-users/zsh-syntax-highlighting
zinit ice wait lucid
zinit light zsh-users/zsh-completions
zinit ice wait lucid atload"_zsh_autosuggest_start"
zinit light zsh-users/zsh-autosuggestions
zinit ice wait lucid
zinit light Aloxaf/fzf-tab

# Add in snippets
zinit ice wait lucid
zinit snippet OMZL::git.zsh
zinit ice wait lucid
zinit snippet OMZP::git
zinit ice wait lucid
zinit snippet OMZP::sudo
zinit ice wait lucid
zinit snippet OMZP::command-not-found

autoload -Uz compinit
for dump in ~/.zcompdump(N.mh+24); do
  compinit
done
compinit -C

zinit cdreplay -q

# Keybindings
bindkey -e
bindkey '^p' history-search-backward
bindkey '^n' history-search-forward
bindkey -r '^s'
bindkey -r '^q'

bindkey -r "^[^["
bindkey '^[s' sudo-command-line

# History
HISTSIZE=5000
HISTFILE=~/.zsh_history
SAVEHIST=$HISTSIZE
HISTDUP=erase
setopt appendhistory
setopt sharehistory
setopt hist_ignore_space
setopt hist_ignore_all_dups
setopt hist_save_no_dups
setopt hist_ignore_dups
setopt hist_find_no_dups

# Completion styling
zstyle ':fzf-tab:*' fzf-flags ${(z)FZF_DEFAULT_OPTS}
zstyle ':completion:*' matcher-list 'm:{a-z}={A-Za-z}'
zstyle ':completion:*' list-colors "${(s.:.)LS_COLORS}"
zstyle ':completion:*' menu no
zstyle ':fzf-tab:complete:cd:*' fzf-preview 'ls --color $realpath'
zstyle ':fzf-tab:complete:__zoxide_z:*' fzf-preview 'ls --color $realpath'
zstyle ':fzf-tab:complete:c:*' disabled-on any

# Aliases
alias comprebuild='rm -f ~/.zcompdump* && exec zsh'
alias vim='nvim'
alias c='clear'
alias q='exit'
alias bls='/bin/ls'
alias ls='eza -lh --group-directories-first --icons=auto'
alias lsa='ls -aag'
alias lt='eza --tree --level=2 --long --icons --git'
alias lta='lt -a'
alias ff="fzf --preview 'bat --style=numbers --color=always {}'"
open() {
  xdg-open "$@" >/dev/null 2>&1 &
}
alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'
alias g='lazygit'
alias d='docker'
n() { if [ "$#" -eq 0 ]; then nvim .; else nvim "$@"; fi; }

# lazy load zoxide
function cd() {
  unfunction cd
  eval "$(zoxide init --cmd cd zsh)"
  cd "$@"
}

umask 007

function sesh-sessions() {
  exec </dev/tty
  exec <&1
  local session
  session=$(sesh list -t -z -d | fzf \
    --height 40% \
    --reverse \
    --border-label ' sesh ' \
    --border \
    --prompt '⚡  ')
  zle reset-prompt > /dev/null 2>&1 || true
  [[ -z "$session" ]] && return
  sesh connect $session
}

zle     -N            sesh-sessions
bindkey -M emacs '^s' sesh-sessions
bindkey -M vicmd '^s' sesh-sessions
bindkey -M viins '^s' sesh-sessions

[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# zprof
