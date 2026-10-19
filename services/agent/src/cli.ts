import { ask, bedrockModel, type Lang, type Speaker } from './agent.ts';
import { fetchClock } from './clock.ts';

/**
 * Ask Jirani a question through the Strands agent on Amazon Bedrock.
 *
 *   pnpm ask "How's Mum this week?"                 as family (default)
 *   pnpm ask --as resident "I'm at my sister's Saturday"
 *   pnpm ask --as resident --lang es "Estoy en casa de mi hermana el sábado"
 *
 * Env: JIRANI_MCP_URL (default http://localhost:3333/mcp), JIRANI_API_TOKEN (for the
 * deployed API), BEDROCK_MODEL_ID, AWS_REGION, plus normal AWS credentials.
 */
const args = process.argv.slice(2);
let speaker: Speaker = 'family';
const asIdx = args.indexOf('--as');
if (asIdx >= 0) {
  const v = args[asIdx + 1];
  if (v !== 'resident' && v !== 'family') throw new Error('--as must be resident or family');
  speaker = v;
  args.splice(asIdx, 2);
}
let lang: Lang = 'en';
const langIdx = args.indexOf('--lang');
if (langIdx >= 0) {
  const v = args[langIdx + 1];
  if (v !== 'en' && v !== 'es') throw new Error('--lang must be en or es');
  lang = v;
  args.splice(langIdx, 2);
}
const question = args.join(' ').trim();
if (!question) {
  console.error('Usage: pnpm ask [--as resident|family] [--lang en|es] "<question>"');
  process.exit(1);
}

const mcpUrl = process.env.JIRANI_MCP_URL ?? 'http://localhost:3333/mcp';
const apiToken = process.env.JIRANI_API_TOKEN || undefined;
const clock = await fetchClock(mcpUrl, apiToken);
const model = bedrockModel({
  ...(process.env.BEDROCK_MODEL_ID ? { modelId: process.env.BEDROCK_MODEL_ID } : {}),
  ...(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {}),
});

const r = await ask(question, { mcpUrl, ...(apiToken ? { apiToken } : {}), speaker, lang, ...clock, model });
for (const c of r.toolCalls) console.log(`\x1b[2m→ tools/call ${c.name} ${JSON.stringify(c.input)}\x1b[0m`);
console.log(r.answer);
