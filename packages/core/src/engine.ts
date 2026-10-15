import { buildBaseline, type Baseline } from './baseline.ts';
import { detect, type DetectionResult } from './deviations.ts';
import { DEFAULT_LADDER, openEscalation, tick, type Action, type Escalation, type LadderConfig } from './escalation.ts';
import type { ContextNote, CoreEvent, Household, Pause } from './types.ts';

export interface JiraniState {
  household: Household;
  events: CoreEvent[];
  contexts: ContextNote[];
  escalations: Escalation[];
  pause?: Pause;
  lastEvaluatedAt?: string;
}

export interface Evaluation extends DetectionResult {
  baseline: Baseline;
  escalations: Escalation[];
  /** Actions created by this evaluation, for the runtime to execute. */
  actions: { escalationId: string; action: Action }[];
  paused: boolean;
}

/**
 * One evaluation pass: learn the baseline, detect deviations, open escalations for
 * new ones, and move open escalations up the ladder. Pure: returns new state.
 */
export function evaluate(state: JiraniState, now: string, cfg: LadderConfig = DEFAULT_LADDER): Evaluation {
  const h = state.household;
  const baseline = buildBaseline(h, state.events, { now, contexts: state.contexts });
  const detection = detect({
    household: h,
    events: state.events,
    baseline,
    contexts: state.contexts,
    now,
    ...(state.lastEvaluatedAt ? { since: state.lastEvaluatedAt } : {}),
  });

  const paused = !!state.pause && Date.parse(state.pause.until) > Date.parse(now);
  const actions: Evaluation['actions'] = [];
  const known = new Set(state.escalations.map((e) => e.deviationId));
  let escalations = [...state.escalations];

  if (paused) {
    // She paused Jirani herself, so she is evidently fine: close what's open.
    escalations = escalations.map((e) =>
      e.status === 'open'
        ? { ...e, status: 'resolved' as const, resolution: { at: now, by: h.residentName, note: 'Paused monitoring herself' } }
        : e,
    );
  } else {
    for (const d of detection.deviations) {
      if (known.has(d.id)) continue;
      const e = openEscalation(d, h, now);
      escalations.push(e);
      for (const a of e.history[0]!.actions) actions.push({ escalationId: e.id, action: a });
    }
    escalations = escalations.map((e) => {
      const next = tick(e, h, now, cfg);
      if (next !== e && next.history.length > e.history.length) {
        for (const a of next.history.at(-1)!.actions) actions.push({ escalationId: next.id, action: a });
      }
      return next;
    });
  }

  return { ...detection, baseline, escalations, actions, paused };
}
