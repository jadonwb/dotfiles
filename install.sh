#!/bin/bash

if [[ $(basename "$(pwd)") != "dotfiles" ]]; then
    echo "Please run this script from the dotfiles directory."
    exit 1
fi

stow -t ~ config --adopt --no-folding
