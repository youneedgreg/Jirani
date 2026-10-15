import type { AddressInfo } from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { fromLocal } from '@jirani/core';
import { generate, PRESETS, replay } from 'ring-routine-sim';
import { createApp } from './app.ts';
import { demoHousehold } from './household.ts';
import { MemoryStore } from './store.ts';

/**
 * `pnpm demo`: the whole Jirani story end to end, no AWS and no Ring account needed.
 *
 * It starts the real server, replays 4 weeks of signed Ring-shaped events through
 * the real webhook (HMAC verified), and drives the real MCP server over Streamable
 * HTTP with an MCP client, the same way an Alexa+ experience would.
 */

const KEY = 'demo-hmac-key';
const TZ = 'America/New_York';
const local = (date: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number) as [number, number];
  return new Date(fromLocal(TZ, date, h * 60 + m)).toISOString();
};

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
};
const scene = (when: string, title: string) => console.log(`\n${c.bold(`── ${when} · ${title}`)}`);
const wrap = (s: string) => s.replace(/(.{1,96})(\s|$)/g, '$1\n     ').trimEnd();

async function main() {
  const store = new MemoryStore(demoHousehold(), {
    onDeliver: (m) => console.log(`  ${c.yellow(`✉ ${m.type} → ${m.to}`)}\n     ${wrap(m.message)}`),
  });
  const app = createApp(store, { hmacKey: KEY, demo: true });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const events = generate(PRESETS.demo!.options);
  const sendUntil = async (iso: string, from = '') => {
    const batch = events.filter((e) => e.at > from && e.at <= iso);
    const r = await replay(batch, { url: `${base}/ring/webhook`, hmacKey: KEY });
    return r;
  };
  const setClock = (iso: string) =>
    fetch(`${base}/demo/clock`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ now: iso }) });
  const evaluate = async () => (await (await fetch(`${base}/internal/evaluate`, { method: 'POST' })).json()) as any;

  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`));
  const client = new Client({ name: 'jirani-demo-voice-client', version: '0.1.0' });
  await client.connect(transport);
  const call = async (who: string, said: string, name: string, args: Record<string, unknown> = {}) => {
    console.log(`  ${c.cyan(`${who}:`)} "${said}"`);
    console.log(`  ${c.dim(`→ tools/call ${name} ${JSON.stringify(args)}`)}`);
    const res = (await client.callTool({ name, arguments: args })) as { content: { type: string; text?: string }[]; isError?: boolean };
    const text = res.content.map((p) => p.text ?? '').join(' ');
    console.log(`  ${c.green('Jirani:')} ${wrap(text)}`);
    return res;
  };

  console.log(c.bold('\nJirani demo: the neighbour who notices'));
  const tools = await client.listTools();
  console.log(c.dim(`MCP connected over Streamable HTTP (protocol ${transport.protocolVersion ?? 'negotiated'}), ${tools.tools.length} tools: ${tools.tools.map((t) => t.name).join(', ')}`));

  // 1. Learn the routine.
  let cursor = local('2026-10-15', '18:00');
  const learned = await sendUntil(cursor);
  await setClock(cursor);
  scene('Thu 15 Oct, 6:00pm', 'three and a half weeks of Ring events, HMAC-verified');
  console.log(`  ${learned.sent} signed webhook deliveries accepted, ${learned.failed} rejected.`);
  await call('Margaret', 'What do you know about my routine?', 'usual_routine');
  await call('Margaret', "Jirani, I'm at my sister's this weekend, back Sunday evening.", 'tell_jirani', {
    kind: 'away',
    text: "At my sister's this weekend",
    starts_at: '2026-10-17 08:00',
    ends_at: '2026-10-18 19:00',
    created_by: 'resident',
  });

  // 2. Sunday: silent house, no false alarm.
  const sunday = local('2026-10-18', '09:30');
  await sendUntil(sunday, cursor);
  cursor = sunday;
  await setClock(sunday);
  scene('Sun 18 Oct, 9:30am', 'the house is silent');
  const quiet = await evaluate();
  const state = (await (await fetch(`${base}/api/state`)).json()) as any;
  console.log(`  Alerts raised: ${quiet.actions.length}. Suppressed: ${state.suppressed.map((s: any) => `${s.summary} (${s.reason})`).join('; ') || 'none'}`);

  // 3. Monday: the ladder.
  const monday = local('2026-10-19', '10:05');
  await sendUntil(monday, cursor);
  cursor = monday;
  await setClock(monday);
  scene('Mon 19 Oct, 10:05am', 'no kitchen, no context: ask Margaret first');
  await evaluate();

  await setClock(local('2026-10-19', '10:26'));
  scene('10:26am', 'no answer from Margaret: ask the neighbour');
  await evaluate();

  await setClock(local('2026-10-19', '10:47'));
  scene('10:47am', 'Joe hasn\'t replied: tell Amina, with the evidence');
  await evaluate();
  await call('Amina', 'Alexa, why did Jirani alert me?', 'why_alert');
  await call('Amina', 'Show me the front door.', 'view_front_door');

  await setClock(local('2026-10-19', '10:52'));
  scene('10:52am', 'Joe knocks');
  await call('Joe', "She's in the garden, all good.", 'answer_checkin', {
    from: 'contact',
    contact_id: 'joe',
    outcome: 'ok',
    note: "She's in the garden, all good",
  });

  // 4. Slow drift.
  await setClock(local('2026-10-19', '11:00'));
  scene('11:00am', 'what a timer would never notice');
  await call('Amina', "Alexa, how's Mum this week?", 'weekly_report');
  await call('Amina', 'And today?', 'how_is_she');

  // 5. She stays in charge.
  scene('11:05am', 'Margaret stays in charge');
  await call('Margaret', 'Jirani, pause for two hours.', 'pause_monitoring', { hours: 2, reason: 'Gardening' });

  await client.close();
  server.close();
  console.log(c.dim('\nAll of the above ran through the real webhook, rhythm engine and MCP server.\n'));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
