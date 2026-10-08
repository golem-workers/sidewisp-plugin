# Sidewisp Plugin v0.2.49

## Managed updater failure evidence

- Preserve the original bounded failure code through rollback and in the terminal manager report.
- Never forward arbitrary exception text, command output, paths, credentials or provider responses.
- Regress the exact helper process: unhealthy target rolls back once, preserves source version and binding, retains TARGET_COLLECTOR_UNHEALTHY and does not restart Gateway.
- This release does not retry failed revisions or automatically clear fleet pauses. Existing managers need a verified private-copy upgrade before gaining the repair.
- No APK or OTA change is required.

# Sidewisp Plugin v0.2.48 (tester prerelease)

Fix the remaining stale-working state on installed, non-official OpenClaw plugins.
Use the existing read-only local session metadata collector rather than the
trusted-plugin-only Gateway interface. No transcripts or message content are read.
Only explicit persisted terminal status, exact run identity, and consistent
start/end metadata can close a current task. Waiting, active, absent, malformed,
and outdated metadata cannot produce success. Preserves task race fencing,
bindings, phone installation, and production configuration.
