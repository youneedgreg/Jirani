import type { Deviation } from './deviations.ts';
import type { Contact, Household } from './types.ts';

/**
 * The ask-her-first ladder, as a pure state machine. It decides; a runtime
 * (Lambda + EventBridge Scheduler, or the local demo) executes the actions.
 *
 *   0  logged         small deviation, nobody is told
 *   1  check-in       ask the resident herself (voice + TV)
 *   2  neighbour      ask a neighbour to knock
 *   3  family         family gets the evidence (+ live view only with consent)
 *   4  emergency      suggest calling emergency services; a human decides
 */
export type Level = 0 | 1 | 2 | 3 | 4;

export type ActionType =
  | 'log'
  | 'checkin_resident'
  | 'notify_contact'
  | 'offer_live_view'
  | 'suggest_emergency'
  | 'all_clear';

export interface Action {
  type: ActionType;
  to?: string;
  message: string;
}

export interface LadderStep {
  at: string;
  level: Level;
  actions: Action[];
  note?: string;
}

export interface Escalation {
  id: string;
  deviationId: string;
  householdId: string;
  summary: string;
  level: Level;
  status: 'open' | 'resolved' | 'logged';
  openedAt: string;
  levelSince: string;
  history: LadderStep[];
  resolution?: { at: string; by: string; note: string };
}

export interface LadderConfig {
  /** Minutes to wait at a level before moving up. */
  waitMinutes: { 1: number; 2: number };
}

export const DEFAULT_LADDER: LadderConfig = { waitMinutes: { 1: 20, 2: 20 } };

const byPriority = (a: Contact, b: Contact) => a.priority - b.priority;
const neighbours = (h: Household) => h.contacts.filter((c) => c.relation === 'neighbour').sort(byPriority);
const family = (h: Household) => h.contacts.filter((c) => c.relation === 'family').sort(byPriority);

export function openEscalation(d: Deviation, h: Household, now: string): Escalation {
  const base = {
    id: `esc:${d.id}`,
    deviationId: d.id,
    householdId: h.id,
    summary: d.summary,
    openedAt: now,
    levelSince: now,
  };
  if (d.severity === 'low') {
    return {
      ...base,
      level: 0,
      status: 'logged',
      history: [{ at: now, level: 0, actions: [{ type: 'log', message: d.summary }] }],
    };
  }
  return {
    ...base,
    level: 1,
    status: 'open',
    history: [{ at: now, level: 1, actions: [checkin(h)] }],
  };
}

function checkin(h: Household): Action {
  return {
    type: 'checkin_resident',
    to: 'resident',
    message: `Good morning ${h.residentName}, it's Jirani. Just checking you're alright. You can say "I'm fine", or press OK on your TV.`,
  };
}

function escalateTo(e: Escalation, level: Level, actions: Action[], now: string, note?: string): Escalation {
  return {
    ...e,
    level,
    levelSince: now,
    history: [...e.history, { at: now, level, actions, ...(note ? { note } : {}) }],
  };
}

function familyStep(e: Escalation, h: Household, now: string, note?: string): Escalation {
  const actions: Action[] = family(h).map((c) => ({
    type: 'notify_contact',
    to: c.id,
    message: `${h.residentName}: ${e.summary} She hasn't answered a check-in${neighbours(h).length ? ' and the neighbour couldn\'t confirm she\'s OK' : ''}. Open Jirani to see the timeline.`,
  }));
  if (h.consent.liveViewAtLevel3) {
    actions.push({ type: 'offer_live_view', message: `${h.residentName} has agreed that family can look at the front-door camera at this point.` });
  }
  return escalateTo(e, 3, actions, now, note);
}

/** Move up the ladder when a level has waited long enough. */
export function tick(e: Escalation, h: Household, now: string, cfg: LadderConfig = DEFAULT_LADDER): Escalation {
  if (e.status !== 'open') return e;
  const waited = (Date.parse(now) - Date.parse(e.levelSince)) / 60_000;

  if (e.level === 1 && waited >= cfg.waitMinutes[1]) {
    const n = neighbours(h)[0];
    if (!n) return familyStep(e, h, now, 'No neighbour on file, so going straight to family');
    return escalateTo(
      e,
      2,
      [
        {
          type: 'notify_contact',
          to: n.id,
          message: `Hi ${n.name}, it's Jirani for ${h.residentName}. ${e.summary} She hasn't answered a check-in. Could you knock on her door and reply OK or PROBLEM?`,
        },
      ],
      now,
    );
  }
  if (e.level === 2 && waited >= cfg.waitMinutes[2]) {
    return familyStep(e, h, now, 'Neighbour did not reply in time');
  }
  return e;
}

/**
 * Activity turned up after an absence alert opened (often events that arrived late):
 * close it, and tell whoever was already asked so nobody goes knocking for nothing.
 */
export function closeOnActivity(e: Escalation, h: Household, seen: string, now: string): Escalation {
  if (e.status !== 'open') return e;
  const informed = new Set(e.history.flatMap((s) => s.actions.filter((a) => a.type === 'notify_contact').map((a) => a.to!)));
  const allClear: Action[] = [...informed].map((id) => ({
    type: 'all_clear',
    to: id,
    message: `Update from Jirani: activity has now been recorded at ${h.residentName}'s home (${seen}), so this alert is closed.`,
  }));
  const note = `Activity recorded: ${seen}`;
  return {
    ...e,
    status: 'resolved',
    history: [...e.history, { at: now, level: e.level, actions: allClear, note }],
    resolution: { at: now, by: 'Jirani', note },
  };
}

export interface Response {
  from: 'resident' | 'contact';
  contactId?: string;
  outcome: 'ok' | 'problem' | 'no_answer';
  note?: string;
}

export function respond(e: Escalation, h: Household, r: Response, now: string): Escalation {
  if (e.status !== 'open') return e;
  const who =
    r.from === 'resident' ? h.residentName : (h.contacts.find((c) => c.id === r.contactId)?.name ?? 'a contact');

  if (r.outcome === 'ok') {
    const informed = new Set(e.history.flatMap((s) => s.actions.filter((a) => a.type === 'notify_contact').map((a) => a.to!)));
    informed.delete(r.contactId ?? '');
    const allClear: Action[] = [...informed].map((id) => ({
      type: 'all_clear',
      to: id,
      message: `All good: ${who} confirmed ${h.residentName} is OK.${r.note ? ` "${r.note}"` : ''}`,
    }));
    return {
      ...e,
      status: 'resolved',
      history: [...e.history, { at: now, level: e.level, actions: allClear, note: `Resolved by ${who}` }],
      resolution: { at: now, by: who, note: r.note ?? 'OK' },
    };
  }

  if (r.outcome === 'no_answer') {
    return e.level < 3 ? familyStep(e, h, now, `${who} got no answer`) : e;
  }

  // problem
  const actions: Action[] = family(h).map((c) => ({
    type: 'suggest_emergency',
    to: c.id,
    message: `${who} reports a problem with ${h.residentName}${r.note ? `: "${r.note}"` : ''}. If you think she needs help, call 911. Jirani will not call for you.`,
  }));
  return escalateTo(e, 4, actions, now, `${who} reported a problem`);
}
