import { weeklyReport } from '@jirani/core';
import { DynamoStore } from '../dynamo-store.ts';
import { sesSender, weeklyEmail, type SendEmail } from '../notify.ts';
import { documentClient, household, requireEnv } from '../config.ts';

/** The weekly rhythm report, emailed to family (EventBridge Scheduler, once a week). */
export function createWeeklyHandler(send: SendEmail) {
  const db = documentClient();
  const table = requireEnv('TABLE_NAME');

  return async (): Promise<{ sent: boolean; to: string[] }> => {
    const h = household();
    const store = await DynamoStore.load(db, table, h);
    const s = store.state();
    const email = weeklyEmail(weeklyReport(h, s.events, store.now(), s.contexts), h, process.env.DASHBOARD_URL);
    if (email.to.length === 0) {
      console.warn('No family email addresses configured (JIRANI_CONTACT_EMAILS); weekly report not sent.');
      return { sent: false, to: [] };
    }
    await send(email);
    return { sent: true, to: email.to };
  };
}

export const handler = createWeeklyHandler(sesSender(requireEnv('SENDER_EMAIL')));
