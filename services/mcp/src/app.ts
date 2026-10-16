import express, { type Request, type Response, type NextFunction } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  hostHeaderValidation,
  localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { handleRingWebhook } from '@jirani/webhook';
import { buildMcpServer } from './tools.ts';
import { dashboardReport, dashboardState, evaluateNow } from './api.ts';
import type { Store } from './store.ts';

export interface AppOptions {
  hmacKey: string;
  /** Hosts allowed in the Host header. Defaults to localhost only (DNS-rebinding protection). */
  allowedHosts?: string[];
  /** Browser origins allowed to call /mcp and /api (the voice client and dashboard). */
  corsOrigins?: string[];
  /** Enables /demo/clock for time travel in demos and tests. */
  demo?: boolean;
  log?: (msg: string) => void;
}

export function createApp(store: Store, opts: AppOptions) {
  const app = express();
  app.use(opts.allowedHosts ? hostHeaderValidation(opts.allowedHosts) : localhostHostValidation());

  const origins = new Set(opts.corsOrigins ?? ['http://localhost:3000', 'http://127.0.0.1:3000']);
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && origins.has(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID');
      res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id, Mcp-Protocol-Version');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    }
    if (req.method === 'OPTIONS') return void res.sendStatus(204);
    next();
  });

  // Ring webhook: raw body, because the HMAC is computed over the exact bytes.
  app.post('/ring/webhook', express.text({ type: '*/*', limit: '256kb' }), async (req, res) => {
    const result = await handleRingWebhook(typeof req.body === 'string' ? req.body : '', req.headers, {
      hmacKey: opts.hmacKey,
      remember: (id) => store.remember(id),
      save: (e) => store.addEvent(e),
      ...(opts.log ? { log: opts.log } : {}),
    });
    res.status(result.status).json(result.body);
  });

  // MCP over Streamable HTTP, stateless: a fresh server + transport per request.
  app.post('/mcp', express.json({ limit: '1mb' }), async (req, res) => {
    const server = buildMcpServer(store);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      opts.log?.(`MCP error: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
      }
    }
  });
  const notAllowed = (_req: Request, res: Response) =>
    void res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server).' }, id: null });
  app.get('/mcp', notAllowed);
  app.delete('/mcp', notAllowed);

  // Read API for the family dashboard.
  app.get('/api/state', (_req, res) => void res.json(dashboardState(store)));
  app.get('/api/report', (_req, res) => void res.json(dashboardReport(store)));

  // The runtime trigger. EventBridge Scheduler calls the Lambda equivalent.
  app.post('/internal/evaluate', (_req, res) => void res.json(evaluateNow(store)));

  if (opts.demo) {
    app.post('/demo/clock', express.json(), (req, res) => {
      store.setClock(req.body?.now ?? null);
      res.json({ now: store.now() });
    });
  }

  app.get('/health', (_req, res) => void res.json({ ok: true, now: store.now() }));
  return app;
}
