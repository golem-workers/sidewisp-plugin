# Sidewisp Plugin v0.1.1

Production-candidate release of the universal, zero-LLM Sidewisp runtime adapter. This release safely reclaims a stale spool writer lock after a runtime crash or forced gateway restart while retaining strict single-writer protection.

## Contracts and compatibility

- Telemetry contract: `sidewisp.telemetry.v1`; no raw prompts, responses, files, credentials, or tool payloads.
- Spool schema: version 1; credentials and pending events are stored outside the package and survive reinstall or rollback.
- OpenClaw: verified with OpenClaw 2026.7.1-2 and plugin API 2026.7.1.
- Hermes: verified against the upstream hook, state, crash, and recovery interfaces documented in `COMPATIBILITY.md`.

## Upgrade and rollback

Install the immutable release tag:

```bash
openclaw plugins install git:github.com/golem-workers/sidewisp-plugin@v0.1.1 --force
```

Before changing versions, back up the plugin state directory. Roll back by installing the previously pinned release without deleting that directory. The release verification job performs a clean isolated install and confirms that the plugin exposes no tools or model providers.

## Verification

- The release archive is accompanied by `SHA256SUMS`.
- GitHub Actions signs build provenance for the exact archive using OIDC and Sigstore.
- Verify provenance with `gh attestation verify <archive> --repo golem-workers/sidewisp-plugin`.
- Report security concerns privately through the repository Security tab.
