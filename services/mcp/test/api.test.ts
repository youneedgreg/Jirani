import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fromLocal } from '@jirani/core';
import { generate, PRESETS, replay } from 'ring-routine-sim';
import { createApp } from '../src/app.ts';
import { demoHousehold } from '../src/household.ts';
import { MemoryStore } from '../src/store.ts';

/** The read API the family dashboard's timeline and rhythm chart use. */

const KEY = 'api-test-key';
const h = demoHousehold();
const local = (date: string, hhmm: string) => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return new Date(fromLocal(h.timeZone, date, hh * 60 + mm)).toISOString();
};
const store = new MemoryStore(h);
let server: Server;
let base: string;
const get = async (path: string) => (await fetch(`${base}${path}`)).json() as Promise<any>;

beforeAll(async () => {
  server = createApp(store, { hmacKey: KEY, demo: true }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const events = generate(PRESETS.demo!.options).filter((e) => e.at <= local('2026-10-19', '10:05'));
  expect((await replay(events, { url: `${base}/ring/webhook`, hmacKey: KEY })).failed).toBe(0);
  store.addContext({
    id: 'ctx-weekend',
    kind: 'away',
    text: "At my sister's this weekend",
    startsAt: local('2026-10-17', '08:00'),
    endsAt: local('2026-10-18', '19:00'),
    createdBy: 'resident',
    createdAt: local('2026-10-15', '18:00'),
  });
});
afterAll(() => server.close());

describe('GET /api/timeline', () => {
  it("gives Thursday's events in plain words, oldest first", async () => {
    store.setClock(local('2026-10-15', '18:00'));
    const t = await get('/api/timeline');
    expect(t.date).toBe('2026-10-15');
    expect(t.items.length).toBeGreaterThan(3);
    expect(t.items[0]).toMatchObject({ time: expect.stringMatching(/am$/), text: expect.stringMatching(/opened|pressed|front door/) });
  });

  it('is empty on the silent Monday morning', async () => {
    store.setClock(local('2026-10-19', '10:47'));
    expect((await get('/api/timeline')).items).toEqual([]);
  });
});

describe('GET /api/days', () => {
  it('gives one row per day before today, with away and counted marked', async () => {
    store.setClock(local('2026-10-19', '10:47'));
    const d = await get('/api/days');
    expect(d.timeZone).toBe('America/New_York');
    expect(d.days.length).toBeLessThanOrEqual(28);
    expect(d.days.at(-1).date).toBe('2026-10-18');
    const sat = d.days.find((x: any) => x.date === '2026-10-17');
    const sun = d.days.find((x: any) => x.date === '2026-10-18');
    expect(sat).toMatchObject({ away: true, counted: false });
    // Back home at 5:30pm: no wake time at home that day, so the report leaves it out.
    expect(sun).toMatchObject({ away: true, counted: false });
    expect(sun.firstActivity).toBeGreaterThan(12 * 60);
    const thu = d.days.find((x: any) => x.date === '2026-10-15');
    expect(thu).toMatchObject({ away: false, counted: true });
    expect(typeof thu.nightBathroom).toBe('number');
  });

  it('ignores events after the demo clock', async () => {
    store.setClock(local('2026-10-10', '12:00'));
    const d = await get('/api/days');
    expect(d.days.at(-1).date).toBe('2026-10-09');
  });
});
