export EDITOR='nvim'
export SUDO_EDITOR="$EDITOR"

. "$HOME/.cargo/env"

export GOPATH=$HOME/go
export PATH=$HOME/bin:$PATH
export PATH=$HOME/.local/bin:$PATH
export PATH=$PATH:$GOPATH/bin
