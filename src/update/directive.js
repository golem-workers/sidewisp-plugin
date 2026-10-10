function parseVersion(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/.exec(value ?? "");
  if (!match) return null;
  const prerelease = match[4]?.split(".") ?? null;
  if (prerelease?.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) return null;
  return {
    core: match.slice(1, 4).map((part) => BigInt(part)),
    prerelease,
  };
}

function targetSpecVersion(value) {
  const match = /^git:github\.com\/golem-workers\/sidewisp-plugin@v?(.+)$/.exec(value ?? "");
  return match && parseVersion(match[1]) ? match[1] : null;
}

export function validUpdateDirective(value) {
  return value?.schema === "sidewisp.plugin-update.v1"
    && typeof value.targetVersion === "string"
    && parseVersion(value.targetVersion) !== null
    && targetSpecVersion(value.targetSpec) === value.targetVersion
    && Number.isInteger(value.restartDelaySeconds)
    && value.restartDelaySeconds >= 30
    && value.restartDelaySeconds <= 3600;
}

function comparePrerelease(left, right) {
  if (left === null || right === null) {
    if (left === right) return 0;
    return left === null ? 1 : -1;
  }
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;
    const leftNumeric = /^\d+$/.test(left[index]);
    const rightNumeric = /^\d+$/.test(right[index]);
    if (leftNumeric && rightNumeric) return BigInt(left[index]) > BigInt(right[index]) ? 1 : -1;
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[index] > right[index] ? 1 : -1;
  }
  return 0;
}

export function isNewerVersion(candidate, current) {
  const next = parseVersion(candidate);
  const installed = parseVersion(current);
  if (!next || !installed) return false;
  for (let index = 0; index < next.core.length; index += 1) {
    if (next.core[index] === installed.core[index]) continue;
    return next.core[index] > installed.core[index];
  }
  return comparePrerelease(next.prerelease, installed.prerelease) > 0;
}
