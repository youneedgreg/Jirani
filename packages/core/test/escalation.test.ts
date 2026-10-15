import { describe, expect, it } from 'vitest';
import { evaluate, openEscalation, respond, tick, type Deviation, type JiraniState } from '@jirani/core';
import { margaret, preset, upTo, at } from './fixtures.ts';

const h = margaret();
const high: Deviation = {
  id: 'no_morning_activity:2026-10-19',
  kind: 'no_morning_activity',
  severity: 'high',
  score: 6,
  date: '2026-10-19',
  detectedAt: '2026-10-19T14:05:00.000Z',
  summary: 'No morning activity yet.',
  evidence: { expected: '', observed: '', eventIds: [] },
};
const t0 = '2026-10-19T14:05:00.000Z';
const plus = (min: number) => new Date(Date.parse(t0) + min * 60_000).toISOString();

describe('escalation ladder', () => {
  it('logs low severity without telling anyone', () => {
    const e = openEscalation({ ...high, severity: 'low' }, h, t0);
    expect(e.status).toBe('logged');
    expect(e.level).toBe(0);
  });

  it('does not move before the wait is over', () => {
    const e = openEscalation(high, h, t0);
    expect(tick(e, h, plus(19)).level).toBe(1);
    expect(tick(e, h, plus(20)).level).toBe(2);
  });

  it('resolves when Margaret answers, and tells anyone already involved', () => {
    let e = openEscalation(high, h, t0);
    e = tick(e, h, plus(20));
    e = respond(e, h, { from: 'resident', outcome: 'ok', note: 'Slept in' }, plus(25));
    expect(e.status).toBe('resolved');
    expect(e.resolution?.by).toBe('Margaret');
    expect(e.history.at(-1)!.actions).toEqual([expect.objectContaining({ type: 'all_clear', to: 'joe' })]);
  });

  it('goes straight to family when the neighbour gets no answer', () => {
    let e = openEscalation(high, h, t0);
    e = tick(e, h, plus(20));
    e = respond(e, h, { from: 'contact', contactId: 'joe', outcome: 'no_answer' }, plus(30));
    expect(e.level).toBe(3);
  });

  it('suggests emergency services on a reported problem but never calls itself', () => {
    let e = openEscalation(high, h, t0);
    e = respond(e, h, { from: 'contact', contactId: 'joe', outcome: 'problem', note: 'She fell' }, plus(10));
    expect(e.level).toBe(4);
    const msg = e.history.at(-1)!.actions[0]!.message;
    expect(msg).toMatch(/call 911/);
    expect(msg).toMatch(/will not call for you/);
  });

  it('skips the neighbour when none is on file', () => {
    const noNeighbour = margaret({ contacts: [{ id: 'amina', name: 'Amina', relation: 'family', priority: 1 }] });
    const e = tick(openEscalation(high, noNeighbour, t0), noNeighbour, plus(20));
    expect(e.level).toBe(3);
  });

  it('never offers live view without consent', () => {
    const noConsent = margaret({ consent: { liveViewAtLevel3: false } });
    let e = openEscalation(high, noConsent, t0);
    e = tick(tick(e, noConsent, plus(20)), noConsent, plus(40));
    expect(e.level).toBe(3);
    expect(e.history.at(-1)!.actions.some((a) => a.type === 'offer_live_view')).toBe(false);
  });
});

describe('pause', () => {
  it('a pause by Margaret closes open alerts and opens no new ones', () => {
    const now = at('2026-10-19', '10:05');
    const events = upTo(preset('missed-morning'), now);
    const base: JiraniState = { household: h, events, contexts: [], escalations: [] };
    const opened = evaluate(base, now);
    expect(opened.escalations.some((e) => e.status === 'open')).toBe(true);

    const paused = evaluate(
      { ...base, escalations: opened.escalations, pause: { until: at('2026-10-19', '12:05'), by: 'resident' } },
      now,
    );
    expect(paused.paused).toBe(true);
    expect(paused.escalations.every((e) => e.status !== 'open')).toBe(true);
    expect(paused.actions).toEqual([]);
  });
});
