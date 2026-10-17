import { Agent, BedrockModel, McpClient, type Model } from '@strands-agents/sdk';

/**
 * Jirani's agent: a Strands agent that answers Margaret (the resident) and Amina
 * (family) in plain, speakable words. It decides nothing about safety itself:
 * the rhythm engine decides when something is off; the agent only explains it
 * and acts through Jirani's MCP tools.
 */

export type Speaker = 'resident' | 'family';

/** What each speaker may do. Margaret's controls stay hers; family can't pause monitoring. */
export const TOOLS: Record<Speaker, readonly string[]> = {
  resident: ['tell_jirani', 'answer_checkin', 'pause_monitoring', 'usual_routine'],
  family: ['tell_jirani', 'answer_checkin', 'how_is_she', 'why_alert', 'weekly_report', 'view_front_door', 'usual_routine'],
};

/**
 * Amazon Nova 2 Lite through Bedrock's EU inference profile: in eu-north-1 the model is only
 * offered through an inference profile, and the EU one keeps requests in EU Regions.
 * Override with BEDROCK_MODEL_ID.
 */
export const DEFAULT_BEDROCK_MODEL_ID = 'eu.amazon.nova-2-lite-v1:0';
export const DEFAULT_BEDROCK_REGION = 'eu-north-1';

export function bedrockModel(opts: { modelId?: string; region?: string } = {}): BedrockModel {
  // temperature 0 (as in AWS's Nova tool-use examples) keeps answers close to the tool facts:
  // with Nova's default sampling, alert explanations sometimes dropped a step or a time.
  // maxTokens is well under Nova 2 Lite's 64K output limit; answers are a few sentences.
  return new BedrockModel({
    modelId: opts.modelId ?? DEFAULT_BEDROCK_MODEL_ID,
    region: opts.region ?? DEFAULT_BEDROCK_REGION,
    temperature: 0,
    maxTokens: 16_000,
  });
}

export interface AskOptions {
  /** Jirani's MCP server (Streamable HTTP). */
  mcpUrl: string;
  /** Bearer token for the MCP server, if it requires one. */
  apiToken?: string;
  speaker: Speaker;
  residentName: string;
  /** "Now" as Jirani sees it (ISO), and the household's time zone, so "Saturday" resolves correctly. */
  now: string;
  timeZone: string;
  model: Model;
}

export interface AskResult {
  answer: string;
  /** The tool calls the agent made, in order: what a judge sees behind each answer. */
  toolCalls: { name: string; input: unknown }[];
}

export function systemPrompt(o: Pick<AskOptions, 'speaker' | 'residentName' | 'now' | 'timeZone'>): string {
  const local = new Date(o.now).toLocaleString('en-US', {
    timeZone: o.timeZone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  const who =
    o.speaker === 'resident'
      ? `You are speaking with ${o.residentName} herself, by voice. She lives alone and values her independence; she is in charge of Jirani. ` +
        'When she shares plans, save them with tell_jirani. When she answers a check-in, use answer_checkin with from="resident". ' +
        'When she asks you to pause, use pause_monitoring and tell her that family will only see that monitoring is paused, not why.'
      : `You are speaking with ${o.residentName}'s family, by voice or on the dashboard. ` +
        'Use how_is_she for today, weekly_report for the week, why_alert to explain an alert, and view_front_door only when they ask to see the front door. ' +
        'When you explain an alert, keep every step why_alert lists, in its order, with its time and the way the person was reached. ' +
        'Never say someone confirmed she is OK unless a tool says that person did; if an alert closed because sensors recorded activity, say exactly that. ' +
        'If they report that they checked on her, use answer_checkin with from="contact" and their contact id.';
  return [
    `You are Jirani, a caregiving assistant for ${o.residentName}, an older adult who lives alone. Jirani learns her daily rhythm from Ring door and contact sensors; it never watches video unless she agreed to it.`,
    who,
    `It is now ${local} in ${o.residentName}'s time zone (${o.timeZone}). Tool times are "YYYY-MM-DD HH:MM" in that time zone.`,
    'Only state facts that a tool returned in this conversation, and give the event times the tools report. If the tools do not answer the question, say you don\'t know rather than guessing.',
    'Never diagnose or suggest a medical cause. If a change is worth raising, say it is worth mentioning to her doctor.',
    'Jirani never contacts emergency services itself; a person decides. Never claim that you called anyone.',
    'Answer in one to three short sentences that sound natural when spoken aloud (up to four when you explain an alert). No lists, no markdown.',
  ].join('\n\n');
}

/**
 * Answer one question. Stateless: each call connects to the MCP server, runs the
 * agent loop and disconnects. Memory across sessions lives in Jirani itself
 * (tell_jirani), not in the conversation.
 */
export async function ask(question: string, o: AskOptions): Promise<AskResult> {
  const mcp = new McpClient({
    url: o.mcpUrl,
    ...(o.apiToken ? { headers: { authorization: `Bearer ${o.apiToken}` } } : {}),
    toolFilters: { allowed: [...TOOLS[o.speaker]] },
  });
  try {
    await mcp.connect();
    const tools = await mcp.listTools();
    if (tools.length === 0) throw new Error(`Jirani's MCP server offered none of the ${o.speaker} tools`);

    const agent = new Agent({ model: o.model, tools: [mcp], systemPrompt: systemPrompt(o), printer: false });
    const result = await agent.invoke(question);

    const toolCalls: AskResult['toolCalls'] = [];
    for (const m of agent.messages) {
      for (const block of m.content) {
        if (block.type === 'toolUseBlock') toolCalls.push({ name: block.name, input: block.input });
      }
    }
    return { answer: String(result).trim(), toolCalls };
  } finally {
    await mcp.disconnect();
  }
}
