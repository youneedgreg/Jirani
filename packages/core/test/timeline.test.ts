import { describe, expect, it } from 'vitest';
import { describeEvent, todayTimeline, type CoreEvent } from '@jirani/core';
import { DEFAULT_DEVICES } from 'ring-routine-sim';
import { at, margaret, preset, upTo } from './fixtures.ts';

const h = margaret();
const ev = (deviceId: string, type: string, extra: Partial<CoreEvent> = {}): CoreEvent => ({
  id: 'e1',
  deviceId,
  type,
  at: at('2026-10-15', '07:12'),
  ...extra,
});

describe('describeEvent', () => {
  it('says what opened, and leaves out closings and passing cars', () => {
    expect(describeEvent(h, ev(DEFAULT_DEVICES.bathroom, 'contact_sensor_faulted'))).toBe('Bathroom door opened');
    expect(describeEvent(h, ev(DEFAULT_DEVICES.fridge, 'contact_sensor_faulted'))).toBe('Fridge opened');
    expect(describeEvent(h, ev(DEFAULT_DEVICES.fridge, 'contact_sensor_cleared'))).toBeNull();
    expect(describeEvent(h, ev(DEFAULT_DEVICES.doorbell, 'button_press'))).toBe('Doorbell pressed');
    expect(describeEvent(h, ev(DEFAULT_DEVICES.doorbell, 'motion_detected', { subType: 'human' }))).toBe('Someone at the front door');
    expect(describeEvent(h, ev(DEFAULT_DEVICES.doorbell, 'motion_detected', { subType: 'vehicle' }))).toBeNull();
    expect(describeEvent(h, ev(DEFAULT_DEVICES.fridge, 'device_offline'))).toBe('Fridge sensor went offline');
    expect(describeEvent(h, ev('unknown-device', 'contact_sensor_faulted'))).toBeNull();
  });
});

describe('todayTimeline', () => {
  it("lists only today's events up to now, oldest first, in local time", () => {
    const now = at('2026-10-15', '18:00');
    const t = todayTimeline(h, upTo(preset('demo'), at('2026-10-19', '10:05')), now);
    expect(t.date).toBe('2026-10-15');
    expect(t.items.length).toBeGreaterThan(3);
    expect(t.items.every((i) => i.at.slice(0, 10) >= '2026-10-15' && Date.parse(i.at) <= Date.parse(now))).toBe(true);
    expect([...t.items].sort((a, b) => a.at.localeCompare(b.at))).toEqual(t.items);
    expect(t.items[0]!.time).toMatch(/^\d{1,2}:\d\d(am|pm)$/);
    expect(t.items.some((i) => /closed/.test(i.text))).toBe(false);
  });

  it('is empty on a silent morning', () => {
    const now = at('2026-10-19', '10:47');
    expect(todayTimeline(h, upTo(preset('demo'), now), now).items).toEqual([]);
  });
});
