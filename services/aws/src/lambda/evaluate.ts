import { evaluateNow } from '@jirani/mcp';
import { withStore } from '../dynamo-store.ts';
import { documentClient, household, requireEnv } from '../config.ts';

/**
 * The rhythm engine's heartbeat, invoked by EventBridge Scheduler: detect
 * deviations, open escalations and move open ones up the ladder.
 */
const db = documentClient();
const table = requireEnv('TABLE_NAME');

export async function handler(): Promise<{ now: string; actions: number; deviations: number }> {
  const r = await withStore(db, table, household(), evaluateNow);
  for (const { action } of r.actions) if (action.type !== 'log') console.log(`${action.type} -> ${action.to ?? 'family'}`);
  return { now: r.now, actions: r.actions.length, deviations: r.deviations.length };
}
