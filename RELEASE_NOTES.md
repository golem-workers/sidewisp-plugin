# Sidewisp Plugin v0.2.0

Public open-source release of the Sidewisp collector plugin.

## License change

Beginning with this release, Sidewisp Plugin is licensed under the GNU Affero
General Public License v3.0 (`AGPL-3.0-only`) instead of MIT.
Commercial use and modification are permitted under AGPLv3. Copyleft and
corresponding-source obligations apply when covered versions are conveyed or
AGPLv3 section 13 applies. Earlier releases remain governed by the license
shipped with those releases.

The collector remains free to use, modify, and redistribute under AGPLv3.
Sidewisp's hosted analysis, alerts, and recovery workflows remain separate
managed services.

## Documentation

- Added reproducible OpenClaw and Hermes installation guides.
- Added Codex and Claude Code command-hook adapters, installers, removal
  scripts, and runtime guides.
- Documented the boundary between the plugin and the managed service.
- Added explicit licensing, security-reporting, and contribution guidance.
- Added package metadata and package-content gates for public distribution.

## Contracts and compatibility

- Telemetry contract: `sidewisp.telemetry.v1`; no raw prompts, responses,
  files, credentials, or tool payloads.
- Spool schema: version 1; credentials and pending events are stored outside
  the package and survive reinstall or rollback.
- OpenClaw: verified with OpenClaw 2026.7.1-2 and plugin API 2026.7.1.
- Hermes: verified against the upstream hook, state, crash, and recovery
  interfaces documented in `COMPATIBILITY.md`.
- Codex: verified against CLI 0.145.0 and its stable lifecycle-hook contract.
- Claude Code: verified against the official 2.1.218 lifecycle-hook contract.

## Upgrade and rollback

Install the immutable release tag:

```bash
openclaw plugins install git:github.com/golem-workers/sidewisp-plugin@v0.2.0 --force
```

Before changing versions, back up the plugin state directory. Roll back by
installing the previously pinned release without deleting that directory.
Rolling back to `v0.1.20` also rolls back to that release's MIT license.

## Verification

- The release archive is accompanied by `SHA256SUMS`.
- GitHub Actions signs build provenance for the exact archive using OIDC and
  Sigstore.
- Verify provenance with
  `gh attestation verify <archive> --repo golem-workers/sidewisp-plugin`.
- Report security concerns privately through the repository Security tab.
