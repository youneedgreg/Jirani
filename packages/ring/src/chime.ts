import { z } from 'zod';
import type { RingClient } from './client.ts';

/**
 * A soft tone on a Ring Chime, following "Playing audio on a chime" in the Ring
 * Partner API docs (https://developer.amazon.com/docs/ring/api-documentation.html#playing-audio-on-a-chime).
 *
 * Not tried on a real Chime: without one the playback call is unreachable rather
 * than merely unverified, and Chime Controls is Early Access, so these names may
 * change before GA. Tests replay the documented example responses.
 *
 * Store the slot's `event` name (e.g. "ring-appstore-event-1"), never its
 * `audio_ref`: Ring says the ref can change when the user re-runs setup, so it is
 * read from the configurations each time.
 */

const StatusSchema = z.object({
  data: z.object({
    attributes: z.object({
      online: z.boolean(),
      audio: z.object({ snooze: z.object({ active: z.boolean() }).passthrough() }).passthrough().optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const ConfigurationsSchema = z.object({
  data: z.object({
    attributes: z.object({
      audio: z.object({
        customizable_slots: z.array(
          z.object({ event: z.string(), disabled: z.boolean(), audio_ref: z.string() }).passthrough(),
        ),
      }).passthrough().optional(),
    }).passthrough(),
  }).passthrough(),
}).passthrough();

const PlaybackSchema = z.object({
  data: z.object({ id: z.string(), attributes: z.object({ status: z.string() }).passthrough() }).passthrough(),
}).passthrough();

export type ChimeToneResult =
  | { status: 'played'; audioRef: string }
  | { status: 'skipped'; reason: 'offline' | 'snoozed' | 'no_slot' }
  | { status: 'not_completed'; audioRef: string; ringStatus: string };

/**
 * Play the audio in one of Jirani's slots on a chime. Skips a chime that is
 * offline or that she has snoozed in the Ring app (her choice, never overridden),
 * and a slot that is missing or disabled.
 */
export async function playChimeTone(client: RingClient, deviceId: string, slotEvent: string): Promise<ChimeToneResult> {
  const status = StatusSchema.parse(await client.getStatus(deviceId)).data.attributes;
  if (!status.online) return { status: 'skipped', reason: 'offline' };
  if (status.audio?.snooze.active) return { status: 'skipped', reason: 'snoozed' };

  const slots = ConfigurationsSchema.parse(await client.getConfigurations(deviceId)).data.attributes.audio?.customizable_slots ?? [];
  const slot = slots.find((s) => s.event === slotEvent && !s.disabled);
  if (!slot) return { status: 'skipped', reason: 'no_slot' };

  const played = PlaybackSchema.parse(await client.playChimeAudio(deviceId, slot.audio_ref)).data;
  return played.attributes.status === 'completed'
    ? { status: 'played', audioRef: played.id }
    : { status: 'not_completed', audioRef: played.id, ringStatus: played.attributes.status };
}
