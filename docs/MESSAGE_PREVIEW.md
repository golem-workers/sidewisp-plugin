# Optional agent message preview

`messagePreview?: string` is an additive top-level field in `sidewisp.telemetry.v1`
and each `/v1/activity` item. The existing v1 envelope and required fields do not
change. No new event, status transition, work ID, notification, cron behavior,
credential or connection behavior is introduced. No database migration is needed.

Only outgoing `message.delivered`, confirmed source-message `turn.progress`, and
the existing final-reply `turn.completed` boundary can contain a preview. Input messages,
errors, tool results, attachments, prompts and transcript recovery never supply
one. Unsupported runtimes and old collectors continue to omit the field.

The OpenClaw adapter reads only the official outbound `content`, final reply
`text`, or confirmed current-source message-send `message` scalar. It never
rewrites, cancels, claims or stores the original payload. Reading/cleaning optional
text cannot prevent the existing lifecycle observation.

Whitespace is collapsed, invisible formatting removed, and the full bounded
scalar scanned BEFORE truncation. Credential markers, common opaque secrets,
contact numbers, email addresses, links, file paths and fenced code cause the
whole preview to be omitted, not partially redacted. Empty, non-string,
unreadable or oversized (>16 KiB) inputs are omitted too. Maximum output is 160
UTF-16 code units (also <=160 Unicode characters), including a truncation ellipsis;
surrogate pairs are never split. The queue stores only this sanitized excerpt,
never a separate full-message field. This conservative detector is not semantic
classification of arbitrary personal prose; collectors must not deliberately
label private prose as a preview. Raw hooks remain closed except this field.

The API repeats the same policy before persistence and at the public output
boundary. Invalid optional previews are removed without rejecting valid status
or heartbeat events. SQLite and PostgreSQL select only the preview scalar, not
raw payloads. The field is **absent**, not null or empty, when unavailable.
Preview text is excluded from fingerprints, incidents and push payloads.

Deploy the API field support before activating the new plugin. Older apps ignore
this unknown optional response field; their existing event and work-state
projection remains identical. Old apps are not required to render a third line.
No APK/OTA update is needed for the server/plugin change.

Verification: plugin preview corpus + actual hook tests, API contract and output
boundary tests, signed HTTP round trip through the plugin SQLite spool, identical
API results with/without the excerpt for the legacy app work-state projection,
and real PostgreSQL activity selection when an isolated test database is supplied.

## Bounded-content threat model

The new boundary reads one outbound text scalar inside the host-owned observer,
then exports only the filtered prefix. Trust stops at the runtime hook and again
at collector authentication: neither a runtime payload nor a signed collector
is trusted to bypass privacy checks. No content is added to recovery logs,
support diagnostics, signatures/correlation IDs, notification builders or
incident evidence. A failed scalar read, ambiguous sensitivity marker, malformed
Unicode or excessive size omits preview while retaining the original event.
Tests cover invisible-marker obfuscation, compatibility normalization, a secret
after the cutoff, invalid legacy database rows and cross-tenant reads.
