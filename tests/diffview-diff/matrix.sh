#!/usr/bin/env bash
# diffview-diff case matrix.
#
# Exercises the difftool helper with a fake `nvim` on PATH, so each case records
# which path the helper took (in-worktree fast path or copied-file fallback) and
# what it handed to Neovim.
#
#   tests/diffview-diff/matrix.sh
set -uo pipefail

helper=${DIFFVIEW_DIFF:-"$HOME/.local/bin/diffview-diff"}
if [ ! -x "$helper" ]; then
  echo "matrix.sh: helper not found: $helper" >&2
  exit 2
fi

tmp=$(mktemp -d "${TMPDIR:-/tmp}/dvd.XXXXXX")
trap 'rm -rf -- "$tmp"' EXIT

bin=$tmp/bin
mkdir -p "$bin" "$tmp/repo"
log=$tmp/calls.log
: >"$log"

# Fake nvim: records argv and the DIFFVIEW_* environment, and can fail the
# --remote-expr call so the fallback path runs.
cat >"$bin/nvim" <<'FAKE'
#!/usr/bin/env bash
{
  printf 'args=%s ' "$*"
  printf 'path=%s ' "${DIFFVIEW_PATH-}"
  printf 'rev=%s ' "${DIFFVIEW_REV-}"
  printf 'root=%s ' "${DIFFVIEW_ROOT-}"
  printf 'local=%s ' "${DIFFVIEW_LOCAL-}"
  printf 'remote=%s' "${DIFFVIEW_REMOTE-}"
} >"$FAKE_LOG"
if [ "${1-}" = "--server" ]; then
  [ "${FAKE_SERVER:-ok}" = "fail" ] && exit 1
  exit 0
fi
exit 0
FAKE
chmod +x "$bin/nvim"

# One repository holding every state the classifier distinguishes.
repo=$tmp/repo
cd "$repo" || exit 1
git init -q -b main .
git config user.email test@example.com
git config user.name test
git config diff.tool nvimdiff
git config difftool.prompt false
git config difftool.nvimdiff.cmd "\"$helper\" \"\$LOCAL\" \"\$REMOTE\" \"\$MERGED\""

printf 'one\n' >mod.txt
printf 'one\n' >staged.txt
printf 'one\n' >hist.txt
printf 'one\n' >gone.txt
printf 'one\n' >'sp ace'"'"'quote ünï.txt'
printf 'one\n' >renamed.txt
git add -A
git commit -qm base

printf 'two\n' >>mod.txt
printf 'two\n' >>staged.txt
git add staged.txt
printf 'two\n' >>hist.txt
git commit -qam hist
printf 'two\n' >added.txt
git add added.txt
rm gone.txt
git mv renamed.txt renamed2.txt
printf 'two\n' >>'sp ace'"'"'quote ünï.txt'

# `git commit -a` above swept the earlier edits into the commit, so recreate the
# states the first two cases need.
printf 'three\n' >>mod.txt
printf 'three\n' >>staged.txt
git add staged.txt

pass=0
fail=0

# check <label> <expected-substring> <path-to-assert> <assertion-kind>
check() {
  local label=$1 want=$2 path=${3-} kind=${4-}
  local line
  line=$(cat "$log" 2>/dev/null)
  : >"$log"

  local ok=1
  case "$kind" in
    fast)
      [[ $line == *"$want"* ]] || ok=0
      [[ $line == *"path=$path"* ]] || ok=0
      ;;
    copy)
      [[ $line == *"diff_files"* ]] || ok=0
      [[ $line == *"local="* && $line == *"remote="* ]] || ok=0
      ;;
    remote)
      [[ $line == *"--remote-expr"* ]] || ok=0
      [[ $line == *"$want"* ]] || ok=0
      ;;
  esac

  if [ "$ok" = 1 ]; then
    pass=$((pass + 1))
    printf 'ok   - %s\n' "$label"
  else
    fail=$((fail + 1))
    printf 'FAIL - %s\n' "$label"
    printf '       got: %s\n' "$(printf '%s' "$line" | tr '\n' ' ')"
  fi
}

FAKE_LOG=$log PATH="$bin:$PATH"
export FAKE_LOG PATH

unset NVIM

# Unstaged change: fast path, no revision.
git difftool -y -- mod.txt >/dev/null 2>&1
check 'unstaged -> worktree fast path' 'NVDiffview.open_worktree' 'mod.txt' fast

# Staged-only change with a clean worktree: fast path against HEAD.
git difftool -y --cached -- staged.txt >/dev/null 2>&1
check 'staged-only -> worktree at HEAD' 'NVDiffview.open_worktree' 'staged.txt' fast

# Path with spaces, quotes and non-ASCII: the fast path still applies.
git difftool -y -- 'sp ace'"'"'quote ünï.txt' >/dev/null 2>&1
check 'spaces/quotes/unicode -> fast path' 'NVDiffview.open_worktree' 'sp ace'"'"'quote ünï.txt' fast

# Historical comparison: copied files.
git difftool -y HEAD~1 HEAD -- hist.txt >/dev/null 2>&1
check 'historical commit -> copied files' '' '' copy

# Added file: no HEAD entry, so the copies are used.
git difftool -y --cached -- added.txt >/dev/null 2>&1
check 'added file -> copied files' '' '' copy

# Deleted file: nothing to open in the worktree.
git difftool -y -- gone.txt >/dev/null 2>&1
check 'deleted file -> copied files' '' '' copy

# Rename: ambiguous sides, so the copies are used.
git difftool -y --cached -- renamed2.txt >/dev/null 2>&1
check 'rename -> copied files' '' '' copy

# Running Neovim accepts the RPC: the comparison is handed to it.
NVIM=$tmp/fake.sock FAKE_SERVER=ok git difftool -y -- mod.txt >/dev/null 2>&1
check 'existing nvim -> remote-expr' 'NVDiffview.open_worktree' 'mod.txt' remote

# Running Neovim refuses: fall back to a dedicated process with copies.
NVIM=$tmp/fake.sock FAKE_SERVER=fail git difftool -y -- mod.txt >/dev/null 2>&1
check 'unreachable nvim -> copied files' '' '' copy

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
