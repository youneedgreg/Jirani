import { describe, expect, it } from 'vitest';
import {
  RingClient,
  RingApiError,
  buildEnvelope,
  normalise,
  parseWebhook,
  signBody,
  verifySignature,
  type HouseEvent,
} from '@jirani/ring';

const KEY = 'test-hmac-key';
const ev: HouseEvent = {
  id: 'evt_1',
  requestId: 'req_1',
  deviceId: 'ava1.ring.device.front',
  type: 'motion_detected',
  subType: 'human',
  at: '2026-10-12T07:40:00.000Z',
};

describe('signature', () => {
  it('verifies a body it signed', () => {
    const body = JSON.stringify(buildEnvelope(ev));
    expect(verifySignature(body, signBody(body, KEY), KEY)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = JSON.stringify(buildEnvelope(ev));
    const sig = signBody(body, KEY);
    expect(verifySignature(body.replace('human', 'animal'), sig, KEY)).toBe(false);
  });

  it('rejects the wrong key, missing header and wrong prefix', () => {
    const body = '{}';
    expect(verifySignature(body, signBody(body, 'other'), KEY)).toBe(false);
    expect(verifySignature(body, undefined, KEY)).toBe(false);
    expect(verifySignature(body, signBody(body, KEY).replace('sha256=', 'sha1='), KEY)).toBe(false);
  });

  it('uses hex with the sha256= prefix', () => {
    expect(signBody('x', KEY)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });
});

describe('webhook envelope', () => {
  it('round-trips an event', () => {
    const parsed = parseWebhook(JSON.stringify(buildEnvelope(ev)));
    expect(normalise(parsed)).toEqual(ev);
  });

  it('keeps unknown fields instead of crashing', () => {
    const env = buildEnvelope(ev) as Record<string, any>;
    env.data.attributes.new_field = 42;
    expect(() => parseWebhook(JSON.stringify(env))).not.toThrow();
  });

  it('rejects a payload without request_id', () => {
    const env = buildEnvelope(ev) as Record<string, any>;
    delete env.meta.request_id;
    expect(() => parseWebhook(JSON.stringify(env))).toThrow();
  });
});

describe('RingClient', () => {
  it('sends the bearer token and include list', async () => {
    let seen: { url: string; auth: string | null } | undefined;
    const client = new RingClient({
      accessToken: 'tok',
      fetchImpl: async (url, init) => {
        seen = { url: String(url), auth: new Headers(init?.headers).get('authorization') };
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      },
    });
    await client.listDevices(['status']);
    expect(seen).toEqual({ url: 'https://api.amazonvision.com/v1/devices?include=status', auth: 'Bearer tok' });
  });

  it('surfaces Retry-After on 429', async () => {
    const client = new RingClient({
      accessToken: 'tok',
      fetchImpl: async () => new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }),
    });
    await expect(client.getMe()).rejects.toMatchObject({ status: 429, retryAfterSeconds: 3 });
    await expect(client.getMe()).rejects.toBeInstanceOf(RingApiError);
  });
});
