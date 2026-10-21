import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DynamoDBStreamEvent } from 'aws-lambda';
import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { weeklyReport } from '@jirani/core';
import { demoHousehold, type OutboxMessage } from '@jirani/mcp';
import { generate, PRESETS } from 'ring-routine-sim';
import { DynamoStore } from '../src/dynamo-store.ts';
import { documentClient, household } from '../src/config.ts';
import { deliverOutboxItem, emailFor, recipientsFor, sesSender, weeklyEmail, type Email } from '../src/notify.ts';
import { createTable, endpoint, useLocalAws } from './helpers.ts';

const EMAILS = 'joe=greg+joe@example.com, amina=greg+amina@example.com';
const h = household(EMAILS);
const msg = (to: string, type: OutboxMessage['type'] = 'notify_contact'): OutboxMessage => ({
  at: '2026-10-19T14:26:00.000Z',
  escalationId: 'esc:x',
  to,
  type,
  message: 'Hi Joe, it is Jirani for Margaret. Could you knock on her door?',
});

describe('who gets an email', () => {
  it('reads contact emails from JIRANI_CONTACT_EMAILS', () => {
    expect(h.contacts.map((c) => [c.id, c.email])).toEqual([
      ['joe', 'greg+joe@example.com'],
      ['amina', 'greg+amina@example.com'],
    ]);
    expect(household(undefined)).toEqual(demoHousehold());
  });

  it('emails contacts and family, never the resident', () => {
    expect(recipientsFor('joe', h)).toEqual(['greg+joe@example.com']);
    expect(recipientsFor('family', h)).toEqual(['greg+amina@example.com']);
    expect(recipientsFor('resident', h)).toEqual([]);
    expect(recipientsFor('nobody', h)).toEqual([]);
  });

  it('writes a plain email with the message, a link, and the not-a-medical-device line', () => {
    const e = emailFor(msg('joe'), h, 'https://jirani.app');
    expect(e.subject).toBe('Jirani: please check on Margaret');
    expect(e.text).toContain('Could you knock on her door?');
    expect(e.text).toContain('https://jirani.app');
    expect(e.text).toMatch(/not a medical device/);
    expect(emailFor(msg('amina', 'suggest_emergency'), h).subject).toBe('Jirani: Margaret may need help');
  });

  it('turns the weekly report into an email for family', () => {
    const events = generate(PRESETS.demo!.options).map(({ id, deviceId, type, at, subType }) => ({
      id,
      deviceId,
      type,
      at,
      ...(subType ? { subType } : {}),
    }));
    const e = weeklyEmail(weeklyReport(h, events, '2026-10-19T15:00:00.000Z'), h);
    expect(e.to).toEqual(['greg+amina@example.com']);
    expect(e.subject).toMatch(/^Jirani: Margaret's week/);
    expect(e.text).toMatch(/Night-time bathroom trips/);
    expect(e.text).toMatch(/never diagnoses/);
  });

  it('builds the SES request from the sender address', async () => {
    let input: unknown;
    const fake = { send: async (cmd: SendEmailCommand) => ((input = cmd.input), { MessageId: 'ses-1', $metadata: {} }) };
    const id = await sesSender('jirani@example.com', fake as never)({ to: ['a@example.com'], subject: 'S', text: 'T' });
    expect(id).toBe('ses-1');
    expect(input).toMatchObject({
      FromEmailAddress: 'jirani@example.com',
      Destination: { ToAddresses: ['a@example.com'] },
      Content: { Simple: { Subject: { Data: 'S' }, Body: { Text: { Data: 'T' } } } },
    });
  });
});

describe.skipIf(!endpoint)('outbox delivery (DynamoDB Local)', () => {
  const table = `jirani-notify-${Date.now()}`;
  let drop: () => Promise<unknown>;
  useLocalAws();
  const db = documentClient(endpoint);
  const sent: Email[] = [];
  let failNext = false;
  const send = async (e: Email) => {
    if (failNext) {
      failNext = false;
      throw new Error('SES is down');
    }
    sent.push(e);
    return `id-${sent.length}`;
  };

  const outboxKeys = async () => {
    const r = await db.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
        ExpressionAttributeValues: { ':pk': `HOUSE#${h.id}`, ':p': 'OUT#' },
      }),
    );
    return (r.Items ?? []).map((i) => ({ PK: i.PK as string, SK: i.SK as string }));
  };

  /** Write messages through the store, the way the ladder does, and return their new keys in order. */
  const deliverViaStore = async (...ms: OutboxMessage[]) => {
    const before = new Set((await outboxKeys()).map((k) => k.SK));
    const s = await DynamoStore.load(db, table, h);
    for (const m of ms) s.deliver(m);
    await s.flush();
    return (await outboxKeys()).filter((k) => !before.has(k.SK));
  };

  beforeAll(async () => {
    drop = await createTable(table);
    Object.assign(process.env, { TABLE_NAME: table, SENDER_EMAIL: 'jirani@example.com', JIRANI_CONTACT_EMAILS: EMAILS });
  });
  afterAll(async () => drop?.());

  it('emails a message once and marks it, even if the stream delivers it twice', async () => {
    const [key] = await deliverViaStore(msg('joe'));
    const deps = { db, table, send, household: h };
    expect(await deliverOutboxItem(deps, key!)).toMatchObject({ status: 'sent' });
    expect(await deliverOutboxItem(deps, key!)).toEqual({ status: 'skipped', reason: 'already emailed' });
    expect(sent.filter((e) => e.to[0] === 'greg+joe@example.com')).toHaveLength(1);
  });

  it('skips messages meant for the resident herself', async () => {
    const [key] = await deliverViaStore(msg('resident', 'checkin_resident'));
    expect(await deliverOutboxItem({ db, table, send, household: h }, key!)).toMatchObject({ status: 'skipped' });
    const [tone] = await deliverViaStore(msg('resident', 'chime_resident'));
    expect(await deliverOutboxItem({ db, table, send, household: h }, tone!)).toMatchObject({ status: 'skipped' });
  });

  it('stream handler: ignores other items, reports only the failed record for retry', async () => {
    const { createNotifyHandler } = await import('../src/lambda/notify.ts');
    const handler = createNotifyHandler(send);
    const [a, b] = await deliverViaStore(msg('amina', 'offer_live_view'), msg('joe', 'all_clear'));
    const record = (k: { PK: string; SK: string }, seq: string, eventName: 'INSERT' | 'MODIFY' = 'INSERT') => ({
      eventName,
      dynamodb: { Keys: { PK: { S: k.PK }, SK: { S: k.SK } }, SequenceNumber: seq },
    });
    const before = sent.length;
    failNext = true;
    const event = {
      Records: [record(a!, '1'), record(b!, '2'), record({ PK: a!.PK, SK: 'EVENT#x' }, '3'), record(a!, '4', 'MODIFY')],
    } as unknown as DynamoDBStreamEvent;

    expect(await handler(event)).toEqual({ batchItemFailures: [{ itemIdentifier: '1' }] });
    expect(sent.length - before).toBe(1);

    // The retry sends the failed one; the other was already emailed.
    expect(await handler({ Records: [record(a!, '1'), record(b!, '2')] } as unknown as DynamoDBStreamEvent)).toEqual({
      batchItemFailures: [],
    });
    expect(sent.slice(before).map((e) => e.subject)).toEqual([
      'Jirani: Margaret is OK',
      'Jirani: front-door camera available for Margaret',
    ]);
  });

  it('weekly job emails the report to family from DynamoDB', async () => {
    const { createWeeklyHandler } = await import('../src/lambda/weekly.ts');
    const before = sent.length;
    expect(await createWeeklyHandler(send)()).toEqual({ sent: true, to: ['greg+amina@example.com'] });
    expect(sent.at(-1)!.subject).toMatch(/Margaret's week/);
    expect(sent.length - before).toBe(1);
  });
});
