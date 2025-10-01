export GOPATH=$HOME/c/go
export OMARCHY_PATH="/home/$USER/.local/share/omarchy"

export PATH=$PATH:$GOPATH/bin
export PATH="./bin:$HOME/.local/bin:$HOME/.local/share/omarchy/bin:$PATH"
export PATH=$HOME/.cargo/bin:$PATH
export PATH="$PATH:/home/jadon/.lmstudio/bin"
export PATH="$PATH:/opt/rocm/bin"

export EDITOR='nvim'
export SUDO_EDITOR="$EDITOR"

# amd rocm stuff
export ROCM_PATH=/opt/rocm
export HIP_PATH=/opt/rocm
export HSA_OVERRIDE_GFX_VERSION=11.0.0
export AMD_LOG_LEVEL=3
