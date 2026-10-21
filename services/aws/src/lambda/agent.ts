import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';
import { answerAsk, ASK_BODY_ERROR, bedrockModel, type Model } from '@jirani/agent';
import { apiToken, bearerMatches, requireEnv } from '../config.ts';
import { withSentry } from '../sentry.ts';

/**
 * Jirani's agent (Lambda Function URL): a Strands agent on Amazon Bedrock that
 * answers by calling Jirani's own MCP server over HTTP, like any MCP client would.
 *
 *   POST /ask  {"question": "How's Mum this week?", "as": "family" | "resident", "lang": "en" | "es"}
 *   -> {"answer": "...", "toolCalls": [{"name": "weekly_report", "input": {}}]}
 *
 * (The contract lives in @jirani/agent's answerAsk, shared with the local server.)
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

    let body: unknown;
    try {
      body = JSON.parse(event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body) : '{}');
    } catch {
      return json(400, { error: ASK_BODY_ERROR });
    }
    const mcpUrl = new URL('mcp', requireEnv('JIRANI_API_URL')).toString();
    const r = await answerAsk(body, { mcpUrl, apiToken: token, model: makeModel(), log: console.log });
    return json(r.status, r.body);
  };
}

export const handler = withSentry(
  createAgentHandler(() =>
    bedrockModel({
      ...(process.env.BEDROCK_MODEL_ID ? { modelId: process.env.BEDROCK_MODEL_ID } : {}),
      ...(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}),
    }),
  ),
);
