import { createApp, type AppOptions } from './app.ts';
import { demoHousehold } from './household.ts';
import { runEvaluation } from './runtime.ts';
import { MemoryStore } from './store.ts';

/**
 * Local Jirani server: Ring webhook + MCP server + dashboard API in one process.
 * `pnpm mcp` starts it from @jirani/agent, which adds the agent at POST /ask.
 *
 *   pnpm mcp                      start empty, persist to data/state.json
 *   pnpm sim generate --preset demo --out data/demo.ndjson
 *   pnpm sim replay --file data/demo.ndjson --url http://localhost:3333/ring/webhook --key dev-only-change-me
 *
 *   JIRANI_ALLOWED_HOSTS=10.0.2.2 pnpm mcp               let an Android TV emulator in
 *   JIRANI_CORS_ORIGINS=http://localhost:8082 pnpm mcp    let the TV app's web build in
 */
export function startLocalServer(o: { makeAsk?: (mcpUrl: string) => AppOptions['ask'] } = {}) {
  const port = Number(process.env.MCP_PORT ?? 3333);
  const hmacKey = process.env.RING_HMAC_KEY ?? 'dev-only-change-me';
  const store = new MemoryStore(demoHousehold(), {
    file: process.env.JIRANI_STATE_FILE ?? 'data/state.json',
    onDeliver: (m) => console.log(`\n>> ${m.type} to ${m.to}: ${m.message}`),
  });
  if (process.env.JIRANI_CLOCK) store.setClock(process.env.JIRANI_CLOCK);

  // A TV emulator reaches this Mac under another name (Android's emulator uses 10.0.2.2),
  // and the TV app's web build runs on its own port. Both are opt-in, comma-separated.
  const list = (v: string | undefined) => (v ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const extraHosts = list(process.env.JIRANI_ALLOWED_HOSTS);
  const extraOrigins = list(process.env.JIRANI_CORS_ORIGINS);

  const ask = o.makeAsk?.(`http://127.0.0.1:${port}/mcp`);
  const app = createApp(store, {
    hmacKey,
    demo: process.env.JIRANI_DEMO === '1',
    log: console.error,
    ...(ask ? { ask } : {}),
    ...(extraHosts.length ? { allowedHosts: ['localhost', '127.0.0.1', '[::1]', ...extraHosts] } : {}),
    ...(extraOrigins.length ? { corsOrigins: ['http://localhost:3000', 'http://127.0.0.1:3000', ...extraOrigins] } : {}),
  });
  app.listen(port, '127.0.0.1', () => {
    console.log(`Jirani running on http://localhost:${port}`);
    console.log(`  MCP (Streamable HTTP)  POST http://localhost:${port}/mcp`);
    console.log(`  Ring webhook           POST http://localhost:${port}/ring/webhook`);
    console.log(`  Dashboard API          GET  http://localhost:${port}/api/state`);
    if (ask) console.log(`  Agent (Amazon Nova)    POST http://localhost:${port}/ask`);
  });

  // Local stand-in for EventBridge Scheduler: evaluate once a minute.
  setInterval(() => runEvaluation(store), 60_000).unref();
}
