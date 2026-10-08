# Sidewisp Plugin v0.2.48 (tester prerelease)

Fix the remaining stale-working state on installed, non-official OpenClaw plugins.
Use the existing read-only local session metadata collector rather than the
trusted-plugin-only Gateway interface. No transcripts or message content are read.
Only explicit persisted terminal status, exact run identity, and consistent
start/end metadata can close a current task. Waiting, active, absent, malformed,
and outdated metadata cannot produce success. Preserves task race fencing,
bindings, phone installation, and production configuration.
