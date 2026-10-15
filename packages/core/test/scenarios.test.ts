import { describe, expect, it } from 'vitest';
import { buildBaseline, detect, evaluate, weeklyReport, type CoreEvent, type JiraniState } from '@jirani/core';
import { DEFAULT_DEVICES } from 'ring-routine-sim';
import { at, context, margaret, preset, upTo } from './fixtures.ts';

/**
 * The six scenarios from the roadmap's Day 2 gate. If these pass, the brain is
 * trustworthy: it speaks up when it should and stays quiet when it should.
 */

const h = margaret();

function state(events: CoreEvent[], contexts: JiraniState['contexts'] = []): JiraniState {
  return { household: h, events, contexts, escalations: [] };
}

const dateOf = (day: number) => new Date(Date.UTC(2026, 8, 21 + day)).toISOString().slice(0, 10);

describe('1. a normal routine raises no high alerts', () => {
  it('stays quiet through two ordinary weeks, checked every two hours', () => {
    const all = preset('normal');
    let s = state([]);
    const high: string[] = [];
    for (let day = 14; day < 28; day++) {
      for (const time of ['08:30', '10:30', '12:30', '14:30', '16:30', '18:30']) {
        const now = at(dateOf(day), time);
        s = { ...s, events: upTo(all, now) };
        const ev = evaluate(s, now);
        high.push(...ev.deviations.filter((d) => d.severity === 'high').map((d) => `${now} ${d.summary}`));
        s = { ...s, escalations: ev.escalations, lastEvaluatedAt: now };
      }
    }
    expect(high).toEqual([]);
  });
});

describe('2. a silent morning starts the ladder at Margaret herself', () => {
  const all = preset('missed-morning');
  const monday = '2026-10-19';

  it('asks her first, then Joe, then Amina with consented live view', () => {
    let now = at(monday, '10:05');
    let ev = evaluate(state(upTo(all, now)), now);
    const morning = ev.escalations.find((e) => e.deviationId.startsWith('no_morning_activity'));
    expect(morning?.level).toBe(1);
    expect(ev.actions.map((a) => a.action.type)).toContain('checkin_resident');

    let s: JiraniState = { ...state(upTo(all, now)), escalations: ev.escalations, lastEvaluatedAt: now };
    now = at(monday, '10:26');
    ev = evaluate({ ...s, events: upTo(all, now) }, now);
    expect(ev.escalations.find((e) => e.id === morning!.id)?.level).toBe(2);
    expect(ev.actions.find((a) => a.action.type === 'notify_contact')?.action.to).toBe('joe');

    s = { ...s, escalations: ev.escalations, lastEvaluatedAt: now };
    now = at(monday, '10:47');
    ev = evaluate({ ...s, events: upTo(all, now) }, now);
    expect(ev.escalations.find((e) => e.id === morning!.id)?.level).toBe(3);
    const types = ev.actions.map((a) => a.action.type);
    expect(types).toContain('offer_live_view');
    expect(ev.actions.find((a) => a.action.type === 'notify_contact')?.action.to).toBe('amina');
  });

  it('a late_start context ("sleeping in") moves the expectation later', () => {
    const now = at(monday, '09:00');
    const events = upTo(all, now);
    const quiet = evaluate(
      state(events, [context('late_start', 'Sleeping in, bad night', at(monday, '00:00'), at(monday, '12:00'), { shiftMinutes: 150 })]),
      now,
    );
    expect(quiet.deviations.filter((d) => d.kind === 'no_morning_activity')).toEqual([]);
  });
});

describe('3. the front door at 3am is unusual', () => {
  it('flags a night-time front door opening as high severity', () => {
    const day = dateOf(27);
    const events = preset('normal', at(day, '03:15'));
    const door: CoreEvent = {
      id: 'evt-3am',
      deviceId: DEFAULT_DEVICES.frontDoor,
      type: 'contact_sensor_opened',
      at: at(day, '03:10'),
    };
    const now = at(day, '03:15');
    const ev = evaluate({ ...state([...events, door]), lastEvaluatedAt: at(day, '03:00') }, now);
    const d = ev.deviations.find((x) => x.kind === 'unusual_event' && x.evidence.eventIds.includes('evt-3am'));
    expect(d?.severity).toBe('high');
    expect(d?.summary).toMatch(/front door/i);
  });
});

describe('4. context prevents false alarms ("at my sister\'s Saturday")', () => {
  const all = preset('away');
  const sat = '2026-10-17';
  const sun = '2026-10-18';
  const away = context('away', "At my sister's for the weekend", at(sat, '08:00'), at(sun, '19:00'));

  it('without context, a silent Sunday morning raises an alert', () => {
    const now = at(sun, '09:30');
    const ev = evaluate(state(upTo(all, now)), now);
    expect(ev.deviations.some((d) => d.kind === 'no_morning_activity')).toBe(true);
  });

  it('with context, the same morning is suppressed and the reason is kept', () => {
    const now = at(sun, '09:30');
    const ev = evaluate(state(upTo(all, now), [away]), now);
    expect(ev.deviations.filter((d) => d.severity === 'high')).toEqual([]);
    expect(ev.suppressed.find((s) => s.deviation.kind === 'no_morning_activity')?.contextId).toBe(away.id);
  });

  it('away days are not learned as normal days', () => {
    const now = at('2026-10-19', '06:00');
    const b = buildBaseline(h, upTo(all, now), { now, contexts: [away] });
    expect(b.dates).not.toContain(sat);
    expect(b.dates).not.toContain(sun);
  });
});

describe('5. slow drift is reported without diagnosing', () => {
  it('flags rising night-time bathroom trips and suggests a conversation', () => {
    const now = at('2026-10-19', '08:00');
    const report = weeklyReport(h, upTo(preset('drift'), now), now);
    const m = report.metrics.find((x) => x.key === 'nightBathroom')!;
    expect(m.flagged).toBe(true);
    expect(m.recent).toBeGreaterThan(m.prior + 1);
    expect(m.sentence).toMatch(/worth mentioning to Margaret's doctor/);
    expect(report.suggestion).toMatch(/doesn't diagnose/);
    expect(JSON.stringify(report)).not.toMatch(/\b(UTI|[Ii]nfection|[Dd]ementia|[Dd]iagnosis|[Dd]iagnosed)\b/);
  });

  it('a steady routine is reported as steady', () => {
    const now = at('2026-10-19', '08:00');
    const report = weeklyReport(h, upTo(preset('normal'), now), now);
    expect(report.metrics.filter((m) => m.flagged)).toEqual([]);
    expect(report.headline).toMatch(/steady week/i);
  });
});

describe('6. a dead sensor is maintenance, not an emergency', () => {
  it('suppresses fridge-based alerts while the fridge sensor is offline', () => {
    const day = dateOf(20);
    const now = at(day, '09:00');
    const all = preset('offline');
    const ev = evaluate(state(upTo(all, now)), now);
    expect(ev.notices.some((n) => n.kind === 'sensor_offline' && n.role === 'fridge')).toBe(true);
    expect(ev.deviations.some((d) => d.role === 'fridge')).toBe(false);
    expect(ev.deviations.filter((d) => d.severity === 'high')).toEqual([]);
  });

  it('the same morning without the offline signal would flag the fridge', () => {
    const day = dateOf(20);
    const now = at(day, '09:00');
    const all = preset('offline').filter((e) => e.type !== 'device_offline' && e.type !== 'device_online');
    const b = buildBaseline(h, upTo(all, now), { now });
    const det = detect({ household: h, events: upTo(all, now), baseline: b, contexts: [], now });
    expect(det.deviations.some((d) => d.kind === 'late_role' && d.role === 'fridge')).toBe(true);
  });
});

describe('learning period', () => {
  it('raises nothing until a week of routine is known', () => {
    const now = at('2026-09-24', '11:00');
    const ev = evaluate(state(upTo(preset('missed-morning'), now)), now);
    expect(ev.deviations).toEqual([]);
    expect(ev.notices.some((n) => n.kind === 'learning')).toBe(true);
  });
});

describe('drift detection across many simulated households', () => {
  // Honest numbers for the README: how often the weekly report catches a real
  // three-week rise, and how often it cries wolf on an ordinary routine.
  it('catches most drifts and rarely flags a steady routine', async () => {
    const { generate, PRESETS } = await import('ring-routine-sim');
    const now = at('2026-10-19', '08:00');
    let caught = 0;
    let falseFlags = 0;
    const seeds = Array.from({ length: 20 }, (_, i) => i + 1);
    for (const seed of seeds) {
      const drift = generate({ ...PRESETS.drift!.options, seed }).filter((e) => e.at <= now);
      if (weeklyReport(h, drift, now).metrics.find((m) => m.key === 'nightBathroom')!.flagged) caught++;
      const normal = generate({ ...PRESETS.normal!.options, seed }).filter((e) => e.at <= now);
      if (weeklyReport(h, normal, now).metrics.some((m) => m.flagged)) falseFlags++;
    }
    expect(caught).toBeGreaterThanOrEqual(14);
    expect(falseFlags).toBeLessThanOrEqual(1);
  }, 60_000);
});
