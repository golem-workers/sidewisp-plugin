# Scheduled tasks (OpenClaw, plugin 0.2.34+)

Sidewisp workspace operators/admins can create, edit, pause, delete and manually run schedules through the authenticated app. The Tasks tab groups all installations; an agent's Schedule entry scopes the same functionality to that installation.

The collector polls its configured HTTPS backend every 15 seconds using installation HMAC authentication. The backend stores schedules and run history in PostgreSQL/SQLite, computes cron in the selected IANA timezone, and transactionally claims one run per installation. No app process or notification is needed to execute a task.

- `agentTurn`: an isolated OpenClaw session uses the configured agent's model, tools and policy. The final response is returned to Sidewisp, not sent to an external chat.
- `systemEvent`: enqueues an event into the configured agent's main session. Success means enqueueing, not that an AI has acted on the event.
- Missed intervals are coalesced into one catch-up after reconnection; no backlog storm. A one-shot's next occurrence is consumed once.
- Claimed runs are never automatically replayed. A lost claim response, a crash during launch, or unavailable outcome is a visible failure/unknown outcome, not a guaranteed exactly-once side effect.
- One run at a time per installation. A task gets at most ten minutes of execution before an abort is requested; the host's own timeout/policy still applies. An unavailable collector's pending outcome expires after twelve minutes.
- The local 0600 result outbox survives network errors/restarts. A new installation binding quarantines the previous binding's pending work.
- Pausing prevents future claims. Deletion removes schedule history; neither operation cancels work already accepted by the runtime.
- Model/tool failures remain failures. A configured working model credential is required. Runtime tools retain host admission and approval policy.

Monitoring itself remains zero-LLM. User-created AI tasks consume the agent's normal model resources. Hermes/command-hook runtimes do not execute this version of scheduled tasks. Existing OpenClaw installations must update the plugin to 0.2.34; updating the APK alone does not add collector execution support. No fleet-wide automatic rollout is enabled by this package.
