import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { handleRingWebhook } from '@jirani/webhook';
import { recordRingEvent } from '../dynamo-store.ts';
import { documentClient, household, requireEnv, ringHmacKey } from '../config.ts';

/**
 * Ring webhook receiver (Lambda Function URL, no IAM auth: Ring authenticates
 * itself with the HMAC signature). Verifies the signature over the raw bytes,
 * dedupes on meta.request_id and stores the event, all well inside Ring's
 * 5-second window.
 */
const db = documentClient();
const table = requireEnv('TABLE_NAME');

export async function handler(event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> {
  if (event.requestContext.http.method !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ ok: false, error: 'method not allowed' }) };
  }
  const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '';
  const h = household();
  const result = await handleRingWebhook(raw, event.headers, {
    hmacKey: await ringHmacKey(),
    record: (requestId, e) => recordRingEvent(db, table, h.id, requestId, e),
    log: (m) => console.warn(m),
  });
  return { statusCode: result.status, headers: { 'content-type': 'application/json' }, body: JSON.stringify(result.body) };
}
