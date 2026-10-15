import { z } from 'zod';

/**
 * Ring webhook v1.1 envelope, modelled on the public Ring Partner API docs.
 *
 * VERIFY ON DAY 1: ask the Ring Appstore MCP server
 * (https://knowledge.appstore-mcp.ring.amazon.dev/mcp) for the exact v1.1 payload
 * and contact-sensor event shape, then tighten these schemas. Everything that
 * depends on field names lives in this file and `normalise()`, so a change is local.
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
  // Contact sensors (Ring Alarm). Shape to be confirmed against the Sensors docs.
  'contact_sensor_opened',
  'contact_sensor_closed',
] as const;

export type RingEventType = (typeof RING_EVENT_TYPES)[number];

export const WebhookEnvelopeSchema = z
  .object({
    meta: z
      .object({
        version: z.string().optional(),
        request_id: z.string().min(1),
        time: z.string().optional(),
      })
      .passthrough(),
    data: z
      .object({
        type: z.string(),
        id: z.string(),
        attributes: z
          .object({
            event_type: z.string(),
            device_id: z.string(),
            timestamp: z.string(),
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
    deviceId: a.device_id,
    type: a.event_type,
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
      type: 'events',
      id: ev.id,
      attributes: {
        event_type: ev.type,
        device_id: ev.deviceId,
        timestamp: ev.at,
        ...(ev.subType ? { sub_type: ev.subType } : {}),
      },
    },
  };
}
