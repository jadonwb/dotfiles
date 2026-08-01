#!/bin/bash
set -e

TEST_DIR="/tmp/merge-test"

echo "=== Setting up merge conflict test in $TEST_DIR ==="

# Clean up any previous test
rm -rf "$TEST_DIR"
mkdir -p "$TEST_DIR"
cd "$TEST_DIR"

# Initialize repo (master as default branch)
git init -b master

# Initial commit on master
echo "line 1: original
line 2: original
line 3: original" >file.txt
git add file.txt
git commit -m "initial commit with original content"

# Create feature branch, modify line 2
git checkout -b feature
echo "line 1: original
line 2: FEATURE BRANCH CHANGE
line 3: original" >file.txt
git add file.txt
git commit -m "feature: change line 2"

# Back to master, modify line 2 differently
git checkout master
echo "line 1: original
line 2: MASTER BRANCH CHANGE
line 3: original" >file.txt
git add file.txt
git commit -m "master: change line 2 differently"

# Merge feature into master — this will conflict!
echo ""
echo "=== Merging feature into master (expecting conflict) ==="
git merge feature || true

echo ""
echo "=== Setup complete! ==="
echo ""
echo "To test:"
echo "  1. cd $TEST_DIR"
echo "  2. lazygit"
echo "  3. You should see file.txt listed as conflicted (UU)"
echo "  4. Press M on file.txt"
echo "  5. Select 'Open merge tool'"
echo "  6. DiffviewMergeFiles should open in a new tab in your existing nvim"
echo "  7. Resolve the conflict (edit the MERGED pane, save with :w)"
echo "  8. Close the diffview tab (:tabclose or :q)"
echo "  9. Reopen lazygit — file.txt should be resolved"
echo ""
echo "Cleanup: rm -rf $TEST_DIR /tmp/setup-merge-conflict.sh"
