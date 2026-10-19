import { awayDates, countsForWeekly, dailyMetrics, summariseDay, todayTimeline, toLocal, weeklyReport } from '@jirani/core';
import { runEvaluation } from './runtime.ts';
import type { Store } from './store.ts';

/**
 * Framework-free handlers for the dashboard API, shared by the local Express app
 * and the AWS Lambda.
 */

/** GET /api/state: evaluates first, so the dashboard never shows a stale ladder. */
export function dashboardState(store: Store) {
  const ev = runEvaluation(store);
  const s = store.state();
  return {
    now: store.now(),
    household: { id: s.household.id, residentName: s.household.residentName, timeZone: s.household.timeZone },
    summary: summariseDay(s.household, s.events, ev.baseline, s.escalations, s.contexts, store.now(), ev.notices),
    escalations: s.escalations.filter((e) => e.status !== 'logged'),
    suppressed: ev.suppressed.map((x) => ({ summary: x.deviation.summary, reason: x.reason })),
    notices: ev.notices,
    outbox: store.outbox().slice(-50),
    paused: s.pause && Date.parse(s.pause.until) > Date.parse(store.now()) ? { until: s.pause.until } : null,
  };
}

/** GET /api/timeline: today's events in plain words, oldest first ("7:12am Bathroom door opened"). */
export function dashboardTimeline(store: Store) {
  const s = store.state();
  return todayTimeline(s.household, s.events, store.now());
}

/**
 * GET /api/days: the last 28 days before today, one row each, for the rhythm chart.
 * firstActivity is minutes after local midnight (null if she wasn't up at home).
 * `away` marks days a plan said she was away; `counted` is whether the weekly report
 * compares that day (home for the morning, enough activity, not away).
 */
export function dashboardDays(store: Store, days = 28) {
  const s = store.state();
  const h = s.household;
  const now = store.now();
  const today = toLocal(h.timeZone, now).date;
  const away = awayDates(h, s.contexts);
  const past = s.events.filter((e) => Date.parse(e.at) <= Date.parse(now));
  const rows = dailyMetrics(h, past)
    .filter((d) => d.date < today)
    .slice(-days)
    .map((d) => ({
      date: d.date,
      weekday: d.weekday,
      firstActivity: d.firstActivity,
      nightBathroom: d.nightBathroom,
      outings: d.frontDoorOpens,
      visitors: d.visitors,
      indoorCount: d.indoorCount,
      away: away.has(d.date),
      counted: countsForWeekly(d, away),
    }));
  return { timeZone: h.timeZone, residentName: h.residentName, days: rows };
}

/** GET /api/now: Jirani's clock (the demo clock when set) and the household's time zone, for the agent. */
export function clockInfo(store: Store) {
  const h = store.household();
  return { now: store.now(), timeZone: h.timeZone, residentName: h.residentName };
}

/** GET /api/report */
export function dashboardReport(store: Store) {
  const s = store.state();
  return weeklyReport(s.household, s.events, store.now(), s.contexts);
}

/** POST /internal/evaluate: the runtime trigger (EventBridge Scheduler in AWS). */
export function evaluateNow(store: Store) {
  const ev = runEvaluation(store);
  return { now: store.now(), actions: ev.actions, deviations: ev.deviations, notices: ev.notices };
}
