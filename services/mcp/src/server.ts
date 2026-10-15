import { createApp } from './app.ts';
import { demoHousehold } from './household.ts';
import { runEvaluation } from './runtime.ts';
import { MemoryStore } from './store.ts';

/**
 * Local Jirani server: Ring webhook + MCP server + dashboard API in one process.
 *
 *   pnpm mcp                      start empty, persist to data/state.json
 *   pnpm sim generate --preset demo --out data/demo.ndjson
 *   pnpm sim replay --file data/demo.ndjson --url http://localhost:3333/ring/webhook --key dev-only-change-me
 */
const port = Number(process.env.MCP_PORT ?? 3333);
const hmacKey = process.env.RING_HMAC_KEY ?? 'dev-only-change-me';
const store = new MemoryStore(demoHousehold(), {
  file: process.env.JIRANI_STATE_FILE ?? 'data/state.json',
  onDeliver: (m) => console.log(`\n>> ${m.type} to ${m.to}: ${m.message}`),
});
if (process.env.JIRANI_CLOCK) store.setClock(process.env.JIRANI_CLOCK);

const app = createApp(store, { hmacKey, demo: process.env.JIRANI_DEMO === '1', log: console.error });
app.listen(port, '127.0.0.1', () => {
  console.log(`Jirani running on http://localhost:${port}`);
  console.log(`  MCP (Streamable HTTP)  POST http://localhost:${port}/mcp`);
  console.log(`  Ring webhook           POST http://localhost:${port}/ring/webhook`);
  console.log(`  Dashboard API          GET  http://localhost:${port}/api/state`);
});

// Local stand-in for EventBridge Scheduler: evaluate once a minute.
setInterval(() => runEvaluation(store), 60_000).unref();
