# Security policy

## Supported versions

Security fixes are provided for the latest signed release. Older versions may
receive a fix when the affected contract is still supported, but users should
upgrade to the latest release unless release notes say otherwise.

## Report a vulnerability

Use GitHub's private vulnerability reporting flow:

<https://github.com/golem-workers/sidewisp-plugin/security/advisories/new>

Do not open a public issue for a vulnerability. Include:

- affected plugin and runtime versions;
- operating system and installation mode;
- minimal reproduction steps;
- impact and known exposure;
- a redacted support bundle when useful.

Do not include setup tokens, installation secrets, prompts, responses, tool
payloads, personal data, or full spool databases.

## Security boundary

The collector must remain metadata-only, outbound-only, zero-LLM, and unable to
control the observed agent. Changes that add model calls, inbound listeners,
agent-facing tools, broad filesystem access, content collection, or autonomous
remediation require a new threat model and explicit review.

Codex and Claude Code hook inputs contain sensitive content fields. Adapters
must use explicit scalar allowlists and must not serialize `prompt`,
`transcript_path`, `last_assistant_message`, `tool_input`, `tool_response`,
provider error text, or arbitrary hook fields. Hook failures must exit without
blocking or steering the observed runtime.
