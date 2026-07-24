# Use Sidewisp with OpenClaw

## Requirements

- Node.js 22.22.3 or newer.
- OpenClaw 2026.7.1 or newer.
- Outbound HTTPS access to the configured Sidewisp endpoint.
- A setup token from Sidewisp's **Connect agent** flow for managed delivery.

No administrator privileges, inbound port, model provider, or LLM API key is
required.

## Install a signed release

The shortest installation uses an immutable Git tag:

```bash
openclaw plugins install git:github.com/golem-workers/sidewisp-plugin@v0.2.0 --force
```

For artifact-level verification, download the release:

```bash
gh release download v0.2.0 \
  --repo golem-workers/sidewisp-plugin \
  --pattern '*.tgz' \
  --pattern SHA256SUMS
sha256sum --check SHA256SUMS
gh attestation verify sidewisp-plugin-0.2.0.tgz \
  --repo golem-workers/sidewisp-plugin
openclaw plugins install ./sidewisp-plugin-0.2.0.tgz --force
```

Inspect the installed runtime before enabling delivery:

```bash
openclaw plugins inspect sidewisp --runtime --json
```

The plugin should be `loaded`, expose service `sidewisp-collector`, expose only
the `sidewisp.status` and `sidewisp.supportBundle` gateway methods, and expose
no agent tools or model providers.

## Enroll

```bash
openclaw config set plugins.entries.sidewisp.config.setupToken sw_setup_REPLACE_ME
openclaw gateway restart
```

The token is exchanged once for a scoped installation credential stored with
owner-only permissions. After a successful exchange, the token is removed from
active OpenClaw configuration.

To use a non-default compatible endpoint:

```bash
openclaw config set plugins.entries.sidewisp.config.endpoint https://api.example.test
```

The endpoint must implement the documented Sidewisp enrollment and signed
telemetry contracts. Changing the URL alone does not make an arbitrary HTTP
collector compatible.

## Verify

```bash
openclaw gateway call sidewisp.status --json
```

Check:

- `configured` is `true`;
- `installation.state` is `active`;
- `spool.status` is `healthy`;
- `uploader.status` becomes `idle` or `sent`;
- `mode` is `zero-llm`;
- adapter health has no unexpected degraded capability.

Generate a redacted diagnostic bundle:

```bash
openclaw gateway call sidewisp.supportBundle --json
```

The support bundle intentionally excludes setup tokens, installation secrets,
event payloads, prompts, responses, identities, and full endpoint paths.

## Upgrade

Read the target release notes, back up the Sidewisp state directory, then
install the new immutable tag:

```bash
openclaw plugins install git:github.com/golem-workers/sidewisp-plugin@v0.2.0 --force
openclaw gateway restart
openclaw gateway call sidewisp.status --json
```

Do not delete `installation.json` or `spool.sqlite` during an upgrade.

## Roll back

Install the previously verified tag and restart:

```bash
openclaw plugins install git:github.com/golem-workers/sidewisp-plugin@v0.1.20 --force
openclaw gateway restart
```

Credentials and pending events live outside the package and survive rollback
when the release notes declare the spool schema backward-readable.

## Disable or remove

Disable collection while retaining installation files:

```bash
openclaw config set plugins.entries.sidewisp.config.enabled false
openclaw gateway restart
```

Preview removal, then uninstall:

```bash
openclaw plugins uninstall sidewisp --dry-run
openclaw plugins uninstall sidewisp
openclaw gateway restart
```

Uninstalling the package does not imply deletion of credentials or pending
telemetry. Delete retained Sidewisp state only after reviewing its exact path
and deciding that recovery is no longer needed.

## Troubleshooting

### `awaiting setup`

No active installation credential exists. Create a fresh one-time setup token,
set it in plugin configuration, and restart OpenClaw. A token is single-use.

### `enrollment-failed`

Confirm outbound HTTPS, endpoint origin, token freshness, and system time.
Never post the token in an issue.

### `credential-rejected`

The installation may be revoked or rotated. Use Sidewisp's Connect agent flow
to issue a replacement token.

### `spool` is degraded or unhealthy

Check disk capacity and ownership of the OpenClaw state directory. Do not edit
the SQLite database while OpenClaw is running.

### Plugin is not loaded

Run:

```bash
openclaw plugins inspect sidewisp --runtime --json
openclaw status
```

Compare Node.js and OpenClaw versions with [COMPATIBILITY.md](../COMPATIBILITY.md).
