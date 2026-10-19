import type { Model } from '@strands-agents/sdk';
import { ask, type AskResult, type Lang, type Speaker } from './agent.ts';
import { fetchClock } from './clock.ts';

/**
 * The POST /ask contract, shared by the AgentFn Lambda and the local server:
 *
 *   {"question": "How's Mum this week?", "as"?: "family" | "resident", "lang"?: "en" | "es"}
 *   -> 200 {"answer": "...", "toolCalls": [{"name": "weekly_report", "input": {}}]}
 */
export interface AskRequest {
  question: string;
  speaker: Speaker;
  lang: Lang;
}

export const ASK_BODY_ERROR =
  'body must be {"question": string (1-1000 chars), "as"?: "resident" | "family", "lang"?: "en" | "es"}';

/** A valid /ask body, or null. */
export function parseAskRequest(body: unknown): AskRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as { question?: unknown; as?: unknown; lang?: unknown };
  if (typeof b.question !== 'string' || !b.question.trim() || b.question.length > 1000) return null;
  if (b.as !== undefined && b.as !== 'resident' && b.as !== 'family') return null;
  if (b.lang !== undefined && b.lang !== 'en' && b.lang !== 'es') return null;
  return { question: b.question.trim(), speaker: (b.as as Speaker | undefined) ?? 'family', lang: (b.lang as Lang | undefined) ?? 'en' };
}

/** Answer one /ask body against Jirani's MCP server: the HTTP status and JSON body to send. */
export async function answerAsk(
  body: unknown,
  o: { mcpUrl: string; apiToken?: string; model: Model; log?: (line: string) => void },
): Promise<{ status: number; body: AskResult | { error: string } }> {
  const req = parseAskRequest(body);
  if (!req) return { status: 400, body: { error: ASK_BODY_ERROR } };
  try {
    const clock = await fetchClock(o.mcpUrl, o.apiToken);
    const r = await ask(req.question, {
      mcpUrl: o.mcpUrl,
      ...(o.apiToken ? { apiToken: o.apiToken } : {}),
      speaker: req.speaker,
      lang: req.lang,
      ...clock,
      model: o.model,
    });
    o.log?.(JSON.stringify({ speaker: req.speaker, lang: req.lang, tools: r.toolCalls.map((c) => c.name) }));
    return { status: 200, body: r };
  } catch (err) {
    o.log?.(err instanceof Error ? (err.stack ?? err.message) : String(err));
    return { status: 502, body: { error: 'the agent could not answer right now' } };
  }
}
