# Invitation-authorized staging → production (PR92/220/193)

## Minimal command emitted by the existing-OpenClaw-staging branch

Use a checksum-verified immutable official plugin archive that contains this fix.
This pre-publication source candidate is not yet such a release. Do not reuse the
old v0.2.88 candidate digest, and do not treat APK108 as the final app candidate.

```sh
node <verified-package>/scripts/prepare-openclaw.mjs \
  --enqueue --update-only \
  --archive <absolute-archive> --sha256 <official-release-sha256> \
  --endpoint https://staging-api.sidewisp.com \
  --preparation-endpoint https://api.sidewisp.com \
  --request-id <current-request-id> \
  --expires-at-ms <original-expiry-ms> \
  --state-dir "$OPENCLAW_STATE_DIR" \
  --accept-staging-to-production
```

Preserve actual `OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR` of the active
profile (canonical absolute paths); never substitute extraction paths. Use the
same generator for Copy and Share. The invitation text must explicitly state:
"Sending this current production invitation authorizes the existing ordinary
staging binding in this profile to reconnect to https://api.sidewisp.com without
a second host-confirmation question. Preserve files, settings and native cron.
Host policy and idle admission still apply. Use new production authorization;
never send the old installation credentials to the destination."

## Scope and server protocol

- Exactly `https://staging-api.sidewisp.com` → `https://api.sidewisp.com`, no
  trailing paths, ports, alternate origins, first installs, or blanket rollout.
- The flag is explicit consent supplied by the user-delivered invitation, not
  consent inferred from a plan, a mismatch, or a status check. Without the flag,
  the existing mismatch/explicit-confirmation branch remains unchanged.
- Consent binds request ID, original expiry, canonical profile and source
  credential fingerprint. Each invitation has a distinct candidate directory.
- Helper owns preparation → isolated begin → existing account authorization →
  proof-bound poll/ACK → signed credential validation → cooperative idle cutover.
  No second Telegram host question and no extra setup command.
- HTTP payloads are unchanged. Existing authenticated app `autoConnect:true`
  means invitation creation is account consent; `autoConnect:false` still needs
  the existing owner decision in-app. The local host flag does not change this.
- Never recreate begin, reset expiry, enable FREE_TEST_MODE, change recent-login
  policy or creation policy, disable host admission, loosen archive admission,
  or copy source credentials to production. Source signed status goes only to
  staging. Destination requests use this invitation's independent local proof.
- The returned server expiry must match the original invitation exactly before
  credential collection/activation. Existing server policy is 15 minutes total;
  the app must use the actual response, not manufacture its own deadline.

## Status and retry contract

`preparation_queued` is not authorization pending or success. End the setup turn;
independent helper continues. `prepare-status.json` contains `connection_pending`
and `nextAction.type=automatic_transition` after preparation. The transition's
`connection-status.json` reports terminal `activated`, or blocked with a safe
reason. Only a fresh server-accepted heartbeat establishes current connection
success in the app. Historical preparation warnings cannot supersede new health.

Repeated command: one preparation job / transition supervisor, no new invitation
or credentials; after activated, returns the existing activated receipt even
past expiry without mutation. Changing the original expiry is rejected. An
unactivated expired invitation requires a fresh user invitation.

Pre-activation failure keeps the source binding and service. Failure after
starting the destination preserves destination state plus the intact source
archive, reports `transition_recovery_required`, and cannot automatically
rollback over destination writes. No user workspace/config/cron file is deleted.

## Acceptance boundary

Use only the existing disposable profile/infrastructure. Do not change working
3d/landing bindings, production deployment/release pins, or global bootstrap.
Evidence must distinguish source/contract tests, the real isolated-agent path,
model execution and Android acceptance. No publication or production deploy.
