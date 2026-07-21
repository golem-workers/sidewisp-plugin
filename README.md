# Sidewisp Plugin

Public, universal, zero-LLM telemetry collector for observing AI agent runtimes with Sidewisp.

This is one plugin repository with runtime-specific adapters. The first adapters target OpenClaw and Hermes; future runtimes are added here behind the same telemetry, identity, spool, and remediation contracts.

The OpenClaw adapter runs as a native background service. It does not add an agent tool, does not call a model, and never sends commands to the observed agent.

## Current status

The repository contains the installable plugin shell and runtime status contract. Telemetry collection, durable spooling, signed ingestion, and deterministic incident rules are being implemented for the first production release.

## Install from GitHub

```bash
openclaw plugins install git:github.com/golem-workers/sidewisp-plugin@main --force
openclaw plugins inspect sidewisp --runtime --json
```

For reproducible production installs, use a signed version tag instead of `main`.

## Configure

```bash
openclaw config set plugins.entries.sidewisp.config.setupToken sw_setup_REPLACE_ME
openclaw gateway restart
```

The setup token will be exchanged for a per-installation credential in the production implementation. Never commit a real token.

## Safety model

- No LLM, embedding, or inference calls.
- Outbound HTTPS only; no inbound port on the agent.
- No autonomous remediation or control of the observed agent.
- Future remediation is presented as a prompt for the user to review and manually send to the agent.
- Prompts, responses, files, credentials, and personal data are excluded from telemetry by default.

## Validate

```bash
npm test
npm run check
npm run pack:check
```

## License

MIT
