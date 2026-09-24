# @piskill/pi-vaultwarden

Self-hosted Vaultwarden secret handling for **pi**, **omp**, and **Claude Code**.

The package keeps credentials in Vaultwarden, unlocks through local Keychain
credentials, resolves references on the machine, and injects only the required
values into child-process environments. Agent-visible diagnostics report names
and status, never secret values.

> The npm name `@piskill/pi-vaultwarden` is currently available. This repository
> is prepared for a future publish; it is not published yet.

## What it provides

- Runtime-neutral core with no pi/omp imports.
- Pi/omp extension:
  - `/vaultwarden_add`
  - `/vaultwarden_setup`
  - `/vaultwarden_rotate`
  - `/vaultwarden_diagnose`
  - `vw_add_secret`
  - `vw_diagnose`
- CLI for shell, CI, and Claude Code integration.
- Masked input for creating and rotating secrets.
- Atomic, locked updates to pi and omp `auth.json` files.
- Cold-start unlock from macOS Keychain or Linux `secret-tool`.

## Requirements

- Node.js `>=22.18.0`.
- Bitwarden CLI (`bw`) in `PATH`.
- A Vaultwarden server configured with `bw config server`.
- Keychain entries for:
  - `vaultwarden-api-client-id`
  - `vaultwarden-api-client-secret`
  - `vaultwarden-master-password`
- pi `>=0.80.10` or omp with TypeBox-compatible extension support.

The current development deployment uses `https://vault.thatnghiep.dev`. The
core constant can be changed for another server, but `bw config server` remains
the source of truth for the CLI.

## Install for pi

From npm after publication:

```bash
npm install -g @piskill/pi-vaultwarden
pi install @piskill/pi-vaultwarden
```

From this repository during development:

```bash
git clone https://github.com/dinhkarate/pi-vaultwarden.git
pi install ./pi-vaultwarden
```

The package manifest declares the extension entry through `pi.extensions` and
exposes the `pi-vaultwarden` binary.

## Install for omp

Install or link the package in the omp plugin/package location supported by your
omp setup. The extension entry is `index.ts`; omp rewrites the legacy pi
compatibility imports to its host copies.

For a local checkout, explicitly load it while testing:

```bash
omp -e ./extensions/pi-vaultwarden/index.ts
```

## First-time setup

Configure the server and verify the CLI:

```bash
bw config server https://vault.thatnghiep.dev
node cli.ts status
```

`status` attempts a cold-start unlock. It reads the master password and API
credentials from Keychain, logs in when necessary, runs `bw unlock`, and caches
the resulting session in:

```text
~/.config/pi-vaultwarden/session  # mode 0600
```

The session token is never printed. `BW_SESSION` does not need to be exported.

## CLI usage

During development run `node cli.ts`. After linking or npm installation use
`pi-vaultwarden`.

```bash
pi-vaultwarden status
pi-vaultwarden unlock
pi-vaultwarden env
pi-vaultwarden env --shell
```

`env` prints names only. `env --shell` prints shell exports because that is an
explicit request to publish values to the current shell; do not commit or log
that output.

### Resolve an existing entry

```bash
pi-vaultwarden get PI_DISCORD_WEBHOOK_URL
pi-vaultwarden api-key --item 'Thatnghiep Claude Proxy'
```

Secret values are written to stdout without a trailing newline. They are not
included in normal status, diagnostics, or mutation output.

### Run a command with injected secrets

```bash
pi-vaultwarden exec -- claude
pi-vaultwarden exec -- env
```

The child receives resolved uppercase environment entries from pi and omp
`auth.json`; provider credential keys are excluded from broad environment
injection.

### Create a new secret without shell variables

Pipe the value through stdin:

```bash
printf '%s' 'paste-secret-here' | \
  pi-vaultwarden add \
    --env GH_TOKEN \
    --item 'GitHub CLI token' \
    --notes 'Token for local GitHub automation' \
    --stdin
```

The command creates a login item, wires a name-based reference into both auth
stores by default, and reports only item/name/target/verification state.
Existing target keys are not overwritten. An item can be created before an auth
write conflict is reported with exit code `5`.

Use `--target omp`, `--target pi`, or `--target both` to limit wiring.

### Rotate and wire

```bash
printf '%s' 'replacement-secret' | \
  pi-vaultwarden rotate --item 'GitHub CLI token' --stdin

pi-vaultwarden wire --env GH_TOKEN --item 'GitHub CLI token'
pi-vaultwarden wire --env GH_TOKEN --item 'GitHub CLI token' --force
pi-vaultwarden unwire --env GH_TOKEN
```

References are name-based:

```text
!bw get password 'GitHub CLI token'
```

Renaming a Vaultwarden item therefore requires rewiring its consumers.

### Link the CLI

```bash
pi-vaultwarden link-cli
pi-vaultwarden link-cli --dir ~/.local/bin --force
```

The command creates `~/.local/bin/pi-vaultwarden` pointing at the real CLI file.

## Claude Code

Claude Code has no TypeScript extension API. Use one of these explicit paths.

### Model credential helper

```bash
pi-vaultwarden claude-setup \
  --item 'Thatnghiep Claude Proxy' \
  --ttl-ms 600000
```

This writes `apiKeyHelper` to the selected settings file and creates a
`settings.json.bak-YYYYmmdd-HHMMSS` backup. It refuses to replace an existing
helper unless `--force` is provided.

`CLAUDE_CODE_API_KEY_HELPER_TTL_MS` controls helper refresh frequency. The
current account uses Claude Code OAuth, so do not run this against the real
settings file unless intentionally switching the model credential path. Test
against a copy:

```bash
cp ~/.claude/settings.json /tmp/claude-settings.json
pi-vaultwarden claude-setup \
  --item 'Thatnghiep Claude Proxy' \
  --settings /tmp/claude-settings.json \
  --ttl-ms 600000
```

### Other secrets

`settings.json` environment values are literals and do not expand shell
commands. Use the CLI wrapper instead:

```bash
pi-vaultwarden exec -- claude
```

This supports `GH_TOKEN`, webhooks, proxy keys, and other wired secrets without
placing plaintext values in Claude Code settings.

## Pi/omp interactive commands

After loading the extension:

- `/secret [description]` asks local Qwen at `sanrokyu-local` to propose an item name, `UPPER_SNAKE_CASE` variable, and purpose. The secret value is entered only afterward in a masked prompt; it is never sent to Qwen. The final notification includes a usage line such as `Usage: getSecret("Item") or process.env.VARIABLE`.
- `/vaultwarden_add` asks for item name, environment name, purpose, and a
  masked secret; it creates and wires the item.
- `/vaultwarden_setup` searches existing items and wires a selected reference.
- `/vaultwarden_rotate` selects an item and accepts a masked replacement.
- `/vaultwarden_diagnose` reports status and injected names.
The `vw_add_secret` tool provides the same paste-to-create flow when requested
by an agent. The secret is supplied by the user through a masked popup and is
not returned in the tool result.

### Startup performance and caching

Secret references resolve through one batched `bw list items` call whose
decrypted result is cached for 7 days by default, shared by the extension load path,
every `session_start`, and the CLI. Previously each `!bw get password` entry
spawned its own `bw` process (~3.5s on a cold CLI), so six wired secrets added
~20 seconds to agent startup. References to deleted or renamed items are
negative-cached for the same window instead of re-spawning a failing lookup on
every refresh.

- `PI_VAULTWARDEN_CACHE_TTL_MS` overrides the cache window (milliseconds;
  `0` disables caching).
- The extension hydrates the environment in the background and never blocks
  `loadExtensions`; retries back off exponentially up to 60 seconds.
- Create/rotate/delete operations invalidate the cache immediately.

## Diagnostics and exit codes

```bash
pi-vaultwarden doctor
```

Exit codes:

- `0`: success.
- `2`: usage or argument error.
- `3`: Vaultwarden unavailable or locked.
- `4`: secret missing or item name ambiguous.
- `5`: auth target write conflict.

## Security model

- Secret values are passed to `bw` through stdin or environment variables, never
  command arguments.
- Vaultwarden session tokens are stored with `0600` permissions.
- Auth writes use an exclusive lock, stale-lock recovery, temp file, and atomic
  rename.
- Environment injection excludes known provider keys and accepts only
  `UPPER_SNAKE_CASE` names.
- Diagnostics and mutation output contain names and state only.
- `claude-setup` never silently overwrites an existing helper.

## Development verification

From the repository root:

```bash
node --check core.ts
node --check cli.ts
node --check index.ts
node --check ui/bordered-popups.ts
```

End-to-end checks require a configured Vaultwarden account:

```bash
env -u BW_SESSION node cli.ts status
env -u BW_SESSION node cli.ts env
```

## Publishing later

The package is intentionally scoped as `@piskill/pi-vaultwarden`. Before the
first publish:

1. Create or confirm the GitHub repository URL in `package.json`.
2. Review the package contents with `npm pack --dry-run`.
3. Ensure no session files, settings backups, credentials, or generated output
   are in the package.
4. Run the cold-start, injection, CLI lifecycle, Claude helper-copy, and
   reference-audit checks.
5. Publish from this standalone repository:

```bash
npm login
npm publish --access public
```

The package is **not published yet**; npm registry checks currently return 404
for both `pi-vaultwarden` and `@piskill/pi-vaultwarden`.

## License

MIT — © 2026 dinhkarate
