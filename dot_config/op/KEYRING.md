# Load the desktop-mcp key into the login keyring

One-time per machine, after the 1Password CLI is signed in (`op whoami` works).

## 1. Copy the secret reference

In the 1Password item, use **Copy Secret Reference**. It has the form:

```text
op://<vault>/<item>/<field>
```

## 2. Store the key in the login keyring

```sh
op read 'op://<vault>/<item>/<field>' | \
  secret-tool store \
    --label='desktop-mcp TypeSafe key' \
    service desktop-mcp key typesafe_api_key
```

The key travels through a pipe, so it does not appear in shell history or in a
process argument list. `op` will ask for authorization once.

## 3. Verify without printing the key

```sh
secret-tool lookup service desktop-mcp key typesafe_api_key >/dev/null && echo ok
```

Expected: `ok`.

## How the shell uses it

`.zshrc` reads the keyring once per shell and exports it:

```zsh
if [[ -z ${TYPESAFE_API_KEY:-} ]] && (( $+commands[secret-tool] )); then
  TYPESAFE_API_KEY="$(secret-tool lookup service desktop-mcp key typesafe_api_key 2>/dev/null)"
  [[ -n $TYPESAFE_API_KEY ]] && export TYPESAFE_API_KEY
fi
```

The MCP server only sees `TYPESAFE_API_KEY`; it has no 1Password or keyring
code.

## Rotate

Replace the value in 1Password and rerun step 2. New shells pick up the new
value.

## Notes

- Do not put the key or the secret reference in a tracked file.
- If `op read` prompts on every command, that is 1Password's CLI authorization,
  not the keyring. The keyring is read locally without `op`.
