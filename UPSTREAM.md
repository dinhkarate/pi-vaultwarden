# Upstream relationship

This vendored extension mirrors `@jmcombs/pi-1password` 2.2.1's public surface:

- `credential-api.ts`: stateless auth.json resolution and onboarding API.
- `ui/bordered-popups.ts`: bordered select, input, and confirm overlays.
- `index.ts`: extension factory, diagnostics tool, setup and diagnose commands.

Behavioral differences:

- Vaultwarden uses `bw` references such as `!bw get password 'item'`.
- Availability requires `bw status` to report `unlocked`; locked vaults fail closed.
- Secrets are published into `process.env` so the native omp bash tool retains its
  `env`, `cwd`, `pty`, and `async` parameters. This intentionally avoids replacing
  the native bash tool with a spawn-hook wrapper.
- The extension reads both `~/.pi/agent/auth.json` and omp's agent auth.json;
  omp entries win on name collisions.

Refresh procedure: compare the upstream 2.2.1 API exports and popup option
signatures, port only compatible surface changes, then run the extension smoke
checks and verify that diagnostics expose names and state only, never values.
