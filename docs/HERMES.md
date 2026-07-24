# Use Sidewisp with Hermes Agent

## Requirements

- Node.js 22.22.3 or newer.
- A supported Hermes Agent checkout.
- Linux with a systemd user session or macOS with LaunchAgent support.
- Outbound HTTPS access to the configured Sidewisp endpoint.
- A one-time setup token from Sidewisp's **Connect agent** flow.

The default installation is per-user and does not use `sudo`.

## Verify the release

Download the release archive and `SHA256SUMS` from GitHub Releases, verify the
digest and GitHub attestation, then unpack it into a temporary directory.

```bash
gh release download v0.2.0 \
  --repo golem-workers/sidewisp-plugin \
  --pattern '*.tgz' \
  --pattern SHA256SUMS
sha256sum --check SHA256SUMS
gh attestation verify sidewisp-plugin-0.2.0.tgz \
  --repo golem-workers/sidewisp-plugin
```

## Install

From the verified checkout or unpacked archive:

```bash
SIDEWISP_ENDPOINT=https://api.sidewisp.com \
HERMES_SOURCE_DIR="$HOME/hermes-agent" \
./scripts/install-hermes.sh sw_setup_REPLACE_ME
```

The installer:

1. validates HTTPS, the setup token shape, and the Hermes source directory;
2. exchanges the token before installing the service;
3. stores the installation credential with owner-only permissions;
4. installs an immutable release directory and atomically switches `current`;
5. starts a systemd user service on Linux or LaunchAgent on macOS.

The setup token is not persisted in the service definition.

## Verify

Linux:

```bash
systemctl --user status sidewisp-hermes-collector.service
journalctl --user -u sidewisp-hermes-collector.service --since today
```

macOS:

```bash
launchctl print "gui/$(id -u)/com.sidewisp.hermes-collector"
```

Logs must remain metadata-only. Redact any unexpected runtime content before
sharing a diagnostic.

## Update and rollback

Use only signed, immutable release archives. The update helper stages a new
release, atomically switches the `current` symlink, waits for a healthy
collector heartbeat, and rolls back on failure.

Retain the previous release and Sidewisp state directory until the new version
passes its healthy-heartbeat gate.

## Remove

From a verified checkout:

```bash
./scripts/uninstall-hermes.sh
```

The uninstaller removes the service and installed collector. Credentials and
the spool are retained until you explicitly delete them.

## Troubleshooting

- Setup token rejected: create a fresh single-use token.
- Service does not start: verify Node.js, Hermes path, and user-service support.
- Delivery retries: verify outbound HTTPS and system time.
- Spool degraded: verify disk capacity and owner-only permissions.

See [Installation permissions](../INSTALLATION_PERMISSIONS.md) and
[Compatibility](../COMPATIBILITY.md).
