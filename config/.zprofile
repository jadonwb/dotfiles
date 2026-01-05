export SSH_ENV=$HOME/.ssh/environment_${HOSTNAME}

function start_agent {
     echo -n "Initialising new SSH agent... "
     touch ${SSH_ENV}
     chmod 600 ${SSH_ENV}
     /usr/bin/ssh-agent -s | sed 's/^echo/#echo/' > ${SSH_ENV}
     echo "succeeded."
     . ${SSH_ENV} > /dev/null
}

# Don't use Gnome keyring program (seahorse or whatever), because of GUI prompts.
if [[ $SSH_AUTH_SOCK =~ /run/user ]]; then
    unset SSH_AUTH_SOCK
    unset SSH_AGENT_PID
fi

# Source SSH settings, if applicable
ssh-add -l > /dev/null 2>&1
if [ $? -eq 0 -o $? -eq 1 ]; then
    # echo "SSH Agent found."
else
    # echo -n "Looking for SSH Agent... "
    if [ -f "${SSH_ENV}" ]; then
        . ${SSH_ENV} > /dev/null
        ssh-add -l > /dev/null 2>&1
        if [ $? -eq 0 -o $? -eq 1 ]; then
            # echo "found pid: ${SSH_AGENT_PID}."
        else
            echo "SSH Agent not found."
            start_agent;
        fi
    else
        start_agent;
    fi
    ssh-add -l
fi

# exports needed in rare cases
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \. "$NVM_DIR/nvm.sh"  # This loads nvm
[ -s "$NVM_DIR/bash_completion" ] && \. "$NVM_DIR/bash_completion"  # This loads nvm bash_completion

export OMARCHY_PATH="$HOME/.local/share/omarchy"
export PATH="$OMARCHY_PATH/bin:$PATH"
export PATH="$HOME/.local/bin:$PATH"
export PATH="$HOME/.cargo/bin:$PATH"
