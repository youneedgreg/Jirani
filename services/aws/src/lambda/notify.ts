import type { DynamoDBBatchResponse, DynamoDBStreamEvent } from 'aws-lambda';
import { deliverOutboxItem, sesSender, type SendEmail } from '../notify.ts';
import { documentClient, household, requireEnv } from '../config.ts';
import { reportError, withSentry } from '../sentry.ts';

/**
 * Emails each new outbox message (DynamoDB Stream, INSERTs of OUT# items only;
 * the filter is on the event source mapping). Failed records are reported
 * individually so only they are retried.
 */
export function createNotifyHandler(send: SendEmail) {
  const db = documentClient();
  const table = requireEnv('TABLE_NAME');
  const dashboardUrl = process.env.DASHBOARD_URL;

  return async (event: DynamoDBStreamEvent): Promise<DynamoDBBatchResponse> => {
    const h = household();
    const failures: DynamoDBBatchResponse['batchItemFailures'] = [];
    for (const record of event.Records) {
      const PK = record.dynamodb?.Keys?.PK?.S;
      const SK = record.dynamodb?.Keys?.SK?.S;
      if (record.eventName !== 'INSERT' || !PK || !SK?.startsWith('OUT#')) continue;
      try {
        const r = await deliverOutboxItem({ db, table, send, household: h, ...(dashboardUrl ? { dashboardUrl } : {}) }, { PK, SK });
        console.log(JSON.stringify({ SK, ...r }));
      } catch (err) {
        console.error(`delivery failed for ${SK}`, err);
        reportError(err);
        if (record.dynamodb?.SequenceNumber) failures.push({ itemIdentifier: record.dynamodb.SequenceNumber });
      }
    }
    return { batchItemFailures: failures };
  };
}

export const handler = withSentry(createNotifyHandler(sesSender(requireEnv('SENDER_EMAIL'))));
