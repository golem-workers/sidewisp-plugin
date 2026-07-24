# Plugin and managed-service boundary

Sidewisp is intentionally split into a public collector and a managed product.

## Public collector plugin

This repository contains:

- OpenClaw, Hermes, Codex, and Claude Code runtime adapters;
- deterministic health and failure normalization;
- telemetry sanitation and closed schemas;
- bounded, owner-only local spooling;
- enrollment and signed outbound delivery;
- read-only status and support diagnostics;
- safe update, canary, and rollback mechanisms.

The collector does not include:

- hosted telemetry storage or querying;
- incident correlation and history;
- explanations, prioritization, or recovery workflows;
- push notifications;
- private operations or administration tooling.

## Managed Sidewisp service

Sidewisp's managed product receives the collector's bounded telemetry and
provides hosted analysis, incident state, notifications, and recovery
workflows. Those managed capabilities are outside this repository.

The plugin must stay useful as an inspectable, testable integration boundary.
The hosted service is where Sidewisp operates product logic and subscription
features.

## Stable integration contract

The boundary is the versioned `sidewisp.telemetry.v1` event contract plus:

- one-time setup-token exchange;
- per-installation credentials;
- HMAC-signed telemetry batches;
- explicit acknowledgements and rejected-event codes;
- optional signed update directives.

Runtime adapters must not reproduce managed-service incident rules or product
business state. They emit bounded facts; the service interprets those facts.

## Licensing boundary

The plugin's public license covers this repository only. It does not license
the hosted service or mobile application. See [Licensing](../LICENSING.md).
