import { describe, expect, it } from 'vitest';
import { generate, PRESETS, replay, sign, toEnvelope, utcToLocal, DEFAULT_DEVICES } from 'ring-routine-sim';
import { parseWebhook, verifySignature, normalise } from '@jirani/ring';

const TZ = 'America/New_York';
const localDay = (iso: string) => {
  const p = utcToLocal(TZ, Date.parse(iso));
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
};
const localMinutes = (iso: string) => utcToLocal(TZ, Date.parse(iso)).minutes;

describe('generate', () => {
  it('is deterministic for a seed', () => {
    const a = generate({ start: '2026-09-21', days: 3, seed: 1 });
    const b = generate({ start: '2026-09-21', days: 3, seed: 1 });
    expect(a).toEqual(b);
    expect(generate({ start: '2026-09-21', days: 3, seed: 2 })).not.toEqual(a);
  });

  it('produces sorted events with breakfast in the morning, local time', () => {
    const events = generate({ start: '2026-09-21', days: 7, seed: 3, timeZone: TZ });
    const times = events.map((e) => Date.parse(e.at));
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    const breakfasts = events.filter((e) => e.label === 'breakfast' && e.type === 'contact_sensor_opened');
    expect(breakfasts).toHaveLength(7);
    for (const b of breakfasts) {
      const m = localMinutes(b.at);
      expect(m).toBeGreaterThan(5 * 60);
      expect(m).toBeLessThan(11 * 60);
    }
  });

  it('drift raises night bathroom trips (averaged over seeds)', () => {
    const nightPerDay = (seed: number, fromDay: number) => {
      const events = generate({ ...PRESETS.drift!.options, seed });
      let n = 0;
      for (let i = 0; i < 7; i++) {
        const day = new Date(Date.UTC(2026, 8, 21 + fromDay + i)).toISOString().slice(0, 10);
        n += events.filter(
          (e) => e.label === 'night bathroom trip' && e.type === 'contact_sensor_opened' && localDay(e.at) === day,
        ).length;
      }
      return n / 7;
    };
    const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
    const early = seeds.reduce((s, x) => s + nightPerDay(x, 0), 0) / seeds.length;
    const late = seeds.reduce((s, x) => s + nightPerDay(x, 21), 0) / seeds.length;
    expect(early).toBeLessThan(1.6);
    expect(late).toBeGreaterThan(3);
  });

  it('away leaves the house silent except street noise', () => {
    const events = generate(PRESETS.away!.options);
    const saturday = events.filter((e) => localDay(e.at) === '2026-10-17' && localMinutes(e.at) > 9 * 60 + 5);
    expect(saturday.every((e) => e.deviceId === DEFAULT_DEVICES.doorbell && e.subType !== 'human')).toBe(true);
  });

  it('missed morning removes indoor activity before the cut-off', () => {
    const events = generate(PRESETS['missed-morning']!.options);
    const mondayMorning = events.filter(
      (e) => localDay(e.at) === '2026-10-19' && localMinutes(e.at) < 11 * 60 + 40 && e.deviceId !== DEFAULT_DEVICES.doorbell,
    );
    expect(mondayMorning).toHaveLength(0);
  });

  it('offline emits offline/online and silences that sensor', () => {
    const events = generate(PRESETS.offline!.options);
    const fridge = events.filter((e) => e.deviceId === DEFAULT_DEVICES.fridge);
    const off = fridge.findIndex((e) => e.type === 'device_offline');
    const on = fridge.findIndex((e) => e.type === 'device_online');
    expect(off).toBeGreaterThan(-1);
    expect(on).toBe(off + 1);
  });

  it('respects until', () => {
    const events = generate(PRESETS.demo!.options);
    expect(events.at(-1)!.at <= '2026-10-19T14:05:00.000Z').toBe(true);
  });
});

describe('Ring compatibility', () => {
  it('envelopes parse and signatures verify with the Jirani Ring package', () => {
    const [ev] = generate({ start: '2026-09-21', days: 1, seed: 5 });
    const body = JSON.stringify(toEnvelope(ev!));
    expect(verifySignature(body, sign(body, 'k'), 'k')).toBe(true);
    const n = normalise(parseWebhook(body));
    expect(n).toMatchObject({ id: ev!.id, requestId: ev!.requestId, deviceId: ev!.deviceId, type: ev!.type, at: ev!.at });
    // Ring's v1.1 shape: event name in data.type, device in attributes.source, epoch-ms timestamp.
    const env = JSON.parse(body);
    expect(env.meta).toMatchObject({ version: '1.1', account_id: expect.any(String) });
    expect(env.data).toMatchObject({ type: ev!.type, attributes: { source: ev!.deviceId, source_type: 'devices', timestamp: Date.parse(ev!.at) } });
  });

  it('replay posts signed bodies and counts statuses', async () => {
    const events = generate({ start: '2026-09-21', days: 1, seed: 6 });
    let verified = 0;
    const summary = await replay(events, {
      url: 'http://example.test/hook',
      hmacKey: 'k',
      fetchImpl: async (_url, init) => {
        const headers = new Headers(init?.headers);
        if (verifySignature(String(init?.body), headers.get('x-signature'), 'k')) verified++;
        return new Response(null, { status: 200 });
      },
    });
    expect(summary.sent).toBe(events.length);
    expect(verified).toBe(events.length);
  });
});
