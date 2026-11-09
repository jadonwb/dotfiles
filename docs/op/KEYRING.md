# Load the desktop-mcp key into the login keyring

One-time per machine, after the 1Password CLI is signed in (`op whoami` works).

## 0. Prerequisites

Install the 1Password CLI and `secret-tool` (`libsecret-tools` on Ubuntu,
`libsecret` on Arch):

```sh
sudo apt install 1password-cli libsecret-tools
```

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

## How the key reaches desktop-mcp

The opencode config gives the MCP server a credential command, so it reads the
keyring itself and does not depend on the shell that launched opencode:

```jsonc
"environment": {
  "TYPESAFE_API_KEY_COMMAND": "/usr/bin/secret-tool lookup service desktop-mcp key typesafe_api_key"
}
```

The command is an argv list run without a shell; only its stdout (the key) is
used, and it is never logged.

## Rotate

Replace the value in 1Password and rerun step 2. New shells pick up the new
value.

## Notes

- Do not put the key or the secret reference in a tracked file.
- If `op read` prompts on every command, that is 1Password's CLI authorization,
  not the keyring. The keyring is read locally without `op`.
- `op signin` must be run in the same shell session that calls any `op` command
  or it will continually prompt.
