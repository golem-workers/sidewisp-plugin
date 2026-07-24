# Contributing

Bug reports, runtime compatibility findings, documentation improvements, and
focused code changes are welcome.

## Before opening a pull request

1. Search existing issues.
2. Open an issue before a large change or a new runtime adapter.
3. Keep telemetry metadata-only and deterministic.
4. Do not add prompts, responses, files, credentials, tool payloads, personal
   data, model calls, inbound ports, autonomous remediation, or agent-facing
   tools.
5. Add or update tests for behavior and privacy boundaries.

## Validate

```bash
npm test
npm run check
npm run pack:check
./scripts/verify-release.sh
```

Changes to a runtime adapter should also run its relevant E2E command from
`package.json`.

## Licensing

By submitting a contribution, you confirm that you have the right to submit it
under `AGPL-3.0-only`. Do not submit code copied from an incompatible project.

## Reports and support

- Reproducible bug: open a GitHub issue with versions, expected behavior, and
  metadata-only logs.
- Security vulnerability: follow [SECURITY.md](SECURITY.md); do not open a
  public issue.
- Setup token, subscription, or account problem: use the support channel
  published at <https://sidewisp.com/>.

Never include real setup tokens, installation secrets, prompts, responses,
customer data, or complete runtime state directories.
