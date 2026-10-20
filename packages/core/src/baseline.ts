import { stat, type Stat } from './stats.ts';
import { toLocal } from './time.ts';
import type { ContextNote, CoreEvent, Household, Role } from './types.ts';

/**
 * The rhythm baseline: what a normal day looks like for this person, learned
 * from past events. Pure statistics. No LLM ever touches these numbers.
 */

export const INDOOR_ROLES: Role[] = ['fridge', 'bathroom', 'medicine', 'frontDoor'];

export interface DayMetrics {
  date: string;
  weekday: number;
  /** Contact-sensor openings that day. */
  indoorCount: number;
  /** Minutes after midnight of the first morning activity (wake proxy). */
  firstActivity: number | null;
  lastActivity: number | null;
  /** Bathroom openings before the morning's first activity. */
  nightBathroom: number;
  frontDoorOpens: number;
  visitors: number;
  /** Longest quiet gap (minutes) between first and last activity. */
  maxGap: number;
  /** First opening per role after waking, minutes after midnight. */
  roleFirst: Partial<Record<Role, number>>;
  /** Hours (0-23) with at least one opening, per role. */
  roleHours: Partial<Record<Role, number[]>>;
}

export interface Baseline {
  /** Days the baseline was learned from (away/empty days excluded). */
  days: number;
  dates: string[];
  firstActivity: Stat;
  lastActivity: Stat;
  maxGap: Stat;
  roleFirst: Partial<Record<Role, Stat>>;
  /** Fraction of days with at least one opening in each local hour, per role. */
  hourly: Record<Role, number[]>;
  daily: DayMetrics[];
}

const isOpen = (e: CoreEvent) => e.type === 'contact_sensor_faulted';

/**
 * Wake proxy. Night-time bathroom trips cluster too, so "two openings close
 * together" is not enough. Getting up means using something other than the
 * bathroom (fridge, medicine, front door) after 04:00; the wake time is the
 * bathroom visit just before that, if there was one within 45 minutes.
 */
export function wakeMinute(opens: { role: Role; m: number }[]): number | null {
  const sorted = [...opens].sort((a, b) => a.m - b.m);
  const first = sorted.find((o) => o.m >= 240 && o.role !== 'bathroom');
  if (!first) return null;
  const lead = sorted.find((o) => o.role === 'bathroom' && o.m >= first.m - 45 && o.m <= first.m);
  return lead ? lead.m : first.m;
}

export function roleOf(h: Household, e: CoreEvent): Role | undefined {
  return h.devices[e.deviceId];
}

/** Group events into per-day metrics in the household's local time. */
export function dailyMetrics(h: Household, events: CoreEvent[]): DayMetrics[] {
  const byDate = new Map<string, { weekday: number; opens: { role: Role; m: number }[]; visitors: number }>();
  for (const e of events) {
    const role = roleOf(h, e);
    if (!role) continue;
    const l = toLocal(h.timeZone, e.at);
    let d = byDate.get(l.date);
    if (!d) byDate.set(l.date, (d = { weekday: l.weekday, opens: [], visitors: 0 }));
    if (e.type === 'button_press') d.visitors++;
    if (isOpen(e) && role !== 'doorbell') d.opens.push({ role, m: l.minutes });
  }

  const out: DayMetrics[] = [];
  for (const [date, d] of [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const opens = d.opens.sort((a, b) => a.m - b.m);
    const firstActivity = wakeMinute(opens);
    const lastActivity = opens.length ? opens.at(-1)!.m : null;
    const nightCutoff = firstActivity ?? 330;
    const nightBathroom = opens.filter((o) => o.role === 'bathroom' && o.m < nightCutoff - 5).length;

    let maxGap = 0;
    if (firstActivity !== null) {
      const awake = opens.filter((o) => o.m >= firstActivity);
      // A gap that starts at the front door is usually time out of the house, not stillness.
      for (let i = 1; i < awake.length; i++) {
        if (awake[i - 1]!.role === 'frontDoor') continue;
        maxGap = Math.max(maxGap, awake[i]!.m - awake[i - 1]!.m);
      }
    }

    const roleFirst: Partial<Record<Role, number>> = {};
    const roleHours: Partial<Record<Role, number[]>> = {};
    for (const o of opens) {
      if (firstActivity !== null && o.m >= firstActivity - 5 && roleFirst[o.role] === undefined) roleFirst[o.role] = o.m;
      const hours = (roleHours[o.role] ??= []);
      const hr = Math.floor(o.m / 60);
      if (!hours.includes(hr)) hours.push(hr);
    }

    out.push({
      date,
      weekday: d.weekday,
      indoorCount: opens.length,
      firstActivity,
      lastActivity,
      nightBathroom,
      frontDoorOpens: opens.filter((o) => o.role === 'frontDoor').length,
      visitors: d.visitors,
      maxGap,
      roleFirst,
      roleHours,
    });
  }
  return out;
}

export interface BaselineOptions {
  /** Learn only from complete days before this instant. */
  now: string;
  lookbackDays?: number;
  contexts?: ContextNote[];
}

/** Days with fewer openings than this are treated as "not home" and skipped. */
const MIN_INDOOR_PER_DAY = 4;

/** Local dates that an "away" plan touches (stepped 6 hours at a time, so every date in the span is caught). */
export function awayDates(h: Household, contexts: ContextNote[] = []): Set<string> {
  const dates = new Set<string>();
  for (const c of contexts) {
    if (c.kind !== 'away') continue;
    for (let t = Date.parse(c.startsAt); t <= Date.parse(c.endsAt); t += 6 * 3600_000) dates.add(toLocal(h.timeZone, t).date);
  }
  return dates;
}

export function buildBaseline(h: Household, events: CoreEvent[], opts: BaselineOptions): Baseline {
  const today = toLocal(h.timeZone, opts.now).date;
  const lookback = opts.lookbackDays ?? 28;
  const away = awayDates(h, opts.contexts);

  const daily = dailyMetrics(h, events)
    .filter((d) => d.date < today)
    .filter((d) => d.indoorCount >= MIN_INDOOR_PER_DAY && d.firstActivity !== null && !away.has(d.date))
    .slice(-lookback);

  const hourly = {} as Record<Role, number[]>;
  for (const role of [...INDOOR_ROLES, 'doorbell'] as Role[]) {
    const counts = new Array<number>(24).fill(0);
    for (const d of daily) for (const hr of d.roleHours[role] ?? []) counts[hr]!++;
    hourly[role] = counts.map((c) => (daily.length ? c / daily.length : 0));
  }

  const roleFirst: Partial<Record<Role, Stat>> = {};
  for (const role of INDOOR_ROLES) {
    const vals = daily.map((d) => d.roleFirst[role]).filter((v): v is number => v !== undefined);
    if (vals.length >= 5) roleFirst[role] = stat(vals);
  }

  return {
    days: daily.length,
    dates: daily.map((d) => d.date),
    firstActivity: stat(daily.map((d) => d.firstActivity!)),
    lastActivity: stat(daily.map((d) => d.lastActivity!)),
    maxGap: stat(daily.map((d) => d.maxGap)),
    roleFirst,
    hourly,
    daily,
  };
}
