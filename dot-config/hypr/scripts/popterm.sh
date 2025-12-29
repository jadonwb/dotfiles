#!/bin/bash

if [ -n "$(pgrep -f "org.jadon.popterm")" ]; then
  pkill -f "org.jadon.popterm"
else
  uwsm-app -- xdg-terminal-exec --app-id=org.jadon.popterm
fi
