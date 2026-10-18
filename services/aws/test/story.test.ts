import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoHousehold, MemoryStore } from '@jirani/mcp';
import { createApp } from '../../mcp/src/app.ts';
import { localTarget, main, withPausedSchedule, type Target } from '../src/story.ts';

/**
 * pnpm aws:story against an in-process local Jirani (the same app `pnpm mcp` runs), so
 * the story it plays for the video is checked in CI without AWS.
 */

const KEY = 'story-test-key';
let server: Server;
let target: Target;
const store = new MemoryStore(demoHousehold());

beforeAll(async () => {
  server = createApp(store, { hmacKey: KEY, demo: true }).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  target = { ...localTarget(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`), hmacKey: KEY };
});
afterAll(() => server.close());

const run = async (...argv: string[]) => {
  const lines: string[] = [];
  const code = await main(argv, target, (l) => lines.push(l));
  return { code, out: lines.join('\n') };
};

describe('pnpm aws:story (local target)', () => {
  it('plays Thursday to Monday: plan saved, quiet Sunday, then the ladder reaches Joe and Amina', async () => {
    const thu = await run('thursday', '--plan');
    expect(thu.code).toBe(0);
    expect(thu.out).toMatch(/signed events sent, 0 rejected/);
    expect(thu.out).toContain('from Saturday 17 October, 8:00am to Sunday 18 October, 7:00pm');

    await run('sunday');
    expect(store.state().escalations.filter((e) => e.status === 'open')).toEqual([]);
    expect(store.outbox().some((m) => m.type === 'notify_contact')).toBe(false);

    const mon = await run('monday');
    expect(mon.out).toMatch(/2026-10-19 10:05: checkin_resident→resident/);
    expect(mon.out).toMatch(/2026-10-19 10:26: notify_contact→joe/);
    expect(mon.out).toMatch(/2026-10-19 10:47: notify_contact→amina, offer_live_view→-/);

    const why = await run('mcp', 'why_alert');
    expect(why.out).toMatch(/At 10:26am Jirani messaged Joe \(her neighbour\)/);
  });

  it('closes Tuesday\'s alert when that morning arrives late, telling only Joe', async () => {
    const tue = await run('tuesday');
    expect(tue.out).toMatch(/2026-10-20 10:26: notify_contact→joe/);
    expect(tue.out).toMatch(/2026-10-20 10:30: all_clear→joe/);
    expect(store.state().escalations.find((e) => e.id === 'esc:no_morning_activity:2026-10-20')?.status).toBe('resolved');
  });

  it('sets the clock back to real time', async () => {
    const r = await run('clock', 'real');
    expect(Math.abs(Date.parse(r.out.split('clock: ')[1]!) - Date.now())).toBeLessThan(60_000);
  });

  it('shows usage for an unknown command', async () => {
    expect((await run('dance')).code).toBe(1);
  });

  it('never prints the API token', async () => {
    const secret = 'tok-should-never-appear-123';
    const lines: string[] = [];
    await main(['state'], { ...target, token: secret }, (l) => lines.push(l)).catch(() => {});
    expect(lines.join('\n')).not.toContain(secret);
  });
});

describe('withPausedSchedule', () => {
  it('turns the schedule off, then back on even if the phase fails', async () => {
    const calls: boolean[] = [];
    const t = { ...localTarget(), setSchedule: async (on: boolean) => void calls.push(on) };
    await expect(withPausedSchedule(t, true, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(calls).toEqual([false, true]);
  });

  it('leaves the schedule alone without --pause-schedule', async () => {
    const calls: boolean[] = [];
    const t = { ...localTarget(), setSchedule: async (on: boolean) => void calls.push(on) };
    await withPausedSchedule(t, false, async () => 1);
    expect(calls).toEqual([]);
  });
});
