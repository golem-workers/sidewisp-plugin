export function validUpdateDirective(value) {
  return value?.schema === "sidewisp.plugin-update.v1"
    && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.targetVersion)
    && typeof value.targetSpec === "string"
    && /^git:github\.com\/golem-workers\/sidewisp-plugin@v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value.targetSpec)
    && Number.isInteger(value.restartDelaySeconds)
    && value.restartDelaySeconds >= 30
    && value.restartDelaySeconds <= 3600;
}
