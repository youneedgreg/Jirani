import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { generate, PRESETS, replay, sign, toEnvelope } from 'ring-routine-sim';
import { createApp } from '../src/app.ts';
import { demoHousehold } from '../src/household.ts';
import { MemoryStore } from '../src/store.ts';

const KEY = 'test-key';
let server: Server;
let base: string;
const store = new MemoryStore(demoHousehold());

beforeAll(async () => {
  server = createApp(store, { hmacKey: KEY, demo: true }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe('Ring webhook', () => {
  it('rejects a bad signature with 401', async () => {
    const [ev] = generate({ start: '2026-09-21', days: 1, seed: 1 });
    const body = JSON.stringify(toEnvelope(ev!));
    const res = await fetch(`${base}/ring/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-signature': sign(body, 'wrong-key') },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('accepts signed events and ignores duplicates by request_id', async () => {
    const [ev] = generate({ start: '2026-09-21', days: 1, seed: 2 });
    const body = JSON.stringify(toEnvelope(ev!));
    const send = () =>
      fetch(`${base}/ring/webhook`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-signature': sign(body, KEY) },
        body,
      }).then((r) => r.json());
    expect(await send()).toMatchObject({ ok: true });
    expect(await send()).toMatchObject({ ok: true, duplicate: true });
  });
});

describe('MCP server over Streamable HTTP', () => {
  it('negotiates 2025-11-25 and answers caregiving tools', async () => {
    const until = '2026-10-19T14:05:00.000Z';
    const events = generate({ ...PRESETS['missed-morning']!.options, until });
    const r = await replay(events, { url: `${base}/ring/webhook`, hmacKey: KEY });
    expect(r.failed).toBe(0);
    store.setClock(until);

    const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(transport);
    expect(transport.protocolVersion).toBe('2025-11-25');

    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(['tell_jirani', 'answer_checkin', 'pause_monitoring', 'how_is_she', 'why_alert', 'weekly_report', 'view_front_door']),
    );

    const how = (await client.callTool({ name: 'how_is_she', arguments: {} })) as any;
    expect(how.content[0].text).toMatch(/No morning activity yet/);
    expect(store.outbox().some((m) => m.type === 'checkin_resident')).toBe(true);

    const ok = (await client.callTool({
      name: 'answer_checkin',
      arguments: { from: 'resident', outcome: 'ok', note: 'Slept in' },
    })) as any;
    expect(ok.content[0].text).toMatch(/Glad you're alright/);
    expect(store.state().escalations.every((e) => e.status !== 'open')).toBe(true);

    const camera = (await client.callTool({ name: 'view_front_door', arguments: {} })) as any;
    expect(camera.structuredContent.allowed).toBe(false);
    await client.close();
  });

  it('reads plans back with weekdays, and lets a wrong one be listed and cancelled', async () => {
    store.setClock('2026-10-15T22:00:00.000Z'); // Thursday 6pm in New York
    const client = new Client({ name: 'test', version: '0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    const text = async (name: string, args: Record<string, unknown> = {}) =>
      ((await client.callTool({ name, arguments: args })) as any).content[0].text as string;

    const saved = await text('tell_jirani', { kind: 'away', text: 'This weekend', starts_at: '2026-10-16 00:00', ends_at: '2026-10-17 18:00' });
    expect(saved).toContain('from the start of Friday 16 October to Saturday 17 October, 6:00pm');

    const listed = await text('list_plans');
    const id = listed.match(/\[(ctx-[^\]]+)\] "This weekend"/)?.[1];
    expect(id).toBeDefined();

    expect(await text('cancel_plan', { id })).toMatch(/^Cancelled "This weekend" \(away\), from the start of Friday 16 October/);
    expect(store.state().contexts.some((c) => c.id === id)).toBe(false);
    expect(await text('list_plans')).toBe('There are no current or upcoming plans on file.');

    const again = (await client.callTool({ name: 'cancel_plan', arguments: { id } })) as any;
    expect(again.isError).toBe(true);
    await client.close();
  });
});
