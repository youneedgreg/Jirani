import { describe, expect, it } from 'vitest';
import { RingClient, playChimeTone } from '@jirani/ring';

// From the Ring Partner API docs, "Chimes" (example responses as published, 21 Oct 2026).
// Not tried on a real Chime: these are the only chime responses Jirani has seen.
const DOC_STATUS = {
  data: {
    type: 'device-status',
    id: '<status_id>',
    attributes: { online: true, audio: { snooze: { active: false, until: null } } },
  },
  meta: { time: '2026-08-17T17:11:13Z' },
};

const DOC_CONFIGURATIONS = {
  data: {
    type: 'device-configurations',
    id: '<configurations_id>',
    attributes: {
      motion_detection: { enabled: null },
      audio: {
        customizable_slots: [
          {
            event: 'ring-appstore-event-2',
            disabled: false,
            audio_ref: '4d4ec269-0bb2-4312-b7df-5e53c2e613e4',
            audio_url: 'https://ringtones-amz.ring.com/ring/appstore/9c62d803-6344-41a1-93c0-49f9331af83c.wav',
            audio_name: 'Ring Alert 3',
          },
          {
            event: 'ring-appstore-event-1',
            disabled: false,
            audio_ref: '6150f86e-2631-497c-bdef-1c5c777c10f7',
            audio_url: 'https://ringtones-amz.ring.com/ring/appstore/9fef0127-58fb-4f8e-ba87-29a85dc6db33.wav',
            audio_name: 'Navi',
          },
        ],
        volume: 4,
      },
      image_enhancements: { color_night_vision: null, hdr: null, ir_led_night_vision: null, auto_zoom_track: null },
    },
  },
  meta: { time: '2026-08-17T17:11:13Z' },
};

const DOC_PLAYBACK_REQUEST = { data: { type: 'audio', attributes: { audio_ref: '4d4ec269-0bb2-4312-b7df-5e53c2e613e4' } } };

const DOC_PLAYBACK_RESPONSE = {
  data: { type: 'audio', id: '4d4ec269-0bb2-4312-b7df-5e53c2e613e4', attributes: { status: 'completed' } },
  meta: { time: '2026-08-17T17:11:14.002266998Z' },
};

const CHIME = 'ava1.ring.device.chime';
const BASE = 'https://api.amazonvision.com';

/** A stand-in for Ring's API that answers the three chime calls and records what was asked. */
function mockRing(over: { status?: unknown; configurations?: unknown; playback?: unknown } = {}) {
  const calls: { method: string; path: string; body?: unknown; contentType: string | null }[] = [];
  const client = new RingClient({
    accessToken: 'tok',
    fetchImpl: async (url, init) => {
      const path = String(url).slice(BASE.length);
      const method = init?.method ?? 'GET';
      calls.push({
        method,
        path,
        ...(typeof init?.body === 'string' ? { body: JSON.parse(init.body) } : {}),
        contentType: new Headers(init?.headers).get('content-type'),
      });
      const routes: Record<string, unknown> = {
        [`GET /v1/devices/${CHIME}/status`]: over.status ?? DOC_STATUS,
        [`GET /v1/devices/${CHIME}/configurations`]: over.configurations ?? DOC_CONFIGURATIONS,
        [`POST /v1/devices/${CHIME}/media/audio/playback`]: over.playback ?? DOC_PLAYBACK_RESPONSE,
      };
      const body = routes[`${method} ${path}`];
      return body ? new Response(JSON.stringify(body), { status: 200 }) : new Response('not found', { status: 404 });
    },
  });
  return { client, calls };
}

const withSnooze = (active: boolean) => ({
  ...DOC_STATUS,
  data: { ...DOC_STATUS.data, attributes: { online: true, audio: { snooze: { active, until: active ? '2026-08-17T19:00:00Z' : null } } } },
});

describe('playChimeTone', () => {
  it("plays the slot's audio_ref, sending Ring's documented request", async () => {
    const { client, calls } = mockRing();
    expect(await playChimeTone(client, CHIME, 'ring-appstore-event-2')).toEqual({
      status: 'played',
      audioRef: '4d4ec269-0bb2-4312-b7df-5e53c2e613e4',
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `GET /v1/devices/${CHIME}/status`,
      `GET /v1/devices/${CHIME}/configurations`,
      `POST /v1/devices/${CHIME}/media/audio/playback`,
    ]);
    expect(calls[2]).toMatchObject({ body: DOC_PLAYBACK_REQUEST, contentType: 'application/json' });
  });

  it('finds the slot by event name, not by position (slots come unsorted)', async () => {
    const { client, calls } = mockRing({ playback: { data: { type: 'audio', id: '6150f86e-2631-497c-bdef-1c5c777c10f7', attributes: { status: 'completed' } } } });
    await playChimeTone(client, CHIME, 'ring-appstore-event-1');
    expect(calls[2]!.body).toEqual({ data: { type: 'audio', attributes: { audio_ref: '6150f86e-2631-497c-bdef-1c5c777c10f7' } } });
  });

  it('leaves a snoozed chime alone and asks nothing more of it', async () => {
    const { client, calls } = mockRing({ status: withSnooze(true) });
    expect(await playChimeTone(client, CHIME, 'ring-appstore-event-2')).toEqual({ status: 'skipped', reason: 'snoozed' });
    expect(calls).toHaveLength(1);
  });

  it('skips an offline chime', async () => {
    const { client, calls } = mockRing({ status: { data: { attributes: { online: false, audio: { snooze: { active: false, until: null } } } } } });
    expect(await playChimeTone(client, CHIME, 'ring-appstore-event-2')).toEqual({ status: 'skipped', reason: 'offline' });
    expect(calls).toHaveLength(1);
  });

  it('skips a disabled or missing slot without calling playback', async () => {
    const disabled = structuredClone(DOC_CONFIGURATIONS);
    disabled.data.attributes.audio.customizable_slots[0]!.disabled = true;
    const a = mockRing({ configurations: disabled });
    expect(await playChimeTone(a.client, CHIME, 'ring-appstore-event-2')).toEqual({ status: 'skipped', reason: 'no_slot' });
    expect(a.calls.some((c) => c.method === 'POST')).toBe(false);

    const b = mockRing();
    expect(await playChimeTone(b.client, CHIME, 'ring-appstore-event-9')).toEqual({ status: 'skipped', reason: 'no_slot' });
  });

  it('treats a device without audio slots (not a chime) as no slot', async () => {
    const { client } = mockRing({ configurations: { data: { type: 'device-configurations', id: 'c', attributes: { motion_detection: { enabled: true } } } } });
    expect(await playChimeTone(client, CHIME, 'ring-appstore-event-2')).toEqual({ status: 'skipped', reason: 'no_slot' });
  });

  it('reports a playback status other than completed instead of calling it played', async () => {
    const { client } = mockRing({ playback: { data: { type: 'audio', id: '4d4ec269-0bb2-4312-b7df-5e53c2e613e4', attributes: { status: 'failed' } } } });
    expect(await playChimeTone(client, CHIME, 'ring-appstore-event-2')).toEqual({
      status: 'not_completed',
      audioRef: '4d4ec269-0bb2-4312-b7df-5e53c2e613e4',
      ringStatus: 'failed',
    });
  });

  it('passes Ring errors through as RingApiError', async () => {
    const client = new RingClient({ accessToken: 'tok', fetchImpl: async () => new Response('forbidden', { status: 403 }) });
    await expect(playChimeTone(client, CHIME, 'ring-appstore-event-2')).rejects.toMatchObject({ status: 403 });
  });
});
