import { startLocalServer } from '@jirani/mcp/server';
import { bedrockModel } from './agent.ts';
import { answerAsk } from './http.ts';

/**
 * `pnpm mcp`: the local Jirani server plus its agent at POST /ask (same contract as
 * the AgentFn Lambda). /ask calls Amazon Nova on Bedrock with your own AWS
 * credentials (AWS_PROFILE); everything else runs without AWS.
 */
startLocalServer({
  makeAsk: (mcpUrl) => (body) =>
    answerAsk(body, {
      mcpUrl,
      model: bedrockModel({
        ...(process.env.BEDROCK_MODEL_ID ? { modelId: process.env.BEDROCK_MODEL_ID } : {}),
        ...(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}),
      }),
      log: console.error,
    }),
});
