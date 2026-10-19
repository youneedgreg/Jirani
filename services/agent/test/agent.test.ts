import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromLocal } from '@jirani/core';
import { demoHousehold, MemoryStore } from '@jirani/mcp';
import { createApp } from '@jirani/mcp/app';
import { generate, PRESETS, replay } from 'ring-routine-sim';
import { ask, bedrockModel, DEFAULT_BEDROCK_MODEL_ID, DEFAULT_BEDROCK_REGION, fetchClock, systemPrompt, TOOLS, upcomingDays } from '../src/index.ts';
import { lastToolResults, ScriptedModel } from '../src/testing.ts';

/**
 * The real Strands agent loop against the real MCP server, with a scripted model
 * standing in for Bedrock. It checks the wiring (tools offered, calls made,
 * results returned, prompt rules), not the model's judgement.
 */
const KEY = 'agent-test-key';
const TZ = 'America/New_York';
const thursday = new Date(fromLocal(TZ, '2026-10-15', 18 * 60)).toISOString();

let server: Server;
let mcpUrl: string;
const store = new MemoryStore(demoHousehold());

beforeAll(async () => {
  server = createApp(store, { hmacKey: KEY, demo: true }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  mcpUrl = `${base}/mcp`;
  const events = generate(PRESETS.demo!.options).filter((e) => e.at <= thursday);
  await replay(events, { url: `${base}/ring/webhook`, hmacKey: KEY });
  store.setClock(thursday);
}, 60_000);
afterAll(() => server.close());

const opts = async (model: ScriptedModel, speaker: 'resident' | 'family') => ({
  mcpUrl,
  speaker,
  model,
  ...(await fetchClock(mcpUrl)),
});

describe('Jirani agent (Strands + MCP)', () => {
  it('reads the clock and time zone from Jirani', async () => {
    expect(await fetchClock(mcpUrl)).toEqual({ now: thursday, timeZone: TZ, residentName: 'Margaret' });
  });

  it('answers family questions from tool results, offering only family tools', async () => {
    const model = new ScriptedModel([{ tool: 'usual_routine' }, { text: 'She is usually up around 7:15.' }]);
    const r = await ask('What is Mum’s usual routine?', await opts(model, 'family'));

    expect(model.calls[0]!.tools).toEqual([...TOOLS.family].sort());
    expect(r.toolCalls).toEqual([{ name: 'usual_routine', input: {} }]);
    const [result] = lastToolResults(model);
    expect(result).toMatchObject({ status: 'success' });
    expect(result!.text).toMatch(/Learned from \d+ days/);
    expect(r.answer).toBe('She is usually up around 7:15.');
  });

  it('acts for Margaret through MCP: her plan is saved in Jirani', async () => {
    const model = new ScriptedModel([
      {
        tool: 'tell_jirani',
        input: { kind: 'away', text: "At my sister's Saturday", starts_at: '2026-10-17 08:00', ends_at: '2026-10-17 20:00', created_by: 'resident' },
      },
      { text: "Got it, enjoy your sister's." },
    ]);
    const r = await ask("I'm at my sister's on Saturday", await opts(model, 'resident'));

    expect(model.calls[0]!.tools).toEqual([...TOOLS.resident].sort());
    expect(r.toolCalls.map((c) => c.name)).toEqual(['tell_jirani']);
    expect(store.state().contexts.at(-1)).toMatchObject({ kind: 'away', text: "At my sister's Saturday", createdBy: 'resident' });
  });

  it("can't use a tool outside the speaker's set, even if the model tries", async () => {
    const model = new ScriptedModel([{ tool: 'view_front_door' }, { text: 'I can’t do that.' }]);
    await ask('Show me the front door', await opts(model, 'resident'));
    const [result] = lastToolResults(model);
    expect(result?.status).toBe('error');
  });

  it('gives the model the rules and the household’s local time', () => {
    const p = systemPrompt({ speaker: 'family', residentName: 'Margaret', now: thursday, timeZone: TZ });
    expect(p).toContain('Thursday, October 15, 2026');
    expect(p).toContain('6:00 PM');
    expect(p).toMatch(/Only state facts that a tool returned/);
    expect(p).toMatch(/Never diagnose/);
    expect(p).toMatch(/never contacts emergency services/);
    expect(p).toMatch(/keep every step why_alert lists, in its order/);
    expect(p).toMatch(/up to four when you explain an alert/);
    // Rules from the 19 Oct Nova round: no guessing from silence, plans read back one by one.
    expect(p).toMatch(/never guess from it where she is or what she is doing/);
    expect(p).toMatch(/give each plan on its own, with its start and its end exactly as the tool states them/);
    expect(p).toMatch(/say "from Saturday", never a time at night/);
    expect(p).toMatch(/how_is_she reports what the sensors recorded, not where she is/);
    expect(p).toMatch(/Explain an alert in four sentences at most/);
    expect(systemPrompt({ speaker: 'resident', residentName: 'Margaret', now: thursday, timeZone: TZ })).toMatch(
      /tell her, as Jirani, what the tool confirmed.*You are never speaking as her/,
    );
    // The week spelled out, so "this weekend" can't land on Friday.
    expect(p).toContain('Thursday 2026-10-15 (today), Friday 2026-10-16 (tomorrow), Saturday 2026-10-17, Sunday 2026-10-18');
  });

  it('answers in Spanish only when asked, summarising tools and keeping her own words in plans', async () => {
    const base = { speaker: 'resident', residentName: 'Margaret', now: thursday, timeZone: TZ } as const;
    expect(systemPrompt(base)).not.toMatch(/Spanish/);
    expect(systemPrompt({ ...base, lang: 'en' })).not.toMatch(/Spanish/);
    const es = systemPrompt({ ...base, lang: 'es' });
    expect(es).toMatch(/Answer in Spanish/);
    expect(es).toMatch(/keep every name, day, date and time exact/);
    expect(es).toMatch(/within the same sentence limits/);
    expect(es).toMatch(/summarise them in Spanish rather than translating them word for word/);
    expect(es).toMatch(/Save plan text in her own words/);

    // The rule reaches the model through ask().
    const model = new ScriptedModel([{ text: 'Hola Margaret.' }]);
    await ask('¿Cómo estoy?', { ...(await opts(model, 'resident')), lang: 'es' });
    expect(model.calls[0]!.system).toMatch(/Answer in Spanish/);
  });

  it('lists eight consecutive days, even across the end of daylight saving', () => {
    // 11:30pm on Saturday 31 October 2026 in New York; clocks go back on 1 November.
    const days = upcomingDays('2026-11-01T03:30:00.000Z', TZ);
    expect(days).toEqual([
      'Saturday 2026-10-31 (today)',
      'Sunday 2026-11-01 (tomorrow)',
      'Monday 2026-11-02',
      'Tuesday 2026-11-03',
      'Wednesday 2026-11-04',
      'Thursday 2026-11-05',
      'Friday 2026-11-06',
      'Saturday 2026-11-07',
    ]);
  });

  it('fails loudly when the MCP server refuses it, instead of answering without tools', async () => {
    const refusing = createServer((_req, res) => res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}'));
    refusing.listen(0, '127.0.0.1');
    await new Promise((r) => refusing.once('listening', r));
    const url = `http://127.0.0.1:${(refusing.address() as AddressInfo).port}/mcp`;
    const model = new ScriptedModel([{ text: 'should never be asked' }]);
    await expect(
      ask('How is she?', { mcpUrl: url, apiToken: 'wrong', speaker: 'family', residentName: 'Margaret', now: thursday, timeZone: TZ, model }),
    ).rejects.toThrow();
    expect(model.calls).toHaveLength(0);
    refusing.close();
  });

  it('defaults to Amazon Nova 2 Lite through the EU inference profile in eu-north-1', () => {
    expect(DEFAULT_BEDROCK_MODEL_ID).toBe('eu.amazon.nova-2-lite-v1:0');
    expect(DEFAULT_BEDROCK_REGION).toBe('eu-north-1');
    const config = bedrockModel().getConfig();
    expect(config.modelId).toBe('eu.amazon.nova-2-lite-v1:0');
    // temperature 0 keeps Nova's answers close to the tool facts.
    expect(config.temperature).toBe(0);
    expect(config.topP).toBeUndefined();
  });
});
