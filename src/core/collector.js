export function createCollector({ adapter, emit = async () => {} }) {
  let startedAt = null;
  let running = false;
  const context = Object.freeze({ emit });

  return Object.freeze({
    async start() {
      if (running) return;
      await adapter.start(context);
      running = true;
      startedAt = new Date().toISOString();
    },
    async stop() {
      if (!running) return;
      await adapter.stop();
      running = false;
      startedAt = null;
    },
    async recover(cursor = null) {
      return adapter.recover(cursor, context);
    },
    async status() {
      return {
        running,
        startedAt,
        adapter: adapter.id,
        runtime: adapter.runtimeKind,
        capabilities: adapter.capabilities,
        health: await adapter.healthSnapshot(context),
      };
    },
  });
}
