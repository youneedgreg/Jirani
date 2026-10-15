import type { CoreEvent } from '@jirani/core';
import { SIGNATURE_HEADER, normalise, parseWebhook, verifySignature } from '@jirani/ring';

/**
 * Framework-agnostic Ring webhook handler. Runs the same in Express locally and
 * in AWS Lambda (Function URL) in production.
 *
 * Ring's rules: verify the HMAC over the raw body, answer 2xx within 5 seconds,
 * and treat meta.request_id as the idempotency key (Ring retries).
 */
export interface WebhookDeps {
  hmacKey: string;
  /** Returns false if this request_id was already processed. */
  remember(requestId: string): Promise<boolean> | boolean;
  save(event: CoreEvent): Promise<void> | void;
  log?: (msg: string) => void;
}

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
  try {
    const n = normalise(parseWebhook(rawBody));
    event = { id: n.id, deviceId: n.deviceId, type: n.type, at: n.at, ...(n.subType ? { subType: n.subType } : {}) };
    if (!(await deps.remember(n.requestId))) {
      return { status: 200, body: { ok: true, duplicate: true, eventId: n.id } };
    }
  } catch (err) {
    deps.log?.(`rejected webhook: ${err instanceof Error ? err.message : String(err)}`);
    // 2xx on a malformed-but-authentic body stops Ring retrying something that will never parse.
    return { status: 202, body: { ok: false, error: 'unparseable payload' } };
  }

  await deps.save(event);
  return { status: 200, body: { ok: true, eventId: event.id } };
}
