# OpenClaw diagnostic probes

Wires the existing seven-section diagnostics contract to read-only local probes.
No shell execution, network scan, Golem API, arbitrary logs or model calls.

- runtime: current process RSS/heap and host RAM; Linux MemAvailable/swap where available.
- configuration: config readability and Sidewisp enrollment boolean.
- connectivity: Sidewisp uploader's closed status and bounded transport-code allowlist;
  does not claim to diagnose every provider or Gateway connection.
- storage: free space/inodes of the state volume; existing spool health/capacity.
- scheduler: bounded optional standard OpenClaw cron/jobs.json inventory/last-failure count.
  Absent store means unsupported. No job names, payloads or schedules exported.
- integrations: configured/disabled plugin counts, not external integration health.
- updates: closed attempt-state enum and age, never reasons or raw updater logs.

Native host measurements are tested on Linux. Unsupported/failed probes stay
explicit; they do not become healthy. An old rollback does not imply a current
outage. Collection runs inside the existing bounded diagnostics interval and
retains the existing sanitization contract. No release version bump or rollout.
