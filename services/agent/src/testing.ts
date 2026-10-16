import { Model, type BaseModelConfig, type Message, type ModelStreamEvent, type StreamOptions } from '@strands-agents/sdk';

export type Turn = { tool: string; input?: Record<string, unknown> } | { text: string };

/**
 * A stand-in for Bedrock in tests: plays back scripted turns (call this tool,
 * then say this) and records what the agent sent it.
 */
export class ScriptedModel extends Model<BaseModelConfig> {
  readonly calls: { messages: Message[]; tools: string[]; system: string }[] = [];
  private config: BaseModelConfig = { modelId: 'scripted' };

  constructor(private readonly turns: Turn[]) {
    super();
  }

  updateConfig(c: BaseModelConfig): void {
    this.config = { ...this.config, ...c };
  }

  getConfig(): BaseModelConfig {
    return this.config;
  }

  async *stream(messages: Message[], options?: StreamOptions): AsyncIterable<ModelStreamEvent> {
    this.calls.push({
      messages: [...messages],
      tools: (options?.toolSpecs ?? []).map((t) => t.name).sort(),
      system: typeof options?.systemPrompt === 'string' ? options.systemPrompt : JSON.stringify(options?.systemPrompt ?? ''),
    });
    const turn = this.turns.shift() ?? { text: '(script ended)' };
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    if ('tool' in turn) {
      yield {
        type: 'modelContentBlockStartEvent',
        start: { type: 'toolUseStart', name: turn.tool, toolUseId: `t${this.calls.length}` },
      };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'toolUseInputDelta', input: JSON.stringify(turn.input ?? {}) } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    } else {
      yield { type: 'modelContentBlockStartEvent' };
      yield { type: 'modelContentBlockDeltaEvent', delta: { type: 'textDelta', text: turn.text } };
      yield { type: 'modelContentBlockStopEvent' };
      yield { type: 'modelMessageStopEvent', stopReason: 'endTurn' };
    }
  }
}

/** The text of the tool results in the last message the model received. */
export function lastToolResults(m: ScriptedModel): { status: string; text: string }[] {
  const last = m.calls.at(-1)?.messages.at(-1);
  const out: { status: string; text: string }[] = [];
  for (const b of last?.content ?? []) {
    if (b.type !== 'toolResultBlock') continue;
    out.push({ status: b.status, text: b.content.map((c) => ('text' in c ? c.text : '')).join(' ') });
  }
  return out;
}
