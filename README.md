# Sidewisp Collector Plugin

[![verify](https://github.com/golem-workers/sidewisp-plugin/actions/workflows/verify.yml/badge.svg)](https://github.com/golem-workers/sidewisp-plugin/actions/workflows/verify.yml)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-7163DD)](LICENSE)

Public, open-source, zero-LLM telemetry collector for observing AI agent
runtimes with Sidewisp.

The repository contains the collector, runtime adapters, privacy boundary,
durable local spool, signed delivery client, and safe diagnostics. OpenClaw,
Hermes, Codex, and Claude Code are supported today. Future runtimes can be
added behind the same telemetry and adapter contracts.

Sidewisp's hosted analysis, incident history, alerts, and recovery workflows
are a separate managed service. They are not included in this repository. See
[Product boundary](docs/PRODUCT_BOUNDARY.md).

## What the plugin does

- Observes deterministic runtime lifecycle, health, and failure metadata.
- Removes prompts, responses, files, credentials, tool payloads, and personal
  data before an event can enter the spool.
- Stores pending events in a bounded, owner-only SQLite spool.
- Uploads signed batches over outbound HTTPS after one-time enrollment.
- Exposes read-only `sidewisp.status` and `sidewisp.supportBundle` operator
  methods.
- Runs without an LLM, model provider, inbound port, or agent-facing tool.

The OpenClaw adapter runs as a native background service. It does not add an
agent tool and never sends commands to the observed agent. Hermes uses a
least-privileged per-user sidecar until an equivalent stable native lifecycle
is available. Codex and Claude Code use their documented command-hook
lifecycles plus an owner-only local spool worker.

## Open-source plugin and managed service

You may use this plugin personally or commercially, inspect it, modify it,
test it, and redistribute it under the
[GNU Affero General Public License v3.0](LICENSE). When a covered modified
version is conveyed, or when AGPLv3 section 13 applies, its corresponding
source must remain available under the same license.

Sending telemetry to Sidewisp's managed service requires an eligible account
and a one-time setup token. Access to that service is governed separately from
the plugin's open-source license. See [Licensing](LICENSING.md).

## OpenClaw quick start

Requirements:

- Node.js 22.22.3 or newer.
- OpenClaw 2026.7.1 or newer.
- A setup token from Sidewisp's **Connect agent** flow for managed delivery.

Install an immutable release:

```bash
openclaw plugins install git:github.com/golem-workers/sidewisp-plugin@v0.2.0 --force
openclaw plugins inspect sidewisp --runtime --json
```

Configure managed delivery:

```bash
openclaw config set plugins.entries.sidewisp.config.setupToken sw_setup_REPLACE_ME
openclaw gateway restart
openclaw gateway call sidewisp.status --json
```

The setup token is exchanged once for an installation credential and removed
from active configuration. Never commit or paste a real token into an issue,
log, or support bundle.

Expected status after enrollment:

```json
{
  "plugin": "sidewisp",
  "version": "0.2.0",
  "configured": true,
  "mode": "zero-llm"
}
```

The actual response also includes bounded spool, uploader, adapter, hook, and
health diagnostics.

See [OpenClaw usage](docs/OPENCLAW.md) for artifact verification, upgrades,
rollback, troubleshooting, and removal.

## Hermes quick start

From a verified checkout or release archive:

```bash
SIDEWISP_ENDPOINT=https://api.sidewisp.com \
HERMES_SOURCE_DIR="$HOME/hermes-agent" \
./scripts/install-hermes.sh sw_setup_REPLACE_ME
```

The installer runs without administrator privileges, exchanges the setup token
before creating the service, and never persists the token. It installs a
systemd user service on Linux or a LaunchAgent on macOS.

See [Hermes usage](docs/HERMES.md) for requirements, verification, updates,
and removal.

## Codex quick start

Requirements: Codex CLI 0.145.0 or newer and Node.js 22.22.3 or newer.

```bash
SIDEWISP_ENDPOINT=https://api.sidewisp.com \
./scripts/install-codex.sh sw_setup_REPLACE_ME
```

Restart Codex, open `/hooks`, and trust the reviewed Sidewisp hook definition.
See [Codex usage](docs/CODEX.md) for event coverage, privacy, delivery,
updates, rollback, and removal.

## Claude Code quick start

Requirements: Claude Code 2.1.218 or newer and Node.js 22.22.3 or newer.

```bash
SIDEWISP_ENDPOINT=https://api.sidewisp.com \
./scripts/install-claude-code.sh sw_setup_REPLACE_ME
```

Restart Claude Code after installation. See
[Claude Code usage](docs/CLAUDE_CODE.md) for event coverage, provider-failure
classification, privacy, updates, rollback, and removal.

## Develop locally

```bash
git clone https://github.com/golem-workers/sidewisp-plugin.git
cd sidewisp-plugin
npm test
npm run check
npm run pack:check
./scripts/verify-release.sh
```

The release verifier builds the exact tarball, installs it into an isolated
OpenClaw state directory, confirms the background service and diagnostics, and
rejects accidental agent tools or model providers.

## Documentation

- [OpenClaw installation and use](docs/OPENCLAW.md)
- [Hermes installation and use](docs/HERMES.md)
- [Codex installation and use](docs/CODEX.md)
- [Claude Code installation and use](docs/CLAUDE_CODE.md)
- [Plugin versus managed service](docs/PRODUCT_BOUNDARY.md)
- [Installation permissions](INSTALLATION_PERMISSIONS.md)
- [Compatibility and rollback](COMPATIBILITY.md)
- [E2E and canary evidence](E2E_AND_CANARY.md)
- [Security policy](SECURITY.md)
- [Contributing](CONTRIBUTING.md)

## License

New releases beginning with `v0.2.0` are available under the
[GNU Affero General Public License v3.0](LICENSE), SPDX identifier
`AGPL-3.0-only`.

This is an OSI-approved open-source license. Commercial use and modification
are permitted. Copyleft and corresponding-source obligations apply when
covered versions are conveyed or AGPLv3 section 13 applies. Earlier MIT
releases remain governed by the license distributed with those releases.
