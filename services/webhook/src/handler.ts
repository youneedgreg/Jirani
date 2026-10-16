import type { CoreEvent } from '@jirani/core';
import { SIGNATURE_HEADER, normalise, parseWebhook, verifySignature } from '@jirani/ring';

/**
 * Framework-agnostic Ring webhook handler. Runs the same in Express locally and
 * in AWS Lambda (Function URL) in production.
 *
 * Ring's rules: verify the HMAC over the raw body, answer 2xx within 5 seconds,
 * and treat meta.request_id as the idempotency key (Ring retries).
 */
interface WebhookDepsBase {
  hmacKey: string;
  log?: (msg: string) => void;
}

export type WebhookDeps = WebhookDepsBase &
  (
    | {
        /** Returns false if this request_id was already processed. */
        remember(requestId: string): Promise<boolean> | boolean;
        save(event: CoreEvent): Promise<void> | void;
        record?: never;
      }
    | {
        /**
         * Atomic alternative to remember + save: store the event only if this
         * request_id is new, in one step. Returns false for a duplicate. DynamoDB
         * uses this so a crash between two writes can't swallow an event on Ring's retry.
         */
        record(requestId: string, event: CoreEvent): Promise<boolean>;
        remember?: never;
        save?: never;
      }
  );

export interface WebhookResult {
  status: number;
  body: { ok: boolean; duplicate?: boolean; error?: string; eventId?: string };
}

export async function handleRingWebhook(
  rawBody: string,
  headers: Record<string, string | string[] | undefined>,
  deps: WebhookDeps,
): Promise<WebhookResult> {
  const sigHeader = headers[SIGNATURE_HEADER] ?? headers['X-Signature'];
  const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
  if (!verifySignature(rawBody, signature, deps.hmacKey)) {
    deps.log?.('rejected webhook: bad signature');
    return { status: 401, body: { ok: false, error: 'invalid signature' } };
  }

  let event: CoreEvent;
  let requestId: string;
  try {
    const n = normalise(parseWebhook(rawBody));
    event = { id: n.id, deviceId: n.deviceId, type: n.type, at: n.at, ...(n.subType ? { subType: n.subType } : {}) };
    requestId = n.requestId;
  } catch (err) {
    deps.log?.(`rejected webhook: ${err instanceof Error ? err.message : String(err)}`);
    // 2xx on a malformed-but-authentic body stops Ring retrying something that will never parse.
    return { status: 202, body: { ok: false, error: 'unparseable payload' } };
  }

  let isNew: boolean;
  if (deps.record) {
    isNew = await deps.record(requestId, event);
  } else if (deps.remember && deps.save) {
    isNew = await deps.remember(requestId);
    if (isNew) await deps.save(event);
  } else {
    throw new Error('WebhookDeps needs record, or remember and save');
  }
  if (!isNew) return { status: 200, body: { ok: true, duplicate: true, eventId: event.id } };
  return { status: 200, body: { ok: true, eventId: event.id } };
}
