import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fromLocal } from '@jirani/core';
import { generate, PRESETS, replay, sign, toEnvelope } from 'ring-routine-sim';
import { ScriptedModel } from '@jirani/agent/testing';
import { createTable, endpoint, functionUrl, useLocalAws } from './helpers.ts';

/**
 * The deployed Lambda handlers, end to end against DynamoDB Local: signed Ring
 * events into the webhook, the rhythm engine on its schedule, and an MCP client
 * talking to the API function. Mirrors the `pnpm demo` story.
 */
const KEY = 'lambda-test-hmac';
const TOKEN = 'lambda-test-token';
const TZ = 'America/New_York';
const local = (date: string, hhmm: string) => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return new Date(fromLocal(TZ, date, hh * 60 + mm)).toISOString();
};

describe.skipIf(!endpoint)('Lambda handlers (DynamoDB Local)', () => {
  const table = `jirani-lambda-${Date.now()}`;
  const servers: Server[] = [];
  let drop: () => Promise<unknown>;
  let webhookUrl: string;
  let apiUrl: string;
  let evaluate: () => Promise<{ actions: number }>;
  let client: Client;
  const events = generate(PRESETS.demo!.options);

  const api = (path: string, init: RequestInit = {}, token: string | null = TOKEN) =>
    fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...init.headers },
    });
  const setClock = (iso: string) => api('/demo/clock', { method: 'POST', body: JSON.stringify({ now: iso }) });
  const outbox = async () => ((await (await api('/api/state')).json()) as { outbox: { type: string; to: string }[] }).outbox;
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = (await client.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
    return { text: r.content.map((p) => p.text ?? '').join(' '), isError: r.isError };
  };

  beforeAll(async () => {
    useLocalAws();
    Object.assign(process.env, { TABLE_NAME: table, RING_HMAC_KEY: KEY, JIRANI_API_TOKEN: TOKEN, JIRANI_DEMO: '1' });
    drop = await createTable(table);
    const webhook = await functionUrl((await import('../src/lambda/webhook.ts')).handler);
    const apiFn = await functionUrl((await import('../src/lambda/api.ts')).handler);
    evaluate = (await import('../src/lambda/evaluate.ts')).handler;
    servers.push(webhook.server, apiFn.server);
    webhookUrl = `${webhook.url}/ring/webhook`;
    apiUrl = apiFn.url;
    process.env.JIRANI_API_URL = `${apiUrl}/`;

    const transport = new StreamableHTTPClientTransport(new URL(`${apiUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
    });
    client = new Client({ name: 'lambda-test', version: '0.0.0' });
    await client.connect(transport);
  }, 30_000);

  afterAll(async () => {
    await client?.close();
    for (const s of servers) s.close();
    await drop?.();
  });

  it('protects everything but /health with the bearer token', async () => {
    expect((await api('/health', {}, null)).status).toBe(200);
    expect((await api('/api/state', {}, null)).status).toBe(401);
    expect((await api('/api/state', {}, 'wrong')).status).toBe(401);
    const res = await fetch(`${apiUrl}/mcp`, { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(res.status).toBe(401);
  });

  it('serves MCP over Streamable HTTP with the caregiving tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['tell_jirani', 'answer_checkin', 'pause_monitoring', 'how_is_she', 'why_alert', 'weekly_report', 'view_front_door']),
    );
  });

  it('accepts signed Ring events, rejects bad signatures and dedupes retries', async () => {
    const thursday = local('2026-10-15', '18:00');
    const batch = events.filter((e) => e.at <= thursday);
    const first = await replay(batch, { url: webhookUrl, hmacKey: KEY });
    expect(first).toMatchObject({ sent: batch.length, failed: 0 });

    const forged = await replay(batch.slice(0, 1), { url: webhookUrl, hmacKey: 'not-the-key' });
    expect(forged.failed).toBe(1);

    // Ring retries deliveries: the same request_id is acknowledged but stored once.
    const body = JSON.stringify(toEnvelope(batch[0]!));
    const again = await fetch(webhookUrl, { method: 'POST', headers: { 'x-signature': sign(body, KEY) }, body });
    expect(await again.json()).toMatchObject({ ok: true, duplicate: true });

    expect((await fetch(webhookUrl)).status).toBe(405);
  }, 120_000);

  it('runs the story: context prevents a false alarm, then the ladder climbs and resolves', async () => {
    await setClock(local('2026-10-15', '18:00'));
    const told = await call('tell_jirani', {
      kind: 'away',
      text: "At my sister's this weekend",
      starts_at: '2026-10-17 08:00',
      ends_at: '2026-10-18 19:00',
    });
    expect(told.text).toContain("At my sister's this weekend");

    // Sunday 9:30: silent house, but she said she'd be away.
    const sunday = local('2026-10-18', '09:30');
    await replay(events.filter((e) => e.at > local('2026-10-15', '18:00') && e.at <= sunday), { url: webhookUrl, hmacKey: KEY });
    await setClock(sunday);
    await evaluate();
    expect((await outbox()).filter((m) => m.type !== 'log')).toHaveLength(0);

    // Monday 10:05: no activity, no context. Ask Margaret first.
    const monday = local('2026-10-19', '10:05');
    await replay(events.filter((e) => e.at > sunday && e.at <= monday), { url: webhookUrl, hmacKey: KEY });
    await setClock(monday);
    await evaluate();
    expect((await outbox()).map((m) => `${m.type}:${m.to}`)).toEqual(['checkin_resident:resident']);

    // Running the scheduler again at the same minute sends nothing twice.
    await evaluate();
    expect(await outbox()).toHaveLength(1);

    await setClock(local('2026-10-19', '10:26'));
    await evaluate();
    await setClock(local('2026-10-19', '10:47'));
    await evaluate();
    expect((await outbox()).map((m) => `${m.type}:${m.to}`)).toEqual([
      'checkin_resident:resident',
      'notify_contact:joe',
      'notify_contact:amina',
      'offer_live_view:family',
    ]);

    const why = await call('why_alert');
    expect(why.text).toContain('No morning activity');
    // The ladder in order, with names, times and how each person was reached.
    expect(why.text).toMatch(
      /At 10:05am Jirani asked Margaret by voice and on her TV.*At 10:26am Jirani messaged Joe \(her neighbour\)\..*so at 10:47am Jirani messaged Amina \(family\) and offered family a look at the front-door camera/,
    );
    expect(why.text).toContain('Still open: nobody has confirmed Margaret is OK yet.');

    await setClock(local('2026-10-19', '10:52'));
    const ok = await call('answer_checkin', { from: 'contact', contact_id: 'joe', outcome: 'ok', note: "She's in the garden" });
    expect(ok.text).toContain('marked Margaret as OK');
    expect((await outbox()).at(-1)).toMatchObject({ type: 'all_clear', to: 'amina' });

    const report = await call('weekly_report');
    expect(report.text).toMatch(/Night-time bathroom trips/);
  }, 120_000);

  it('answers through the Bedrock agent endpoint, which calls the MCP server with the token', async () => {
    const { createAgentHandler } = await import('../src/lambda/agent.ts');
    const model = new ScriptedModel([{ tool: 'why_alert' }, { text: 'Joe found her in the garden.' }]);
    const agent = await functionUrl(createAgentHandler(() => model));
    servers.push(agent.server);
    const askAgent = (body: unknown, token: string | null = TOKEN) =>
      fetch(`${agent.url}/ask`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
      });

    expect((await askAgent({ question: 'Why did you alert me?' }, null)).status).toBe(401);
    expect((await askAgent({ question: '' })).status).toBe(400);
    expect((await askAgent({ question: 'Hi', as: 'neighbour' })).status).toBe(400);

    const res = await askAgent({ question: 'Why did you alert me?', as: 'family' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: 'Joe found her in the garden.', toolCalls: [{ name: 'why_alert', input: {} }] });
    // The tool result came from the deployed API reading DynamoDB, and the clock is Jirani's demo clock.
    const toolResult = JSON.stringify(model.calls[1]!.messages.at(-1));
    expect(toolResult).toContain('No morning activity');
    expect(model.calls[0]!.system).toContain('Monday, October 19, 2026');
  });
});
