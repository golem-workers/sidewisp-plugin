import type { GlobalHookRunnerRegistry } from "./hook-registry.types.js";
import { isPluginRegistryRetired } from "./registry-lifecycle.js";
import type { PluginRegistry } from "./registry-types.js";

// A scoped registration can describe the same installed plugin without starting
// its service. Passive telemetry must reach that service's live state, not a
// registration-only closure. Never add a hook absent from the caller's registry.
const ownersKey = Symbol.for("openclaw.plugins.live-service-hook-owners");
type Owner = { pluginId: string; registry: PluginRegistry };
const globalOwners = globalThis as typeof globalThis & { [ownersKey]?: Map<object, Owner> };
const owners = (globalOwners[ownersKey] ??= new Map<object, Owner>());
const observedHooks = new Set([
  "before_dispatch",
  "reply_dispatch",
  "message_received",
  "message_sent",
  "after_tool_call",
]);

export function retainServiceHookOwner(owner: object, registry: PluginRegistry, pluginId: string) {
  owners.set(owner, { registry, pluginId });
}
export function releaseServiceHookOwner(owner: object) {
  owners.delete(owner);
}
export function resolveServiceOwnedHooks<T extends GlobalHookRunnerRegistry>(registry: T): T {
  const live = new Map<string, Set<PluginRegistry>>();
  for (const { pluginId, registry: owned } of owners.values()) {
    if (isPluginRegistryRetired(owned)) continue;
    const list = live.get(pluginId) ?? new Set<PluginRegistry>();
    list.add(owned);
    live.set(pluginId, list);
  }
  let changed = false;
  const typedHooks = registry.typedHooks.map((hook) => {
    if (!observedHooks.has(hook.hookName)) return hook;
    const candidates = live.get(hook.pluginId);
    if (candidates?.size !== 1) return hook;
    const owned = candidates.values().next().value!;
    if (Object.is(owned, registry)) return hook;
    const scopedRecord = registry.plugins.find((p) => p.id === hook.pluginId);
    const ownerRecord = owned.plugins.find((p) => p.id === hook.pluginId);
    if (
      !scopedRecord ||
      !ownerRecord ||
      !("source" in scopedRecord) ||
      scopedRecord.source !== ownerRecord.source
    )
      return hook;
    const sameKind = (h: typeof hook) =>
      h.pluginId === hook.pluginId && h.hookName === hook.hookName && h.source === hook.source;
    const scoped = registry.typedHooks.filter(sameKind);
    const matches = owned.typedHooks.filter(sameKind);
    // Preserve each registration and its order, including multiple observers.
    if (matches.length !== scoped.length) return hook;
    const replacement = matches[scoped.indexOf(hook)];
    if (!replacement) return hook;
    changed = true;
    return { ...hook, handler: replacement.handler };
  });
  return changed ? { ...registry, typedHooks } : registry;
}
