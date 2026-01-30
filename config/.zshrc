# zmodload zsh/zprof

if [[ -r "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh" ]]; then
  source "${XDG_CACHE_HOME:-$HOME/.cache}/p10k-instant-prompt-${(%):-%n}.zsh"
fi

# disable flow-control thingy
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
zinit light zsh-users/zsh-completions
zinit light zsh-users/zsh-autosuggestions
zinit light jeffreytse/zsh-vi-mode
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

# Load completions
autoload -Uz compinit && compinit -u

zinit cdreplay -q

# Keybindings
bindkey -e
bindkey '^p' history-search-backward
bindkey '^n' history-search-forward
bindkey -r '^s'
bindkey -r '^q'

bindkey -r "^[^["
bindkey -M vicmd '!' sudo-command-line
bindkey -M viins '^[[33;5u' sudo-command-line

# History
HISTSIZE=10000
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
alias vim='nvim'
alias v='nvim'
alias n='nvim .'
alias t='tmux'
alias ta='tmux a'
alias c='clear'
alias q='exit'
alias ff='fd -H'
alias sg='rg --hidden'
alias ls='eza --long --no-user --header --icons --git --group-directories-first'
alias lsa='eza --long --no-user --header --icons --git --all --group-directories-first'
alias lt='eza --long --no-user --header --icons --git --group-directories-first --tree'
alias lta='eza --long --no-user --header --icons --git --all --group-directories-first --tree'

open() {
  xdg-open "$@" >/dev/null 2>&1 &
}

alias ..='cd ..'
alias ...='cd ../..'
alias ....='cd ../../..'
alias .....='cd ../../..'
alias lg="nvim +'lua Snacks.lazygit()'"
alias oc="opencode"

# lazy load zoxide
function cd() {
  unfunction cd
  eval "$(zoxide init --cmd cd zsh)"
  cd "$@"
}

export TMUX_PLUGIN_MANAGER_PATH="$HOME/.config/tmux/plugins/"

umask 007

[[ ! -f ~/.p10k.zsh ]] || source ~/.p10k.zsh

# zprof
