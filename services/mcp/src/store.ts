import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Action, ContextNote, CoreEvent, Escalation, Household, JiraniState, Pause } from '@jirani/core';

/** A message Jirani "sent". Locally it's printed and kept; in AWS it goes to SES. */
export interface OutboxMessage {
  at: string;
  escalationId: string;
  to: string;
  type: Action['type'];
  message: string;
}

/**
 * Storage port. MemoryStore runs locally and in tests; a DynamoDB store with the
 * same interface backs the Lambda deployment.
 */
export interface Store {
  now(): string;
  setClock(iso: string | null): void;
  household(): Household;
  state(): JiraniState;
  remember(requestId: string): boolean;
  addEvent(e: CoreEvent): void;
  addContext(c: ContextNote): void;
  /** Delete a plan note (a correction or a cancellation). False if there is no such note. */
  removeContext(id: string): boolean;
  setPause(p: Pause | undefined): void;
  setEscalations(es: Escalation[], evaluatedAt: string): void;
  deliver(m: OutboxMessage): void;
  outbox(): OutboxMessage[];
}

export class MemoryStore implements Store {
  private events: CoreEvent[] = [];
  private requestIds = new Set<string>();
  private contexts: ContextNote[] = [];
  private escalations: Escalation[] = [];
  private pause: Pause | undefined;
  private lastEvaluatedAt: string | undefined;
  private messages: OutboxMessage[] = [];
  private clock: string | null = null;

  constructor(
    private readonly h: Household,
    private readonly opts: { file?: string; onDeliver?: (m: OutboxMessage) => void } = {},
  ) {
    if (opts.file && existsSync(opts.file)) this.load(opts.file);
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

  remember(requestId: string): boolean {
    if (this.requestIds.has(requestId)) return false;
    this.requestIds.add(requestId);
    return true;
  }

  addEvent(e: CoreEvent): void {
    this.events.push(e);
    this.persist();
  }

  addContext(c: ContextNote): void {
    this.contexts.push(c);
    this.persist();
  }

  removeContext(id: string): boolean {
    const before = this.contexts.length;
    this.contexts = this.contexts.filter((c) => c.id !== id);
    if (this.contexts.length === before) return false;
    this.persist();
    return true;
  }

  setPause(p: Pause | undefined): void {
    this.pause = p;
    this.persist();
  }

  setEscalations(es: Escalation[], evaluatedAt: string): void {
    this.escalations = es;
    this.lastEvaluatedAt = evaluatedAt;
    this.persist();
  }

  deliver(m: OutboxMessage): void {
    this.messages.push(m);
    this.opts.onDeliver?.(m);
    this.persist();
  }

  outbox(): OutboxMessage[] {
    return this.messages;
  }

  private persist() {
    if (!this.opts.file) return;
    mkdirSync(dirname(this.opts.file), { recursive: true });
    writeFileSync(
      this.opts.file,
      JSON.stringify({
        events: this.events,
        requestIds: [...this.requestIds],
        contexts: this.contexts,
        escalations: this.escalations,
        pause: this.pause,
        lastEvaluatedAt: this.lastEvaluatedAt,
        messages: this.messages,
      }),
    );
  }

  private load(file: string) {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    this.events = s.events ?? [];
    this.requestIds = new Set(s.requestIds ?? []);
    this.contexts = s.contexts ?? [];
    this.escalations = s.escalations ?? [];
    this.pause = s.pause;
    this.lastEvaluatedAt = s.lastEvaluatedAt;
    this.messages = s.messages ?? [];
  }
}
