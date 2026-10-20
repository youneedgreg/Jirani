import { roleOf, type Baseline } from './baseline.ts';
import type { Escalation } from './escalation.ts';
import { hhmm, toLocal } from './time.ts';
import type { ContextNote, CoreEvent, Household } from './types.ts';
import { activeContexts, type Notice } from './deviations.ts';

/**
 * Facts for "How's Mum today?". Every line points at real events so an agent can
 * phrase it warmly without inventing anything.
 */
export interface DaySummary {
  date: string;
  lines: string[];
  facts: {
    upAt: string | null;
    usualUpAt: string;
    fridgeOpenings: number;
    medicine: string[];
    trips: number;
    visitors: number;
    lastActivity: string | null;
    openAlerts: number;
    activeContext: string[];
  };
  eventIds: string[];
}

export function summariseDay(
  h: Household,
  events: CoreEvent[],
  baseline: Baseline,
  escalations: Escalation[],
  contexts: ContextNote[],
  now: string,
  notices: Notice[] = [],
): DaySummary {
  const today = toLocal(h.timeZone, now).date;
  const nowMs = Date.parse(now);
  const todays = events
    .filter((e) => Date.parse(e.at) <= nowMs)
    .map((e) => ({ e, l: toLocal(h.timeZone, e.at), role: roleOf(h, e) }))
    .filter((x) => x.l.date === today && x.role)
    .sort((a, b) => a.e.at.localeCompare(b.e.at));

  const opens = todays.filter((x) => x.e.type === 'contact_sensor_faulted' && x.role !== 'doorbell');
  const morning = opens.filter((x) => x.l.minutes >= 300);
  const upAt = morning[0] ? hhmm(morning[0].l.minutes) : null;
  const fridge = opens.filter((x) => x.role === 'fridge');
  const medicine = opens.filter((x) => x.role === 'medicine').map((x) => hhmm(x.l.minutes));
  const trips = opens.filter((x) => x.role === 'frontDoor').length;
  const visitors = todays.filter((x) => x.e.type === 'button_press').length;
  const last = opens.at(-1);
  const open = escalations.filter((e) => e.status === 'open');
  const ctx = activeContexts(contexts, now).map((c) => c.text);
  const name = h.residentName;

  const lines: string[] = [];
  if (ctx.length) lines.push(`Context right now: ${ctx.join('; ')}.`);
  lines.push(
    upAt
      ? `${name} was up at ${upAt} (usually around ${hhmm(baseline.firstActivity.median)}).`
      : `No morning activity yet today (usually up around ${hhmm(baseline.firstActivity.median)}).`,
  );
  if (fridge.length) lines.push(`The fridge has been opened ${fridge.length} time${fridge.length === 1 ? '' : 's'}, first at ${hhmm(fridge[0]!.l.minutes)}.`);
  if (medicine.length) lines.push(`Medicine cabinet opened at ${medicine.join(' and ')}.`);
  if (trips) lines.push(`Front door used ${trips} time${trips === 1 ? '' : 's'}.`);
  if (visitors) lines.push(`${visitors} visitor${visitors === 1 ? '' : 's'} rang the bell.`);
  if (last) lines.push(`Last activity: ${hhmm(last.l.minutes)}.`);
  for (const n of notices) lines.push(n.message);
  for (const e of escalations) {
    if (e.status !== 'resolved' || !e.resolution) continue;
    const r = toLocal(h.timeZone, e.resolution.at);
    if (r.date !== today) continue;
    lines.push(`Earlier alert resolved at ${hhmm(r.minutes)}: ${e.resolution.by} said "${e.resolution.note}".`);
  }
  lines.push(open.length ? `Open alerts: ${open.map((e) => `${e.summary} (level ${e.level})`).join('; ')}` : 'No open alerts.');

  return {
    date: today,
    lines,
    facts: {
      upAt,
      usualUpAt: hhmm(baseline.firstActivity.median),
      fridgeOpenings: fridge.length,
      medicine,
      trips,
      visitors,
      lastActivity: last ? hhmm(last.l.minutes) : null,
      openAlerts: open.length,
      activeContext: ctx,
    },
    eventIds: opens.map((x) => x.e.id),
  };
}
