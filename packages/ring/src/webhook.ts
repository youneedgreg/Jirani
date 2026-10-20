import { z } from 'zod';

/**
 * Ring webhook v1.1 envelope, as documented in the Ring Partner API docs
 * (https://developer.amazon.com/docs/ring/api-documentation.html#webhook-v11-payload-structure
 * and #sensor-events). Route on `data.type`, read the device from
 * `data.attributes.source`; `timestamp` is Unix epoch milliseconds.
 *
 * Sensor events are Early Access in Ring's docs, so names may change before GA.
 * Everything that depends on field names lives in this file and `normalise()`.
 *
 * Unknown fields pass through so a newer payload never crashes the receiver.
 */

export const RING_EVENT_TYPES = [
  'motion_detected',
  'button_press',
  'device_added',
  'device_removed',
  'device_online',
  'device_offline',
  'app_integration_added',
  'app_integration_removed',
  'subscription_activated',
  'subscription_deactivated',
  // Contact sensors (Ring Alarm). Ring's naming: "faulted" = contact open, "cleared" = closed.
  'contact_sensor_faulted',
  'contact_sensor_cleared',
  'tamper_detected',
  'tamper_cleared',
] as const;

export type RingEventType = (typeof RING_EVENT_TYPES)[number];

export const WebhookEnvelopeSchema = z
  .object({
    meta: z
      .object({
        version: z.string().optional(),
        request_id: z.string().min(1),
        time: z.string().optional(),
        account_id: z.string().optional(),
      })
      .passthrough(),
    data: z
      .object({
        type: z.string().min(1),
        id: z.string(),
        attributes: z
          .object({
            source: z.string().min(1),
            source_type: z.string().optional(),
            // Ring sends epoch milliseconds; accept an ISO string too, as Amazon's sample app does.
            timestamp: z.union([z.number(), z.string()]),
            sub_type: z.string().optional(),
            component_ids: z.array(z.string()).optional(),
          })
          .passthrough(),
      })
      .passthrough(),
  })
  .passthrough();

export type WebhookEnvelope = z.infer<typeof WebhookEnvelopeSchema>;

/** Jirani's internal event: the only shape the rest of the system sees. */
export interface HouseEvent {
  id: string;
  requestId: string;
  deviceId: string;
  type: RingEventType | (string & {});
  subType?: string;
  /** ISO 8601 */
  at: string;
}

export function parseWebhook(rawBody: string): WebhookEnvelope {
  return WebhookEnvelopeSchema.parse(JSON.parse(rawBody));
}

export function normalise(envelope: WebhookEnvelope): HouseEvent {
  const a = envelope.data.attributes;
  const ev: HouseEvent = {
    id: envelope.data.id,
    requestId: envelope.meta.request_id,
    deviceId: a.source,
    type: envelope.data.type,
    at: new Date(a.timestamp).toISOString(),
  };
  if (a.sub_type) ev.subType = a.sub_type;
  return ev;
}

/** Build a Ring-shaped envelope. Used by ring-routine-sim and tests. */
export function buildEnvelope(ev: HouseEvent): WebhookEnvelope {
  return {
    meta: { version: '1.1', request_id: ev.requestId, time: ev.at },
    data: {
      type: ev.type,
      id: ev.id,
      attributes: {
        source: ev.deviceId,
        source_type: 'devices',
        timestamp: Date.parse(ev.at),
        ...(ev.subType ? { sub_type: ev.subType } : {}),
      },
      relationships: { devices: { links: { self: `/v1/devices/${ev.deviceId}` } } },
    },
  };
}
