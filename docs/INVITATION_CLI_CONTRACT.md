# Unified same-origin invitation CLI contract

Status: source review candidate, NOT shipped in official 0.2.89. The app patch is not assumed published. Never overwrite/repack v0.2.89. A new immutable official plugin/manager release and matching app release pin are required before user delivery. No backend runtime/schema change is required.

## One command, no model-side binding choice

For a fresh installation or an existing installation whose configured canonical endpoint equals the invitation endpoint, run exactly the same entrypoint. The helper must be extracted from the same verified release archive supplied to --archive; use absolute persistent paths. STATE_DIR and CONFIG_FILE identify the real active profile, not a temporary or guessed profile.

```sh
OPENCLAW_STATE_DIR="$STATE_DIR" \
OPENCLAW_CONFIG_PATH="$CONFIG_FILE" \
node "$EXTRACTED_RELEASE/package/scripts/prepare-openclaw.mjs" \
  --enqueue \
  --archive "$ARCHIVE" \
  --sha256 "$ARCHIVE_SHA256" \
  --endpoint "https://api.sidewisp.com" \
  --state-dir "$STATE_DIR" \
  --request-id "$REQUEST_ID" \
  --expires-at-ms "$ORIGINAL_EXPIRES_AT_MS" \
  --telegram-target "$CHAT_ID" \
  --telegram-account "$ACCOUNT_ID"
```

For a Telegram topic append `--telegram-thread-id "$THREAD_ID"`. Chat/account/thread must come from trusted channel context, never invitation text. Outside Telegram omit all Telegram options. The endpoint, requestId and original expiry are the fresh user-authenticated invitation's values; do not extend or replace expiry during preparation. The release metadata must include the exact tag/commit/asset/SHA256 of the NEW approved official release. There is deliberately no new flag or CLI subcommand.

Always omit --update-only for this invitation contract. Do not run a second manual begin, poll loop, credential deletion, repair/reset, rename or config rewrite. Maintenance without an invitation remains a separate --update-only operation. The old explicit same-origin --update-only + invitation form remains compatible in this candidate, but prompts must not require the model to choose it from binding status.

An existing endpoint mismatch stops this ordinary command; this does not authorize rebinding or cross-origin credential transfer. The separately consented staging-to-production transition contract is unchanged and is not selected using a delivery failure.

## Authority and state machine

Gateway `sidewisp.status` is host/plugin/readiness evidence, NOT credential authority. A successful RPC reporting credential-rejected delivery is not a failed RPC or an enrollment blocker. Conversely, an actual denied/auth/transport failure stops; never use it to infer deletion.

After verified installation/upgrade/readiness and independent-manager setup, the helper calls the existing credential-status protocol itself (signed request over canonical HTTPS, expected schema and response semantics):

- active for the same installation -> signed reuse ONLY. Backend checks invitation owner/workspace, proof and freshness. No begin, credential replacement, rename or duplicate installation. Reuse waits for a new accepted healthy signal; cached health cannot complete the new invitation.
- protocol rejected -> existing guarded begin/poll. A fresh user invitation grants NEW account authorization, not resurrection of the deleted/revoked credential. The old local credential remains until valid new credential issuance; poll rechecks against replacing an active binding, then saves/ACKs normally.
- unconfigured (no local credential) -> ordinary begin/poll, including explicit account approval when required.
- unavailable, malformed response, generic/proxy 401, wrong active installation, network error or expired invitation -> blocked; no authorization/reset fallback.

A failed reuse, including wrong owner, NEVER falls back to begin. Rejected status does not prove the reason for rejection or grant permission to erase a binding. Existing user files, settings and native crons are retained. The old revoked credential stays unusable after enrollment.

## Observable results

- preparation_queued: admitted to an independent saved job, NOT connected. Original requestId/expiry and active profile survive queue/resume. Emit the helper-required initial handoff acknowledgement once, then end setup; do not repeat setup/begin.
- approval_pending: awaiting the existing explicit in-app account approval, no manual CLI begin.
- connection_pending: authorization/reuse is progressing; not a license to claim live connection success. The server's current completed/accepted-health state and native notifier receipt are the acceptance evidence.
- blocked + reason: stop, present the actual blocker. After invitation expiry require a genuinely fresh user-authenticated invitation, not an edited request.

The final Telegram notice remains behind accepted-health ACK and durable receipt deduplication. Source/fixture tests do not establish live model execution, Android activation or actual Telegram delivery.

## Verification

- Unchanged released89 signed localhost checks: 11/11 PASS. Ordinary deleted/revoked begin/poll already works; ordinary active stops with installation_already_connected; update-only rejected fails reuse. Thus a prompt-only fix works only with a trusted external branch selection, not this unified automatic contract.
- Candidate plugin CLI/guards/preparation: 59/59 PASS, 0 SKIP. Direct and queued ordinary commands exercise both signed branches and stop cases.
- Candidate signed local backend integration: 43/43 PASS, 0 SKIP. Includes the ordinary prepareConnection matrix plus real signature validation, fresh health, app completion selectors, retained files/config/native crons, credential ACK and one fixture notifier receipt.
- No real production binding, APK, backend deployment or official release changed. Live acceptance remains pending.

Targeted commands from the respective repository roots:

```sh
node --test test/invitation-continuation.test.js test/prepare-cli-result.test.js test/prepare-connection.test.js
NO_PROXY=127.0.0.1,localhost NODE_USE_ENV_PROXY=0 \
SIDEWISP_PLUGIN_REUSE_TEST_ROOT=/absolute/plugin/checkout \
SIDEWISP_APP_TEST_ROOT=/absolute/app/checkout \
node --test test/authorization-reuse.test.mjs
```
