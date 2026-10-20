import { roleOf } from './baseline.ts';
import { ROLE_WORDS } from './deviations.ts';
import { hhmm, toLocal } from './time.ts';
import type { CoreEvent, Household, Role } from './types.ts';

export interface TimelineItem {
  at: string;
  /** Local "7:12am". */
  time: string;
  role: Role;
  text: string;
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * One event in plain words, or null when it isn't worth showing a family member
 * (a door closing, a car going past the doorbell camera).
 */
export function describeEvent(h: Household, e: CoreEvent): string | null {
  const role = roleOf(h, e);
  if (!role) return null;
  const thing = ROLE_WORDS[role];
  switch (e.type) {
    case 'contact_sensor_faulted':
      return role === 'doorbell' ? null : `${capital(thing)} opened`;
    case 'button_press':
      return 'Doorbell pressed';
    case 'motion_detected':
      return e.subType === 'human' ? 'Someone at the front door' : null;
    case 'device_offline':
      return `${capital(thing)} sensor went offline`;
    case 'device_online':
      return `${capital(thing)} sensor back online`;
    default:
      return null;
  }
}

/** Today's events (household time), oldest first, up to `now`. */
export function todayTimeline(h: Household, events: CoreEvent[], now: string): { date: string; items: TimelineItem[] } {
  const nowMs = Date.parse(now);
  const date = toLocal(h.timeZone, now).date;
  const items: TimelineItem[] = [];
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (Date.parse(e.at) > nowMs) continue;
    const l = toLocal(h.timeZone, e.at);
    if (l.date !== date) continue;
    const text = describeEvent(h, e);
    if (text) items.push({ at: e.at, time: hhmm(l.minutes), role: roleOf(h, e)!, text });
  }
  return { date, items };
}
