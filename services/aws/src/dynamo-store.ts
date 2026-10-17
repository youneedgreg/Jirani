import { randomUUID } from 'node:crypto';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { TransactionCanceledException } from '@aws-sdk/client-dynamodb';
import type { ContextNote, CoreEvent, Escalation, Household, JiraniState, Pause } from '@jirani/core';
import type { OutboxMessage, Store } from '@jirani/mcp';

/**
 * Single-table layout (one partition per household):
 *
 *   PK = HOUSE#<id>
 *   SK = EVENT#<at>#<eventId>    Ring event
 *        REQ#<requestId>          webhook idempotency key (TTL 7 days)
 *        CTX#<id>                 context note ("at my sister's Saturday")
 *        ESC#<id>                 escalation, with version `v` for optimistic locking
 *        OUT#<at>#<seq>#<uuid>    message Jirani sent
 *        META#state | META#pause | META#clock
 */

type Item = Record<string, unknown> & { PK: string; SK: string };
type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** Enough history for the 28-lived-in-day baseline and drift report, with room for away days. */
export const EVENT_WINDOW_DAYS = 45;
const REQUEST_TTL_SECONDS = 7 * 86_400;
const OUTBOX_LOAD_LIMIT = 50;
const TRANSACT_LIMIT = 100;

const pk = (householdId: string) => `HOUSE#${householdId}`;
const eventSk = (e: CoreEvent) => `EVENT#${e.at}#${e.id}`;

/** Another writer changed what this request read. Reload and run the request again. */
export class StoreConflictError extends Error {
  constructor() {
    super('Concurrent update: reload and retry.');
    this.name = 'StoreConflictError';
  }
}

function isConditionFailure(err: unknown): boolean {
  return (
    err instanceof TransactionCanceledException &&
    (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed')
  );
}

async function queryAll(
  db: DynamoDBDocumentClient,
  input: ConstructorParameters<typeof QueryCommand>[0],
): Promise<Item[]> {
  const items: Item[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await db.send(new QueryCommand({ ...input, ExclusiveStartKey }));
    items.push(...((page.Items ?? []) as Item[]));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * Store a webhook event exactly once: the idempotency key and the event are
 * written in one transaction. Returns false if this request_id was seen before.
 */
export async function recordRingEvent(
  db: DynamoDBDocumentClient,
  table: string,
  householdId: string,
  requestId: string,
  event: CoreEvent,
  nowMs = Date.now(),
): Promise<boolean> {
  try {
    await db.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: table,
              Item: { PK: pk(householdId), SK: `REQ#${requestId}`, ttl: Math.floor(nowMs / 1000) + REQUEST_TTL_SECONDS },
              ConditionExpression: 'attribute_not_exists(SK)',
            },
          },
          { Put: { TableName: table, Item: { PK: pk(householdId), SK: eventSk(event), data: event } } },
        ],
      }),
    );
    return true;
  } catch (err) {
    if (isConditionFailure(err)) return false;
    throw err;
  }
}

/**
 * DynamoDB-backed Store for Lambda. The Store interface is synchronous (the core
 * and the MCP tools are pure), so each request works on a snapshot:
 *
 *   const store = await DynamoStore.load(db, table, household);
 *   ...run tools / evaluation against it...
 *   await store.flush();
 *
 * flush() writes only what changed, in one transaction when it fits. Escalations
 * carry a version number, so if the scheduler and an MCP call race on the same
 * alert, one of them gets StoreConflictError and is re-run on fresh data instead
 * of overwriting the other (no lost "I'm fine", no duplicate messages).
 */
export class DynamoStore implements Store {
  private readonly loadedEscalations = new Map<string, { json: string; v: number }>();
  private readonly loadedContextIds: Set<string>;
  private readonly newEvents: CoreEvent[] = [];
  private readonly newMessages: OutboxMessage[] = [];
  private readonly loaded: { pause?: Pause; clock: string | null; lastEvaluatedAt?: string };

  private constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly h: Household,
    private events: CoreEvent[],
    private contexts: ContextNote[],
    private escalations: Escalation[],
    escalationVersions: Map<string, number>,
    private messages: OutboxMessage[],
    private pause: Pause | undefined,
    private clock: string | null,
    private lastEvaluatedAt: string | undefined,
  ) {
    for (const e of escalations) {
      this.loadedEscalations.set(e.id, { json: JSON.stringify(e), v: escalationVersions.get(e.id) ?? 0 });
    }
    this.loadedContextIds = new Set(contexts.map((c) => c.id));
    this.loaded = {
      ...(pause ? { pause } : {}),
      clock,
      ...(lastEvaluatedAt ? { lastEvaluatedAt } : {}),
    };
  }

  static async load(db: DynamoDBDocumentClient, table: string, household: Household): Promise<DynamoStore> {
    const PK = pk(household.id);
    const prefixed = (prefix: string, extra: Partial<ConstructorParameters<typeof QueryCommand>[0]> = {}) => ({
      TableName: table,
      KeyConditionExpression: 'PK = :pk AND begins_with(SK, :p)',
      ExpressionAttributeValues: { ':pk': PK, ':p': prefix },
      ...extra,
    });

    // META first: a demo clock changes which events are "recent".
    const meta = await queryAll(db, prefixed('META#'));
    const metaData = (sk: string) => meta.find((m) => m.SK === sk)?.data as Record<string, unknown> | undefined;
    const clock = (metaData('META#clock')?.now as string | undefined) ?? null;
    const lastEvaluatedAt = metaData('META#state')?.lastEvaluatedAt as string | undefined;
    const pause = metaData('META#pause') as Pause | undefined;

    const now = clock ?? new Date().toISOString();
    const from = new Date(Date.parse(now) - EVENT_WINDOW_DAYS * 86_400_000).toISOString();

    const [events, contexts, escalations, outbox] = await Promise.all([
      queryAll(db, {
        TableName: table,
        KeyConditionExpression: 'PK = :pk AND SK BETWEEN :from AND :to',
        ExpressionAttributeValues: { ':pk': PK, ':from': `EVENT#${from}`, ':to': 'EVENT#~' },
      }),
      queryAll(db, prefixed('CTX#')),
      queryAll(db, prefixed('ESC#')),
      db
        .send(new QueryCommand({ ...prefixed('OUT#'), ScanIndexForward: false, Limit: OUTBOX_LOAD_LIMIT }))
        .then((r) => (r.Items ?? []) as Item[]),
    ]);

    return new DynamoStore(
      db,
      table,
      household,
      events.map((i) => i.data as CoreEvent),
      contexts.map((i) => i.data as ContextNote),
      escalations.map((i) => i.data as Escalation),
      new Map(escalations.map((i) => [(i.data as Escalation).id, Number(i.v ?? 0)])),
      outbox.map((i) => i.data as OutboxMessage).reverse(),
      pause,
      clock,
      lastEvaluatedAt,
    );
  }

  now(): string {
    return this.clock ?? new Date().toISOString();
  }

  setClock(iso: string | null): void {
    this.clock = iso;
  }

  household(): Household {
    return this.h;
  }

  state(): JiraniState {
    return {
      household: this.h,
      events: this.events,
      contexts: this.contexts,
      escalations: this.escalations,
      ...(this.pause ? { pause: this.pause } : {}),
      ...(this.lastEvaluatedAt ? { lastEvaluatedAt: this.lastEvaluatedAt } : {}),
    };
  }

  /** Webhook idempotency needs an atomic write: the webhook Lambda uses recordRingEvent() instead. */
  remember(_requestId: string): boolean {
    throw new Error('DynamoStore.remember is not supported: use recordRingEvent() for webhooks.');
  }

  addEvent(e: CoreEvent): void {
    this.events = [...this.events, e];
    this.newEvents.push(e);
  }

  addContext(c: ContextNote): void {
    this.contexts = [...this.contexts, c];
  }

  removeContext(id: string): boolean {
    if (!this.contexts.some((c) => c.id === id)) return false;
    this.contexts = this.contexts.filter((c) => c.id !== id);
    return true;
  }

  setPause(p: Pause | undefined): void {
    this.pause = p;
  }

  setEscalations(es: Escalation[], evaluatedAt: string): void {
    this.escalations = es;
    this.lastEvaluatedAt = evaluatedAt;
  }

  deliver(m: OutboxMessage): void {
    this.messages = [...this.messages, m];
    this.newMessages.push(m);
  }

  outbox(): OutboxMessage[] {
    return this.messages;
  }

  /** The writes flush() would make, in order. Exposed for tests. */
  pendingWrites(): TransactItem[] {
    const TableName = this.table;
    const PK = pk(this.h.id);
    const put = (Item: Record<string, unknown>, extra: Partial<NonNullable<TransactItem['Put']>> = {}): TransactItem => ({
      Put: { TableName, Item: { PK, ...Item }, ...extra },
    });
    const writes: TransactItem[] = [];

    for (const e of this.escalations) {
      const before = this.loadedEscalations.get(e.id);
      const json = JSON.stringify(e);
      if (before?.json === json) continue;
      writes.push(
        before
          ? put(
              { SK: `ESC#${e.id}`, data: e, v: before.v + 1 },
              { ConditionExpression: 'v = :v', ExpressionAttributeValues: { ':v': before.v } },
            )
          : put({ SK: `ESC#${e.id}`, data: e, v: 1 }, { ConditionExpression: 'attribute_not_exists(SK)' }),
      );
    }
    // Messages from one evaluation share a timestamp; the sequence keeps them in the order they were sent.
    this.newMessages.forEach((m, i) => writes.push(put({ SK: `OUT#${m.at}#${String(i).padStart(4, '0')}#${randomUUID()}`, data: m })));
    for (const c of this.contexts) {
      if (!this.loadedContextIds.has(c.id)) writes.push(put({ SK: `CTX#${c.id}`, data: c }));
    }
    const kept = new Set(this.contexts.map((c) => c.id));
    for (const id of this.loadedContextIds) {
      if (!kept.has(id)) writes.push({ Delete: { TableName, Key: { PK, SK: `CTX#${id}` } } });
    }
    for (const e of this.newEvents) writes.push(put({ SK: eventSk(e), data: e }));

    if (JSON.stringify(this.pause) !== JSON.stringify(this.loaded.pause)) {
      writes.push(this.pause ? put({ SK: 'META#pause', data: this.pause }) : { Delete: { TableName, Key: { PK, SK: 'META#pause' } } });
    }
    if (this.clock !== this.loaded.clock) {
      writes.push(
        this.clock ? put({ SK: 'META#clock', data: { now: this.clock } }) : { Delete: { TableName, Key: { PK, SK: 'META#clock' } } },
      );
    }
    if (this.lastEvaluatedAt && this.lastEvaluatedAt !== this.loaded.lastEvaluatedAt) {
      writes.push(put({ SK: 'META#state', data: { lastEvaluatedAt: this.lastEvaluatedAt } }));
    }
    return writes;
  }

  /**
   * Persist this request's changes. Up to 100 writes go in one transaction (all
   * or nothing). Larger batches, which only happen on the first evaluation after
   * a bulk replay, are split into several transactions.
   */
  async flush(): Promise<number> {
    const writes = this.pendingWrites();
    try {
      for (let i = 0; i < writes.length; i += TRANSACT_LIMIT) {
        await this.db.send(new TransactWriteCommand({ TransactItems: writes.slice(i, i + TRANSACT_LIMIT) }));
      }
    } catch (err) {
      if (isConditionFailure(err)) throw new StoreConflictError();
      throw err;
    }
    return writes.length;
  }
}

/**
 * Load, run, flush; on a conflict, reload and run again (up to `attempts` times).
 * `fn` must not have side effects outside the store, since it may run more than once.
 */
export async function withStore<T>(
  db: DynamoDBDocumentClient,
  table: string,
  household: Household,
  fn: (store: DynamoStore) => Promise<T> | T,
  attempts = 3,
): Promise<T> {
  for (let i = 1; ; i++) {
    const store = await DynamoStore.load(db, table, household);
    const result = await fn(store);
    try {
      await store.flush();
      return result;
    } catch (err) {
      if (!(err instanceof StoreConflictError) || i >= attempts) throw err;
    }
  }
}

