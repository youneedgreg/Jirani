import { dailyMetrics, type DayMetrics } from './baseline.ts';
import { stat } from './stats.ts';
import { hhmm, toLocal } from './time.ts';
import type { ContextNote, CoreEvent, Household } from './types.ts';

/**
 * Slow drift: compares the last 7 lived-in days with the 21 before them.
 * Wording rule: Jirani describes changes and suggests a conversation.
 * It never names a condition or a diagnosis.
 */

export interface DriftMetric {
  key: 'nightBathroom' | 'wakeTime' | 'outings' | 'visitors';
  label: string;
  recent: number;
  prior: number;
  /** Standardised change (recent mean vs prior mean, in standard errors). */
  z: number;
  flagged: boolean;
  sentence: string;
}

export interface WeeklyReport {
  householdId: string;
  weekEnding: string;
  recentDays: number;
  priorDays: number;
  metrics: DriftMetric[];
  headline: string;
  /** Present only when something is flagged. */
  suggestion?: string;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const r1 = (n: number) => Math.round(n * 10) / 10;

export function weeklyReport(
  h: Household,
  events: CoreEvent[],
  now: string,
  contexts: ContextNote[] = [],
): WeeklyReport {
  const today = toLocal(h.timeZone, now).date;
  const away = new Set<string>();
  for (const c of contexts.filter((c) => c.kind === 'away')) {
    for (let t = Date.parse(c.startsAt); t <= Date.parse(c.endsAt); t += 6 * 3600_000) away.add(toLocal(h.timeZone, t).date);
  }
  const days = dailyMetrics(h, events).filter(
    (d) => d.date < today && d.indoorCount >= 4 && d.firstActivity !== null && !away.has(d.date),
  );
  const recent = days.slice(-7);
  const prior = days.slice(-28, -7);

  const base: WeeklyReport = {
    householdId: h.id,
    weekEnding: recent.at(-1)?.date ?? today,
    recentDays: recent.length,
    priorDays: prior.length,
    metrics: [],
    headline: '',
  };
  if (recent.length < 5 || prior.length < 7) {
    base.headline = `Not enough lived-in days yet for a weekly comparison (${recent.length} recent, ${prior.length} earlier).`;
    return base;
  }

  const metric = (
    key: DriftMetric['key'],
    label: string,
    pick: (d: DayMetrics) => number,
    spread: { kind: 'count'; floor: number } | { kind: 'continuous'; floor: number },
    practical: (recent: number, prior: number) => boolean,
    words: (recent: number, prior: number, flagged: boolean) => string,
  ): DriftMetric => {
    const rv = recent.map(pick);
    const pv = prior.map(pick);
    const rm = mean(rv);
    const pm = mean(pv);
    // Counts (trips, visitors) are Poisson-like: their noise scales with the mean.
    // Continuous measures (wake time) use the earlier weeks' robust spread.
    const se =
      spread.kind === 'count'
        ? Math.sqrt(Math.max(pm, spread.floor) / rv.length)
        : Math.max(stat(pv).robustSd, spread.floor) / Math.sqrt(rv.length);
    const z = r1((rm - pm) / se);
    const flagged = Math.abs(z) >= 2.5 && practical(rm, pm);
    return { key, label, recent: r1(rm), prior: r1(pm), z, flagged, sentence: words(rm, pm, flagged) };
  };

  const name = h.residentName;
  base.metrics = [
    metric(
      'nightBathroom',
      'Night-time bathroom trips',
      (d) => d.nightBathroom,
      { kind: 'count', floor: 0.5 },
      (r, p) => r - p >= 1,
      (r, p, f) =>
        f
          ? `Night-time bathroom trips: about ${r1(r)} a night this week, up from ${r1(p)}. A change like this is worth mentioning to ${name}'s doctor.`
          : `Night-time bathroom trips: about ${r1(r)} a night, in line with before (${r1(p)}).`,
    ),
    metric(
      'wakeTime',
      'Getting up',
      (d) => d.firstActivity!,
      { kind: 'continuous', floor: 15 },
      (r, p) => Math.abs(r - p) >= 30,
      (r, p, f) =>
        f
          ? `Getting up around ${hhmm(r)}, ${r > p ? 'later' : 'earlier'} than her usual ${hhmm(p)}.`
          : `Getting up around ${hhmm(r)}, as usual.`,
    ),
    metric(
      'outings',
      'Front door use (outings)',
      (d) => d.frontDoorOpens,
      { kind: 'count', floor: 0.5 },
      (r, p) => p > 0 && r / p <= 0.6,
      (r, p, f) =>
        f
          ? `Fewer trips out: about ${r1(r)} front-door openings a day, down from ${r1(p)}.`
          : `Going out about as often as before.`,
    ),
    metric(
      'visitors',
      'Visitors',
      (d) => d.visitors,
      { kind: 'count', floor: 0.3 },
      (r, p) => p >= 0.3 && r / p <= 0.5,
      (r, p, f) => (f ? `Fewer visitors this week (${r1(r * 7)} vs about ${r1(p * 7)} a week before).` : `Visitors as usual.`),
    ),
  ];

  const flagged = base.metrics.filter((m) => m.flagged);
  base.headline = flagged.length
    ? `${flagged.length === 1 ? 'One change' : `${flagged.length} changes`} worth noticing this week: ${flagged.map((m) => m.label.toLowerCase()).join(', ')}.`
    : `A steady week. ${name}'s routine looks like her usual one.`;
  if (flagged.length) {
    base.suggestion = `Jirani doesn't diagnose anything. If these changes continue, a gentle conversation with ${name} or her doctor is a good next step.`;
  }
  return base;
}

/** The report as a few plain sentences: what the weekly_report tool says and the weekly email leads with. */
export function reportSummary(report: WeeklyReport): string {
  const flagged = report.metrics.filter((m) => m.flagged);
  // The headline lists the flagged labels for a card; spoken, the sentences already name them.
  const lead = flagged.length
    ? `${flagged.length === 1 ? 'One change' : `${flagged.length} changes`} worth noticing this week.`
    : report.headline;
  return [lead, ...flagged.map((m) => m.sentence), report.suggestion ?? ''].filter(Boolean).join(' ');
}
