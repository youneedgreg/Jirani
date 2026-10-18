import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetScheduleCommand, ListSchedulesCommand, SchedulerClient, UpdateScheduleCommand } from '@aws-sdk/client-scheduler';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { ask, bedrockModel, fetchClock, type Speaker } from '@jirani/agent';
import { fromLocal } from '@jirani/core';
import { demoHousehold } from '@jirani/mcp';
import { generate, PRESETS, replay, type SimEvent } from 'ring-routine-sim';

/**
 * Plays the Jirani demo story against a running Jirani, step by step, so the video
 * can be recorded against the real stack:
 *
 *   pnpm aws:story [--local] [--pause-schedule] <command>
 *
 *   thursday [--plan]   events up to Thu 15 Oct 6pm (--plan also saves the weekend away)
 *   sunday              events up to Sun 9:30am, then evaluate (the quiet house)
 *   monday              events up to Mon 10:05am, then the ladder at 10:05, 10:26, 10:47
 *   tuesday             a real alert, then Tuesday's morning arrives late and closes it
 *   all                 thursday --plan, sunday, monday
 *   clock <YYYY-MM-DD> <HH:MM> | clock real
 *   evaluate | state | mcp <tool> ['<json args>'] | ask <family|resident> "<question>"
 *
 * Against AWS it reads the stack's outputs from CloudFormation and its secrets from
 * Secrets Manager (nothing on disk, so it works in a cloud session too) and never
 * prints a secret. --local targets `JIRANI_DEMO=1 pnpm mcp` on port 3333.
 * Times are the household's local time (America/New_York).
 */

export interface Target {
  name: 'aws' | 'local';
  /** Base URL with a trailing slash: /mcp, /api/*, /demo/clock live under it. */
  api: string;
  webhook: string;
  hmacKey: string;
  token?: string;
  /** Deployed agent (AWS only); locally the agent runs in-process. */
  askUrl?: string;
  evaluate(): Promise<unknown>;
  /** Turn the every-minute evaluation schedule off or on (AWS only). */
  setSchedule?(enabled: boolean): Promise<void>;
}

const h = demoHousehold();
export const localTime = (date: string, hhmm: string): string => {
  const [hh, mm] = hhmm.split(':').map(Number) as [number, number];
  return new Date(fromLocal(h.timeZone, date, hh * 60 + mm)).toISOString();
};

const THU = localTime('2026-10-15', '18:00');
const SUN = localTime('2026-10-18', '09:30');
const MON = localTime('2026-10-19', '10:05');

let storyEvents: SimEvent[] | undefined;
const story = () => (storyEvents ??= generate(PRESETS.demo!.options));

function headers(t: Target): Record<string, string> {
  return { 'content-type': 'application/json', ...(t.token ? { authorization: `Bearer ${t.token}` } : {}) };
}

async function post(t: Target, url: string, body: unknown): Promise<string> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { ...headers(t), accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${r.status} from ${new URL(url).pathname}: ${text.slice(0, 200)}`);
  return text;
}

export async function setClock(t: Target, iso: string | null): Promise<string> {
  const r = JSON.parse(await post(t, `${t.api}demo/clock`, { now: iso })) as { now: string };
  return r.now;
}

export async function send(t: Target, events: SimEvent[]) {
  return replay(events, { url: t.webhook, hmacKey: t.hmacKey });
}

/** Story events in (from, to]; from '' means the start. */
export const between = (from: string, to: string) => story().filter((e) => e.at > from && e.at <= to);

export async function callTool(t: Target, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const raw = await post(t, `${t.api}mcp`, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
  const json = raw.trimStart().startsWith('{') ? raw : raw.split('\n').find((l) => l.startsWith('data: '))!.slice(6);
  const res = JSON.parse(json).result as { content: { text?: string }[]; isError?: boolean };
  return `${res.isError ? '[error] ' : ''}${res.content.map((c) => c.text ?? '').join(' ')}`;
}

export async function askJirani(t: Target, speaker: Speaker, question: string) {
  if (t.askUrl) {
    return JSON.parse(await post(t, t.askUrl, { question, as: speaker })) as { answer: string; toolCalls: { name: string; input: unknown }[] };
  }
  const mcpUrl = `${t.api}mcp`;
  const clock = await fetchClock(mcpUrl, t.token);
  return ask(question, { mcpUrl, ...(t.token ? { apiToken: t.token } : {}), speaker, ...clock, model: bedrockModel() });
}

/** Run fn with the evaluation schedule paused, and always turn it back on. */
export async function withPausedSchedule<T>(t: Target, pause: boolean, fn: () => Promise<T>): Promise<T> {
  if (!pause || !t.setSchedule) return fn();
  await t.setSchedule(false);
  try {
    return await fn();
  } finally {
    await t.setSchedule(true);
  }
}

/** What one evaluation did, without the message text. */
const summary = (r: unknown) => {
  const actions = (r as { actions?: unknown })?.actions;
  if (typeof actions === 'number') return `${actions} action(s)`;
  if (Array.isArray(actions)) return actions.map((a) => `${a.action.type}→${a.action.to ?? '-'}`).join(', ') || 'no actions';
  return 'evaluated';
};

type Log = (line: string) => void;

export async function evaluateAt(t: Target, date: string, time: string, log: Log) {
  await setClock(t, localTime(date, time));
  log(`  ${date} ${time}: ${summary(await t.evaluate())}`);
}

export const phases = {
  // Clock first, so a scheduled evaluation mid-replay judges a complete day, not a half-loaded one.
  async thursday(t: Target, log: Log, opts: { plan?: boolean } = {}) {
    await setClock(t, THU);
    const r = await send(t, between('', THU));
    log(`  Thu 15 Oct 6:00pm: ${r.sent} signed events sent, ${r.failed} rejected`);
    if (opts.plan) {
      log(
        `  ${await callTool(t, 'tell_jirani', {
          kind: 'away',
          text: "At my sister's this weekend",
          starts_at: '2026-10-17 08:00',
          ends_at: '2026-10-18 19:00',
          created_by: 'resident',
        })}`,
      );
    }
    log(`  ${summary(await t.evaluate())}`);
  },
  async sunday(t: Target, log: Log) {
    const r = await send(t, between(THU, SUN));
    log(`  up to Sun 18 Oct 9:30am: ${r.sent} events sent, ${r.failed} rejected`);
    await evaluateAt(t, '2026-10-18', '09:30', log);
  },
  async monday(t: Target, log: Log) {
    const r = await send(t, between(SUN, MON));
    log(`  up to Mon 19 Oct 10:05am: ${r.sent} events sent, ${r.failed} rejected`);
    for (const time of ['10:05', '10:26', '10:47']) await evaluateAt(t, '2026-10-19', time, log);
  },
  async tuesday(t: Target, log: Log) {
    for (const time of ['10:05', '10:26']) await evaluateAt(t, '2026-10-20', time, log);
    // One ordinary extra day (its own seed, so new event and request ids), arriving late.
    const tue = generate({ start: '2026-10-20', days: 1, seed: 2020, timeZone: h.timeZone }).filter(
      (e) => e.at <= localTime('2026-10-20', '10:00'),
    );
    const r = await send(t, tue);
    log(`  Tuesday's morning arrives late: ${r.sent} events sent, ${r.failed} rejected`);
    await evaluateAt(t, '2026-10-20', '10:30', log);
  },
};

export function localTarget(base = process.env.JIRANI_LOCAL_URL ?? 'http://127.0.0.1:3333/'): Target {
  const api = base.endsWith('/') ? base : `${base}/`;
  return {
    name: 'local',
    api,
    webhook: `${api}ring/webhook`,
    hmacKey: process.env.RING_HMAC_KEY ?? 'dev-only-change-me',
    evaluate: async () => (await fetch(`${api}internal/evaluate`, { method: 'POST' })).json(),
  };
}

export async function awsTarget(stackName = process.env.JIRANI_STACK ?? 'Jirani'): Promise<Target> {
  const region = process.env.AWS_REGION ?? 'eu-north-1';
  const cfn = new CloudFormationClient({ region });
  const stack = (await cfn.send(new DescribeStacksCommand({ StackName: stackName }))).Stacks?.[0];
  const out = Object.fromEntries((stack?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
  for (const k of ['ApiUrl', 'WebhookUrl', 'AskUrl', 'EvaluateFunctionName', 'RingHmacKeySecret', 'ApiTokenSecret']) {
    if (!out[k]) throw new Error(`Stack ${stackName} has no ${k} output. Deploy it first (pnpm aws:deploy).`);
  }
  const sm = new SecretsManagerClient({ region });
  const secretValue = async (id: string) => (await sm.send(new GetSecretValueCommand({ SecretId: id }))).SecretString!;
  const lambda = new LambdaClient({ region });
  const scheduler = new SchedulerClient({ region });
  return {
    name: 'aws',
    api: out.ApiUrl!,
    webhook: out.WebhookUrl!,
    askUrl: out.AskUrl!,
    hmacKey: await secretValue(out.RingHmacKeySecret!),
    token: await secretValue(out.ApiTokenSecret!),
    async evaluate() {
      const r = await lambda.send(new InvokeCommand({ FunctionName: out.EvaluateFunctionName!, Payload: new TextEncoder().encode('{}') }));
      if (r.FunctionError) throw new Error(`EvaluateFn failed: ${r.FunctionError}`);
      return JSON.parse(new TextDecoder().decode(r.Payload));
    },
    async setSchedule(enabled) {
      const list = await scheduler.send(new ListSchedulesCommand({ NamePrefix: `${stackName}-EvaluateSchedule` }));
      const name = list.Schedules?.[0]?.Name;
      if (!name) return; // deployed with -c evaluateEveryMinutes=0: nothing to pause
      const s = await scheduler.send(new GetScheduleCommand({ Name: name }));
      // UpdateSchedule replaces the whole schedule, so send everything back with the new state.
      await scheduler.send(
        new UpdateScheduleCommand({
          Name: s.Name!,
          GroupName: s.GroupName,
          ScheduleExpression: s.ScheduleExpression!,
          ScheduleExpressionTimezone: s.ScheduleExpressionTimezone,
          Description: s.Description,
          FlexibleTimeWindow: s.FlexibleTimeWindow!,
          Target: s.Target!,
          ActionAfterCompletion: s.ActionAfterCompletion,
          KmsKeyArn: s.KmsKeyArn,
          State: enabled ? 'ENABLED' : 'DISABLED',
        }),
      );
    },
  };
}

const USAGE = 'Usage: pnpm aws:story [--local] [--pause-schedule] <thursday [--plan]|sunday|monday|tuesday|all|clock <date> <time>|clock real|evaluate|state|mcp <tool> [json]|ask <family|resident> "<question>">';

/** Runs one command. Returns the process exit code. */
export async function main(argv: string[], target?: Target, log: Log = console.log): Promise<number> {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const [cmd, ...rest] = argv.filter((a) => !a.startsWith('--'));
  if (!cmd) {
    log(USAGE);
    return 1;
  }
  const t = target ?? (flags.has('--local') ? localTarget() : await awsTarget());
  log(`Jirani story → ${t.name} (${new URL(t.api).host})`);
  const pause = flags.has('--pause-schedule');
  switch (cmd) {
    case 'thursday':
      await withPausedSchedule(t, pause, () => phases.thursday(t, log, { plan: flags.has('--plan') }));
      break;
    case 'sunday':
    case 'monday':
    case 'tuesday':
      await withPausedSchedule(t, pause, () => phases[cmd](t, log));
      break;
    case 'all':
      await withPausedSchedule(t, pause, async () => {
        await phases.thursday(t, log, { plan: true });
        await phases.sunday(t, log);
        await phases.monday(t, log);
      });
      break;
    case 'clock':
      log(`  clock: ${await setClock(t, rest[0] === 'real' ? null : localTime(rest[0]!, rest[1]!))}`);
      break;
    case 'evaluate':
      log(`  ${summary(await t.evaluate())}`);
      break;
    case 'state': {
      const s = (await (await fetch(`${t.api}api/state`, { headers: headers(t) })).json()) as {
        now: string;
        escalations: { id: string; level: number; status: string }[];
        outbox: { type: string; to: string }[];
      };
      log(`  now ${s.now}`);
      log(`  alerts: ${s.escalations.map((e) => `${e.id} L${e.level} ${e.status}`).join('; ') || 'none'}`);
      log(`  outbox: ${s.outbox.map((m) => `${m.type}→${m.to}`).join(', ') || 'empty'}`);
      break;
    }
    case 'mcp':
      log(`  ${await callTool(t, rest[0]!, JSON.parse(rest[1] ?? '{}'))}`);
      break;
    case 'ask': {
      const r = await askJirani(t, rest[0] as Speaker, rest.slice(1).join(' '));
      for (const c of r.toolCalls) log(`  → tools/call ${c.name} ${JSON.stringify(c.input)}`);
      log(`  ${r.answer}`);
      break;
    }
    default:
      log(USAGE);
      return 1;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err: Error) => {
      console.error(`aws:story failed: ${err.message}`);
      process.exit(1);
    },
  );
}
