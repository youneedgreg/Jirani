import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Escalation } from '@jirani/core';
import { demoHousehold } from '@jirani/mcp';
import { DynamoStore, StoreConflictError, recordRingEvent, withStore } from '../src/dynamo-store.ts';
import { documentClient } from '../src/config.ts';
import { createTable, endpoint, useLocalAws } from './helpers.ts';

// Runs against DynamoDB Local: docker run -p 8000:8000 amazon/dynamodb-local, then DYNAMODB_ENDPOINT=http://localhost:8000
describe.skipIf(!endpoint)('DynamoStore (DynamoDB Local)', () => {
  const table = `jirani-store-${Date.now()}`;
  const h = demoHousehold();
  let drop: () => Promise<unknown>;
  useLocalAws();
  const db = documentClient(endpoint);

  beforeAll(async () => {
    drop = await createTable(table);
  });
  afterAll(async () => drop?.());

  const event = (id: string, at: string) => ({ id, deviceId: 'dev-fridge', type: 'contact_open', at });
  const escalation = (id: string, level: Escalation['level']): Escalation => ({
    id,
    deviationId: id.slice(4),
    householdId: h.id,
    summary: 'No morning activity yet.',
    level,
    status: 'open',
    openedAt: '2026-10-19T14:05:00.000Z',
    levelSince: '2026-10-19T14:05:00.000Z',
    history: [{ at: '2026-10-19T14:05:00.000Z', level, actions: [] }],
  });

  it('records a webhook event once per request_id', async () => {
    const e = event('ev-1', '2026-10-19T12:00:00.000Z');
    expect(await recordRingEvent(db, table, h.id, 'req-1', e)).toBe(true);
    expect(await recordRingEvent(db, table, h.id, 'req-1', e)).toBe(false);
    const s = await DynamoStore.load(db, table, h);
    expect(s.state().events.filter((x) => x.id === 'ev-1')).toHaveLength(1);
  });

  it('round-trips state and writes only what changed', async () => {
    const s = await DynamoStore.load(db, table, h);
    s.setClock('2026-10-19T15:00:00.000Z');
    s.addContext({
      id: 'ctx-1',
      kind: 'away',
      text: "At my sister's",
      startsAt: '2026-10-17T12:00:00.000Z',
      endsAt: '2026-10-18T23:00:00.000Z',
      createdBy: 'resident',
      createdAt: '2026-10-15T22:00:00.000Z',
    });
    s.setPause({ until: '2026-10-19T17:00:00.000Z', by: 'resident' });
    s.setEscalations([escalation('esc:a', 1)], '2026-10-19T15:00:00.000Z');
    s.deliver({ at: '2026-10-19T15:00:00.000Z', escalationId: 'esc:a', to: 'resident', type: 'checkin_resident', message: 'Hi Margaret' });
    expect(await s.flush()).toBe(6);

    const r = await DynamoStore.load(db, table, h);
    expect(r.now()).toBe('2026-10-19T15:00:00.000Z');
    expect(r.state()).toMatchObject({
      contexts: [{ id: 'ctx-1' }],
      escalations: [{ id: 'esc:a', level: 1 }],
      pause: { until: '2026-10-19T17:00:00.000Z' },
      lastEvaluatedAt: '2026-10-19T15:00:00.000Z',
    });
    expect(r.state().events.map((e) => e.id)).toContain('ev-1');
    expect(r.outbox()).toEqual([expect.objectContaining({ message: 'Hi Margaret' })]);
    expect(r.pendingWrites()).toHaveLength(0);

    r.setPause(undefined);
    r.setClock(null);
    expect(await r.flush()).toBe(2);
    const cleared = await DynamoStore.load(db, table, h);
    expect(cleared.state().pause).toBeUndefined();
    expect(cleared.now()).not.toBe('2026-10-19T15:00:00.000Z');
  });

  it('keeps messages sent at the same instant in the order they were sent', async () => {
    const s = await DynamoStore.load(db, table, h);
    const at = '2026-10-19T14:47:00.000Z';
    const order = ['amina', 'family', 'joe', 'resident', 'amina2', 'family2'];
    for (const to of order) s.deliver({ at, escalationId: 'esc:order', to, type: 'notify_contact', message: to });
    await s.flush();
    const r = await DynamoStore.load(db, table, h);
    expect(r.outbox().filter((m) => m.at === at).map((m) => m.to)).toEqual(order);
  });

  it('loads only the event window before the clock', async () => {
    await recordRingEvent(db, table, h.id, 'req-old', event('ev-old', '2026-08-01T12:00:00.000Z'));
    const s = await DynamoStore.load(db, table, h);
    s.setClock('2026-10-19T15:00:00.000Z');
    await s.flush();
    const r = await DynamoStore.load(db, table, h);
    expect(r.state().events.map((e) => e.id)).not.toContain('ev-old');
    r.setClock(null);
    await r.flush();
  });

  it('refuses a stale escalation write instead of overwriting it', async () => {
    const a = await DynamoStore.load(db, table, h);
    const b = await DynamoStore.load(db, table, h);
    a.setEscalations([{ ...escalation('esc:a', 1), status: 'resolved' }], '2026-10-19T15:10:00.000Z');
    b.setEscalations([escalation('esc:a', 2)], '2026-10-19T15:10:00.000Z');
    await a.flush();
    await expect(b.flush()).rejects.toBeInstanceOf(StoreConflictError);
    const r = await DynamoStore.load(db, table, h);
    expect(r.state().escalations[0]).toMatchObject({ status: 'resolved', level: 1 });
  });

  it('withStore re-runs the work on fresh data after a conflict', async () => {
    let runs = 0;
    const level = await withStore(db, table, h, async (s) => {
      runs++;
      if (runs === 1) {
        // Someone else moves the alert while this request is working.
        const other = await DynamoStore.load(db, table, h);
        other.setEscalations([{ ...escalation('esc:a', 3), status: 'resolved' }], '2026-10-19T15:20:00.000Z');
        await other.flush();
      }
      const e = s.state().escalations[0]!;
      s.setEscalations([{ ...e, summary: `${e.summary} (seen)` }], '2026-10-19T15:21:00.000Z');
      return e.level;
    });
    expect(runs).toBe(2);
    expect(level).toBe(3);
  });

  it('splits more than 100 writes into several transactions', async () => {
    const s = await DynamoStore.load(db, table, h);
    const many = Array.from({ length: 130 }, (_, i) => ({ ...escalation(`esc:bulk-${i}`, 0), status: 'logged' as const }));
    s.setEscalations([...s.state().escalations, ...many], '2026-10-19T16:00:00.000Z');
    expect(await s.flush()).toBe(131);
    expect((await DynamoStore.load(db, table, h)).state().escalations).toHaveLength(131);
  });
});
