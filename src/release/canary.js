const requiredEvidence = ["security", "privacy", "openclawE2e", "hermesE2e", "backup", "rollback"];

export function evaluateCanary(report) {
  const reviewed = Number(report.reviewedIncidents);
  const falsePositiveRate = reviewed > 0 ? Number(report.falsePositives) / reviewed : Infinity;
  const latencies = [...report.visibilityLatencySeconds].sort((a, b) => a - b);
  const p95Index = Math.max(0, Math.ceil(latencies.length * 0.95) - 1);
  const p95VisibilityLatencySeconds = latencies.length ? latencies[p95Index] : Infinity;
  const evidenceComplete = requiredEvidence.every((key) => report.evidence?.[key] === true);
  const privacyClean = report.forbiddenPayloadFindings === 0 && report.inferenceCalls === 0;
  const gates = {
    sample: reviewed >= 100,
    falsePositiveRate: falsePositiveRate < 0.01,
    visibilityLatency: p95VisibilityLatencySeconds <= 30,
    offlineDetection: report.offlineDetectionSeconds <= report.heartbeatIntervalSeconds * 3,
    resourceUsage: report.maxCpuPercent <= 2 && report.maxResidentMemoryMb <= 128,
    privacy: privacyClean,
    evidence: evidenceComplete,
  };
  const pass = Object.values(gates).every(Boolean);
  return { contract: "sidewisp.canary.v1", pass, gates, metrics: { reviewedIncidents: reviewed, falsePositiveRate, p95VisibilityLatencySeconds, offlineDetectionSeconds: report.offlineDetectionSeconds }, rollout: pass ? [5, 25, 100] : [], stopCriteria: Object.entries(gates).filter(([, value]) => !value).map(([key]) => key) };
}
