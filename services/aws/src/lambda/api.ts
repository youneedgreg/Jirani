import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { buildMcpServer, clockInfo, dashboardReport, dashboardState, evaluateNow } from '@jirani/mcp';
import { withStore, type DynamoStore } from '../dynamo-store.ts';
import { apiToken, bearerMatches, documentClient, household, requireEnv } from '../config.ts';

/**
 * Jirani API (Lambda Function URL): the MCP server for Alexa+-style clients plus
 * the family dashboard API. Every route except /health needs
 * `Authorization: Bearer <token>` (the token lives in Secrets Manager).
 *
 *   POST /mcp                MCP, spec 2025-11-25, stateless Streamable HTTP (JSON responses)
 *   GET  /api/state          dashboard: today, open alerts, outbox
 *   GET  /api/report         weekly drift report
 *   GET  /api/now            Jirani's clock and time zone (for the agent)
 *   POST /internal/evaluate  run the rhythm engine + ladder now
 *   POST /demo/clock         {"now": ISO | null}; only when JIRANI_DEMO=1
 */
const db = documentClient();
const table = requireEnv('TABLE_NAME');
const demo = process.env.JIRANI_DEMO === '1';

const json = (statusCode: number, body: unknown): LambdaFunctionURLResult => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

const run = <T>(fn: (store: DynamoStore) => T | Promise<T>) => withStore(db, table, household(), fn);

function rawBody(event: LambdaFunctionURLEvent): string | undefined {
  if (!event.body) return undefined;
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

async function handleMcp(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const body = rawBody(event);
  const url = `https://${event.requestContext.domainName}${event.rawPath}${event.rawQueryString ? `?${event.rawQueryString}` : ''}`;
  const headers = new Headers();
  for (const [k, v] of Object.entries(event.headers)) if (v !== undefined) headers.set(k, v);

  // A fresh server and transport per attempt: stateless, and safe to re-run on a store conflict.
  return run(async (store) => {
    const server = buildMcpServer(store);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(new Request(url, { method: 'POST', headers, ...(body ? { body } : {}) }));
      const out: Record<string, string> = {};
      res.headers.forEach((v, k) => (out[k] = v));
      return { statusCode: res.status, headers: out, body: await res.text() };
    } finally {
      await server.close();
    }
  });
}

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (method === 'GET' && path === '/health') return json(200, { ok: true });
  if (!bearerMatches(event.headers.authorization, await apiToken())) {
    return {
      statusCode: 401,
      headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer' },
      body: JSON.stringify({ error: 'unauthorized' }),
    };
  }

  try {
    if (path === '/mcp') {
      if (method === 'POST') return await handleMcp(event);
      return json(405, { jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed (stateless server).' }, id: null });
    }
    if (method === 'GET' && path === '/api/state') return json(200, await run(dashboardState));
    if (method === 'GET' && path === '/api/report') return json(200, await run(dashboardReport));
    if (method === 'GET' && path === '/api/now') return json(200, await run(clockInfo));
    if (method === 'POST' && path === '/internal/evaluate') return json(200, await run(evaluateNow));
    if (demo && method === 'POST' && path === '/demo/clock') {
      const now = (JSON.parse(rawBody(event) ?? '{}') as { now?: string | null }).now ?? null;
      if (now !== null && Number.isNaN(Date.parse(now))) return json(400, { error: 'now must be an ISO time or null' });
      const set = await run((s) => {
        s.setClock(now);
        return { now: s.now() };
      });
      return json(200, set);
    }
    return json(404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    return json(500, { error: 'internal error' });
  }
}
