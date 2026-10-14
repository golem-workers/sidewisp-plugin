# Context occupancy

OpenClaw: read only session metadata from current SQLite `session_nodes` or legacy `sessions.json`. Select the most recently updated non-archived root session across local agents; never add session windows or use cumulative input/output. Export only numeric used/capacity/measured time and a closed selection enum through existing diagnostic snapshots. False freshness, absent/invalid capacity, future timestamps and observations older than 15 minutes are unknown. No prompts, conversation IDs, session names, model credentials or transcript bodies leave the host.

The display is a last observed snapshot, not a live tokenizer; diagnostic collection cadence remains user-configured. Hermes' inspected persisted usage totals do not establish current occupancy plus effective capacity, so existing Hermes agents remain explicitly unknown. Other runtimes likewise never get a fabricated percentage. This release does not claim universal context measurement.

Acceptance: read-only live OpenClaw metadata, SQLite and legacy fixtures, privacy normalization and current backend contract. No production promotion.
