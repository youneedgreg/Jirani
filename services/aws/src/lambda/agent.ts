import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { ask, bedrockModel, fetchClock, type Model, type Speaker } from '@jirani/agent';
import { apiToken, bearerMatches, requireEnv } from '../config.ts';

/**
 * Jirani's agent (Lambda Function URL): a Strands agent on Amazon Bedrock that
 * answers by calling Jirani's own MCP server over HTTP, like any MCP client would.
 *
 *   POST /ask  {"question": "How's Mum this week?", "as": "family" | "resident"}
 *   -> {"answer": "...", "toolCalls": [{"name": "weekly_report", "input": {}}]}
 *
 * Needs `Authorization: Bearer <token>` (the same token as the API).
 */
const json = (statusCode: number, body: unknown): LambdaFunctionURLResult => ({
  statusCode,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export function createAgentHandler(makeModel: () => Model) {
  return async (event: LambdaFunctionURLEvent): Promise<LambdaFunctionURLResult> => {
    const token = await apiToken();
    if (!bearerMatches(event.headers.authorization, token)) return json(401, { error: 'unauthorized' });
    if (event.requestContext.http.method !== 'POST' || event.rawPath !== '/ask') return json(404, { error: 'not found' });

    let question: string;
    let speaker: Speaker;
    try {
      const raw = event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '{}';
      const b = JSON.parse(raw) as { question?: unknown; as?: unknown };
      if (typeof b.question !== 'string' || !b.question.trim() || b.question.length > 1000) throw new Error('question');
      if (b.as !== undefined && b.as !== 'resident' && b.as !== 'family') throw new Error('as');
      question = b.question.trim();
      speaker = (b.as as Speaker | undefined) ?? 'family';
    } catch {
      return json(400, { error: 'body must be {"question": string (1-1000 chars), "as"?: "resident" | "family"}' });
    }

    try {
      const mcpUrl = new URL('mcp', requireEnv('JIRANI_API_URL')).toString();
      const clock = await fetchClock(mcpUrl, token);
      const r = await ask(question, { mcpUrl, apiToken: token, speaker, ...clock, model: makeModel() });
      console.log(JSON.stringify({ speaker, tools: r.toolCalls.map((c) => c.name) }));
      return json(200, r);
    } catch (err) {
      console.error(err);
      return json(502, { error: 'the agent could not answer right now' });
    }
  };
}

export const handler = createAgentHandler(() =>
  bedrockModel({
    ...(process.env.BEDROCK_MODEL_ID ? { modelId: process.env.BEDROCK_MODEL_ID } : {}),
    ...(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}),
  }),
);
