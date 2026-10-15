import type { Baseline } from './baseline.ts';
import { roleOf } from './baseline.ts';
import { hhmm, toLocal } from './time.ts';
import type { ContextNote, CoreEvent, Household, Role } from './types.ts';

export type DeviationKind = 'no_morning_activity' | 'late_role' | 'unusual_event' | 'long_inactivity';

export interface Deviation {
  /** Stable key: the same situation on the same day has the same id. */
  id: string;
  kind: DeviationKind;
  severity: 'low' | 'high';
  /** How far outside normal, in robust standard deviations (or -log10 p for rare events). */
  score: number;
  role?: Role;
  /** Local date */
  date: string;
  detectedAt: string;
  summary: string;
  evidence: { expected: string; observed: string; eventIds: string[] };
}

export interface Suppression {
  deviation: Deviation;
  reason: string;
  contextId?: string;
}

export interface Notice {
  kind: 'sensor_offline' | 'learning';
  message: string;
  deviceId?: string;
  role?: Role;
  since?: string;
}

export interface DetectionResult {
  deviations: Deviation[];
  suppressed: Suppression[];
  notices: Notice[];
}

export interface DetectInput {
  household: Household;
  /** Every event so far, any order. */
  events: CoreEvent[];
  baseline: Baseline;
  contexts: ContextNote[];
  now: string;
  /** Only consider events after this instant for "unusual event" checks. */
  since?: string;
}

const MIN_BASELINE_DAYS = 7;
const RARE_HOUR_PROBABILITY = 0.04;

const ROLE_WORDS: Record<Role, string> = {
  frontDoor: 'front door',
  fridge: 'fridge',
  bathroom: 'bathroom door',
  medicine: 'medicine cabinet',
  doorbell: 'doorbell',
};

export function activeContexts(contexts: ContextNote[], now: string): ContextNote[] {
  const t = Date.parse(now);
  return contexts.filter((c) => Date.parse(c.startsAt) <= t && t <= Date.parse(c.endsAt));
}

/** Devices whose most recent status event is device_offline. */
export function offlineDevices(events: CoreEvent[], now: string): Map<string, string> {
  const last = new Map<string, CoreEvent>();
  const t = Date.parse(now);
  for (const e of events) {
    if ((e.type === 'device_offline' || e.type === 'device_online') && Date.parse(e.at) <= t) {
      const prev = last.get(e.deviceId);
      if (!prev || prev.at <= e.at) last.set(e.deviceId, e);
    }
  }
  const off = new Map<string, string>();
  for (const [id, e] of last) if (e.type === 'device_offline') off.set(id, e.at);
  return off;
}

export function detect(input: DetectInput): DetectionResult {
  const { household: h, baseline: b, now } = input;
  const result: DetectionResult = { deviations: [], suppressed: [], notices: [] };
  const nowMs = Date.parse(now);
  const local = toLocal(h.timeZone, now);
  const contexts = activeContexts(input.contexts, now);
  const away = contexts.find((c) => c.kind === 'away');
  const lateStart = contexts.find((c) => c.kind === 'late_start');
  const visitor = contexts.find((c) => c.kind === 'visitor_expected');

  const offline = offlineDevices(input.events, now);
  const offlineRoles = new Set<Role>();
  for (const [deviceId, since] of offline) {
    const role = h.devices[deviceId];
    if (role) offlineRoles.add(role);
    result.notices.push({
      kind: 'sensor_offline',
      deviceId,
      ...(role ? { role } : {}),
      since,
      message: `The ${role ? ROLE_WORDS[role] : 'a'} sensor has been offline since ${hhmm(toLocal(h.timeZone, since).minutes)}. It won't be treated as an emergency.`,
    });
  }

  if (b.days < MIN_BASELINE_DAYS) {
    result.notices.push({
      kind: 'learning',
      message: `Still learning the routine: ${b.days} of ${MIN_BASELINE_DAYS} days collected. No alerts yet.`,
    });
    return result;
  }

  const past = input.events.filter((e) => Date.parse(e.at) <= nowMs).sort((x, y) => x.at.localeCompare(y.at));
  const opens = past.filter((e) => e.type === 'contact_sensor_opened' && roleOf(h, e) && roleOf(h, e) !== 'doorbell');
  const todayOpens = opens
    .map((e) => ({ e, l: toLocal(h.timeZone, e.at), role: roleOf(h, e)! }))
    .filter((x) => x.l.date === local.date);
  const lastOpen = opens.at(-1);
  const lastOpenWords = lastOpen
    ? `last activity was the ${ROLE_WORDS[roleOf(h, lastOpen)!]} at ${hhmm(toLocal(h.timeZone, lastOpen.at).minutes)}${toLocal(h.timeZone, lastOpen.at).date === local.date ? '' : ' (yesterday or earlier)'}`
    : 'no activity recorded yet';

  const push = (d: Deviation, suppress?: { reason: string; contextId?: string }) => {
    if (suppress) result.suppressed.push({ deviation: d, ...suppress });
    else result.deviations.push(d);
  };

  // 1. No morning activity. She counts as up once she uses something other than the
  // bathroom after 5am, or opens anything twice: a lone bathroom trip may be a night trip.
  const after5 = todayOpens.filter((x) => x.l.minutes >= 300);
  const up = after5.some((x) => x.role !== 'bathroom') || after5.length >= 2;
  const morning = up ? after5 : [];
  const fa = b.firstActivity;
  const shift = lateStart ? (lateStart.shiftMinutes ?? 120) : 0;
  const tolerance = Math.max(2.5 * fa.robustSd, 45);
  const expectedBy = fa.median + tolerance + shift;
  if (morning.length === 0 && local.minutes > expectedBy && local.minutes < 20 * 60) {
    const d: Deviation = {
      id: `no_morning_activity:${local.date}`,
      kind: 'no_morning_activity',
      severity: 'high',
      score: round((local.minutes - fa.median - shift) / Math.max(fa.robustSd, 15)),
      date: local.date,
      detectedAt: now,
      summary: `No morning activity yet. ${h.residentName} is usually up by ${hhmm(fa.median)}.`,
      evidence: {
        expected: `First activity around ${hhmm(fa.median)} (90% of days by ${hhmm(fa.p90)})${shift ? `, shifted ${shift} min by context` : ''}`,
        observed: `Nothing since 5:00am today; ${lastOpenWords}.`,
        eventIds: lastOpen ? [lastOpen.id] : [],
      },
    };
    push(d, away ? { reason: `Context: ${away.text}`, contextId: away.id } : undefined);
  }

  // 2. A usual role is late (e.g. breakfast fridge, morning medication). Low severity.
  if (morning.length > 0) {
    const wake = morning[0]!.l.minutes;
    for (const role of ['fridge', 'medicine'] as Role[]) {
      const s = b.roleFirst[role];
      if (!s || s.n < 0.8 * b.days) continue;
      const seen = morning.some((x) => x.role === role);
      const lateBy = Math.max(3 * s.robustSd, 60);
      const typicalDelay = s.median - fa.median;
      if (!seen && local.minutes > wake + typicalDelay + lateBy && local.minutes < 12 * 60) {
        const d: Deviation = {
          id: `late_role:${role}:${local.date}`,
          kind: 'late_role',
          severity: 'low',
          role,
          score: round((local.minutes - wake - typicalDelay) / Math.max(s.robustSd, 15)),
          date: local.date,
          detectedAt: now,
          summary: `The ${ROLE_WORDS[role]} hasn't been opened since she got up.`,
          evidence: {
            expected: `Usually opened about ${Math.round(typicalDelay)} min after getting up`,
            observed: `Up since ${hhmm(wake)}, no ${ROLE_WORDS[role]} yet`,
            eventIds: [morning[0]!.e.id],
          },
        };
        push(d, offlineRoles.has(role) ? { reason: `The ${ROLE_WORDS[role]} sensor is offline` } : undefined);
      }
    }
  }

  // 3. Rare events: e.g. the front door opening at 3am.
  if (b.days >= 14) {
    const since = input.since ? Date.parse(input.since) : nowMs - 30 * 60_000;
    for (const e of past) {
      const t = Date.parse(e.at);
      if (t <= since) continue;
      const role = roleOf(h, e);
      if (!role) continue;
      const meaningful =
        e.type === 'contact_sensor_opened' || e.type === 'button_press' || (e.type === 'motion_detected' && e.subType === 'human');
      if (!meaningful) continue;
      const l = toLocal(h.timeZone, e.at);
      if (role === 'bathroom' && l.hour < 6) continue; // night trips are normal
      const p = b.hourly[role]?.[l.hour] ?? 0;
      if (p >= RARE_HOUR_PROBABILITY) continue;
      const night = l.hour < 5 || l.hour >= 23;
      const d: Deviation = {
        id: `unusual_event:${e.id}`,
        kind: 'unusual_event',
        severity: night && (role === 'frontDoor' || role === 'doorbell') ? 'high' : 'low',
        role,
        score: round(-Math.log10(Math.max(p, 1 / (b.days * 4)))),
        date: l.date,
        detectedAt: now,
        summary: `${capital(ROLE_WORDS[role])} activity at ${hhmm(l.minutes)}, which is unusual.`,
        evidence: {
          expected: `${ROLE_WORDS[role]} activity at this hour on ${Math.round(p * b.days)} of ${b.days} days`,
          observed: `${e.type.replaceAll('_', ' ')} at ${hhmm(l.minutes)}`,
          eventIds: [e.id],
        },
      };
      const entry = role === 'frontDoor' || role === 'doorbell';
      push(d, visitor && entry ? { reason: `Context: ${visitor.text}`, contextId: visitor.id } : undefined);
    }
  }

  // 4. Long inactivity during the day.
  if (morning.length > 0 && lastOpen && local.minutes < b.lastActivity.median) {
    const gap = (nowMs - Date.parse(lastOpen.at)) / 60_000;
    const limit = Math.max(1.25 * b.maxGap.p95, 180);
    const wentOut = roleOf(h, lastOpen) === 'frontDoor';
    if (gap > limit) {
      const d: Deviation = {
        id: `long_inactivity:${local.date}:${lastOpen.id}`,
        kind: 'long_inactivity',
        severity: 'high',
        score: round(gap / Math.max(b.maxGap.p95, 30)),
        date: local.date,
        detectedAt: now,
        summary: `No activity for ${Math.round(gap / 60 * 10) / 10} hours.`,
        evidence: {
          expected: `Quiet spells usually under ${Math.round(b.maxGap.p95)} min`,
          observed: `${lastOpenWords}`,
          eventIds: [lastOpen.id],
        },
      };
      let suppress: { reason: string; contextId?: string } | undefined;
      if (away) suppress = { reason: `Context: ${away.text}`, contextId: away.id };
      else if (wentOut && gap < 5 * 60) suppress = { reason: 'Last activity was the front door: probably out' };
      push(d, suppress);
    }
  }

  return result;
}

const round = (n: number) => Math.round(n * 10) / 10;
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
