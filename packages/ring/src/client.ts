/**
 * Minimal typed client for the Ring Partner API (Amazon Vision API).
 * Base URL and endpoints from https://developer.amazon.com/docs/ring/api-documentation.html
 *
 * Calls must be server-to-server: Ring's endpoints block browser (CORS) requests.
 * For the hackathon, the token comes from the Ring Developer Playground and
 * expires after ~30 minutes.
 */
export const RING_API_BASE = 'https://api.amazonvision.com';

export interface JsonApiResource<A = Record<string, unknown>> {
  type: string;
  id: string;
  attributes?: A;
  relationships?: Record<string, unknown>;
}

export interface JsonApiDocument<A = Record<string, unknown>> {
  data: JsonApiResource<A> | JsonApiResource<A>[];
  included?: JsonApiResource[];
  meta?: Record<string, unknown>;
}

export class RingApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    public readonly retryAfterSeconds?: number,
  ) {
    super(`Ring API ${status}: ${body.slice(0, 200)}`);
  }
}

export interface RingClientOptions {
  accessToken: string | (() => Promise<string>);
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export class RingClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: RingClientOptions) {
    this.baseUrl = opts.baseUrl ?? RING_API_BASE;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private async token(): Promise<string> {
    const t = this.opts.accessToken;
    return typeof t === 'string' ? t : t();
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${await this.token()}`,
        ...(init.body && typeof init.body === 'string' && !init.headers
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...(init.headers as Record<string, string> | undefined),
      },
    });
    if (!res.ok) {
      const retry = res.headers.get('retry-after');
      throw new RingApiError(res.status, await res.text(), retry ? Number(retry) : undefined);
    }
    return res;
  }

  private async json<T>(path: string, init?: RequestInit): Promise<T> {
    return (await this.request(path, init)).json() as Promise<T>;
  }

  /** GET /v1/devices?include=status,capabilities,location,configurations */
  listDevices(include: string[] = ['status', 'capabilities']): Promise<JsonApiDocument> {
    const q = include.length ? `?include=${include.join(',')}` : '';
    return this.json(`/v1/devices${q}`);
  }

  getDevice(deviceId: string): Promise<JsonApiDocument> {
    return this.json(`/v1/devices/${encodeURIComponent(deviceId)}`);
  }

  getStatus(deviceId: string): Promise<JsonApiDocument> {
    return this.json(`/v1/devices/${encodeURIComponent(deviceId)}/status`);
  }

  getCapabilities(deviceId: string): Promise<JsonApiDocument> {
    return this.json(`/v1/devices/${encodeURIComponent(deviceId)}/capabilities`);
  }

  getEventHistory(deviceId: string): Promise<JsonApiDocument> {
    return this.json(`/v1/history/devices/${encodeURIComponent(deviceId)}/events`);
  }

  getMe(): Promise<JsonApiDocument> {
    return this.json('/v1/users/me');
  }

  /**
   * Start a WebRTC WHEP live view. Send the browser's SDP offer, get the SDP answer.
   * The `Location` header identifies the session so it can be closed later.
   */
  async startLiveView(deviceId: string, sdpOffer: string): Promise<{ sdpAnswer: string; sessionUrl: string | null }> {
    const res = await this.request(
      `/v1/devices/${encodeURIComponent(deviceId)}/media/streaming/whep/sessions`,
      { method: 'POST', body: sdpOffer, headers: { 'Content-Type': 'application/sdp' } },
    );
    return { sdpAnswer: await res.text(), sessionUrl: res.headers.get('location') };
  }

  async stopLiveView(deviceId: string, sessionId: string): Promise<void> {
    await this.request(
      `/v1/devices/${encodeURIComponent(deviceId)}/media/streaming/whep/sessions/${encodeURIComponent(sessionId)}`,
      { method: 'DELETE' },
    );
  }
}
