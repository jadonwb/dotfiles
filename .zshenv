. "$HOME/.cargo/env"

export FZF_DEFAULT_OPTS="$FZF_DEFAULT_OPTS --ansi --color=16"

export GOPATH=$HOME/go
export PATH=$HOME/.local/bin:$PATH
export PATH=$HOME/.cargo/bin:$PATH
export PATH=$PATH:$GOPATH/bin
export MANPAGER='nvim +Man!'

export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion
