# Compatibility and release policy

| Component | Supported baseline | Behavior outside baseline |
| --- | --- | --- |
| Node.js | 22.22.3 or newer | Installation is rejected by package engines. |
| OpenClaw | 2026.7.x, plugin API 2026.7.1+ | Hooks fail closed; unsupported recovery formats emit a local diagnostic and do not break the agent. |
| Hermes Agent | Native hook API represented by `hermes/sidewisp/plugin.yaml` | Unknown state schemas are read-only and reported as degraded; no heuristic content scan is attempted. |
| Sidewisp telemetry | `sidewisp.telemetry.v1` | Unknown contracts are retained locally and are not uploaded. |

Production installations must pin an immutable annotated release tag, never `main`. Every release runs `scripts/verify-release.sh`, which tests the package, builds the exact tarball, installs it into an isolated OpenClaw state directory, and confirms that it loads only a background service and safe operator methods. GitHub Actions signs provenance for the exact archive using OIDC/Sigstore and publishes its SHA-256 alongside the release; verify it with `gh attestation verify` before installation.

## Upgrade and rollback

1. Stop or restart the runtime normally so the collector closes its SQLite writer lock.
2. Back up the Sidewisp state directory containing `installation.json` and `spool.sqlite`.
3. Install the pinned target tag or tarball and inspect `sidewisp` before restarting the gateway.
4. On rollback, install the previous signed tag without deleting the state directory. Credentials and pending events are runtime state and are intentionally not part of the package.
5. If a future release requires a spool migration, its release notes must identify the last backward-readable schema and include a tested downgrade path.

Release notes must call out telemetry contract, privacy allowlist, credential storage, spool schema, runtime compatibility, and rollback changes.
