import { evaluate, type Evaluation } from '@jirani/core';
import type { Store } from './store.ts';

/**
 * Run one evaluation against the store and "deliver" whatever the ladder decided.
 * Locally this runs on a timer; in AWS, EventBridge Scheduler triggers it.
 */
export function runEvaluation(store: Store): Evaluation {
  const now = store.now();
  const ev = evaluate(store.state(), now);
  store.setEscalations(ev.escalations, now);
  for (const { escalationId, action } of ev.actions) {
    if (action.type === 'log') continue;
    store.deliver({ at: now, escalationId, to: action.to ?? 'family', type: action.type, message: action.message });
  }
  return ev;
}
