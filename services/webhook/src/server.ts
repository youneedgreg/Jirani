import { createServer } from 'node:http';
import { handleRingWebhook } from './handler.ts';

/**
 * Standalone local webhook receiver (prints events). The full local stack mounts
 * the same handler inside the MCP server: run `pnpm mcp` or `pnpm demo` instead.
 */
const port = Number(process.env.WEBHOOK_PORT ?? 8787);
const hmacKey = process.env.RING_HMAC_KEY ?? 'dev-only-change-me';
const seen = new Set<string>();

createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/ring/webhook') {
    res.writeHead(404).end();
    return;
  }
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const result = await handleRingWebhook(Buffer.concat(chunks).toString('utf8'), req.headers, {
    hmacKey,
    remember: (id) => (seen.has(id) ? false : (seen.add(id), true)),
    save: (e) => console.log(`${e.at}  ${e.type.padEnd(22)} ${e.deviceId}${e.subType ? ` (${e.subType})` : ''}`),
    log: console.error,
  });
  res.writeHead(result.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(result.body));
}).listen(port, () => console.log(`Ring webhook listening on http://localhost:${port}/ring/webhook`));
