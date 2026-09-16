# pi-vaultwarden repository

- Runtime-neutral core belongs in `core.ts`; it must not import pi or omp APIs.
- Keep secret values out of logs, diagnostics, tool results, commit messages, and documentation examples.
- Never put Vaultwarden session tokens or credentials in git.
- Use stdin or child-process environment variables for secret material; never pass secrets in command arguments.
- Keep CLI TypeScript erasable-only so Node.js `>=22.18.0` can run it directly.
- Verify `node --check` for all TypeScript files before publishing.
- Review `npm pack --dry-run` before `npm publish`.
