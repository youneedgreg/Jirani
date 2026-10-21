import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  buildBaseline,
  fromLocal,
  hhmm,
  reportSummary,
  respond,
  spokenDateTime,
  summariseDay,
  toLocal,
  weeklyReport,
  type ContextNote,
  type Escalation,
} from '@jirani/core';
import { runEvaluation } from './runtime.ts';
import type { Store } from './store.ts';

/**
 * Jirani's MCP tools: what an Alexa+-style assistant can do on behalf of
 * Margaret (the resident) and Amina (family). Responses lead with a short,
 * speakable sentence, then structured data for screens.
 */

const speak = (text: string, data?: Record<string, unknown>) => ({
  content: [{ type: 'text' as const, text }],
  ...(data ? { structuredContent: data } : {}),
});

export function buildMcpServer(store: Store): McpServer {
  const server = new McpServer(
    { name: 'jirani', title: 'Jirani: the neighbour who notices', version: '0.1.0' },
    {
      instructions:
        'Jirani looks after an older adult who lives alone, using Ring sensor events (never video by default). ' +
        'Use tell_jirani when the resident or family shares plans; how_is_she, why_alert and weekly_report for family questions; ' +
        'answer_checkin when the resident or a neighbour replies to a check-in. Only state facts the tools return. Never diagnose.',
    },
  );
  const h = () => store.household();
  /** Accept ISO instants, or "YYYY-MM-DD HH:MM" in the household's local time. */
  const parseWhen = (v: string): string => {
    const m = v.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}):(\d{2})$/);
    if (m) return new Date(fromLocal(h().timeZone, m[1]!, Number(m[2]) * 60 + Number(m[3]))).toISOString();
    const t = Date.parse(v);
    if (Number.isNaN(t)) throw new Error(`Can't read the time "${v}". Use "YYYY-MM-DD HH:MM" local time.`);
    return new Date(t).toISOString();
  };

  server.registerTool(
    'tell_jirani',
    {
      title: 'Tell Jirani about plans',
      description:
        'Save context so Jirani does not raise false alarms, e.g. "I\'m at my sister\'s Saturday" (away), "sleeping in today" (late_start), "the carer comes at 2" (visitor_expected). Times are local to the resident: "YYYY-MM-DD HH:MM".',
      inputSchema: {
        kind: z.enum(['away', 'late_start', 'visitor_expected', 'note']).describe('What kind of plan this is'),
        text: z.string().min(2).describe('The plan in the speaker\'s own words'),
        starts_at: z.string().describe('Start, local "YYYY-MM-DD HH:MM" or ISO'),
        ends_at: z.string().describe('End, local "YYYY-MM-DD HH:MM" or ISO'),
        shift_minutes: z.number().int().min(15).max(360).optional().describe('For late_start: how much later than usual'),
        created_by: z.enum(['resident', 'family']).default('resident'),
      },
      annotations: { readOnlyHint: false, idempotentHint: false },
    },
    async ({ kind, text, starts_at, ends_at, shift_minutes, created_by }) => {
      const startsAt = parseWhen(starts_at);
      const endsAt = parseWhen(ends_at);
      if (Date.parse(endsAt) <= Date.parse(startsAt)) throw new Error('The end must be after the start.');
      const note: ContextNote = {
        id: `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        kind,
        text,
        startsAt,
        endsAt,
        createdBy: created_by,
        createdAt: store.now(),
        ...(shift_minutes ? { shiftMinutes: shift_minutes } : {}),
      };
      store.addContext(note);
      const effect: Record<string, string> = {
        away: 'I won\'t worry about a quiet house during that time.',
        late_start: 'I\'ll expect a later start.',
        visitor_expected: 'I won\'t flag the door for that visit.',
        note: 'I\'ve noted it for the family.',
      };
      // Weekday names, so a wrong day ("Friday" for "this weekend") is obvious when read back.
      const tz = h().timeZone;
      return speak(`Got it: "${text}", from ${spokenDateTime(tz, startsAt)} to ${spokenDateTime(tz, endsAt)}. ${effect[kind]}`, {
        context: note,
      });
    },
  );

  // Plans can be wrong ("this weekend" saved as Friday). These let the resident or
  // family see what's on file and take a wrong one back out.
  const planWords = (c: ContextNote) =>
    `"${c.text}" (${c.kind}), from ${spokenDateTime(h().timeZone, c.startsAt)} to ${spokenDateTime(h().timeZone, c.endsAt)}`;

  server.registerTool(
    'list_plans',
    {
      title: 'List plans on file',
      description: 'Current and upcoming plans Jirani knows about (away, late start, visitor), with their ids for cancel_plan.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const now = Date.parse(store.now());
      const plans = store
        .state()
        .contexts.filter((c) => Date.parse(c.endsAt) >= now)
        .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
      if (plans.length === 0) return speak('There are no current or upcoming plans on file.', { plans: [] });
      return speak(`Plans on file: ${plans.map((c) => `[${c.id}] ${planWords(c)}`).join('; ')}.`, { plans });
    },
  );

  server.registerTool(
    'cancel_plan',
    {
      title: 'Cancel a plan',
      description: 'Remove a plan that was saved wrongly or is no longer happening. Get the id from list_plans.',
      inputSchema: { id: z.string().describe('The plan id from list_plans') },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ id }) => {
      const plan = store.state().contexts.find((c) => c.id === id);
      if (!plan || !store.removeContext(id)) throw new Error(`No plan with id "${id}". Use list_plans to see the ids.`);
      return speak(`Cancelled ${planWords(plan)}.`, { cancelled: plan });
    },
  );

  server.registerTool(
    'answer_checkin',
    {
      title: 'Answer a check-in',
      description:
        'The resident answers Jirani\'s check-in ("I\'m fine, I slept in"), or a contact reports back after knocking. Resolves the open alert or moves it up the ladder.',
      inputSchema: {
        from: z.enum(['resident', 'contact']).describe('Who is answering'),
        contact_id: z.string().optional().describe('Required when from=contact, e.g. "joe"'),
        outcome: z
          .enum(['ok', 'call_family', 'problem', 'no_answer'])
          .describe('ok = all fine; call_family = the resident is fine and wants family to call her; problem = needs help; no_answer = nobody came to the door'),
        note: z.string().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ from, contact_id, outcome, note }) => {
      if (outcome === 'call_family' && from !== 'resident') throw new Error('Only the resident can ask family to call her.');
      if (from === 'contact' && !h().contacts.some((c) => c.id === contact_id)) {
        throw new Error(`Unknown contact "${contact_id}". Known: ${h().contacts.map((c) => c.id).join(', ')}`);
      }
      runEvaluation(store);
      const open = store.state().escalations.filter((e) => e.status === 'open');
      if (open.length === 0) return speak('Thanks. There was nothing open to answer, so no one has been worried.');
      const now = store.now();
      const updated: Escalation[] = store.state().escalations.map((e) =>
        e.status === 'open'
          ? respond(e, h(), { from, ...(contact_id ? { contactId: contact_id } : {}), outcome, ...(note ? { note } : {}) }, now)
          : e,
      );
      store.setEscalations(updated, now);
      for (const e of updated) {
        const before = open.find((o) => o.id === e.id);
        if (!before || e.history.length === before.history.length) continue;
        for (const a of e.history.at(-1)!.actions) {
          store.deliver({ at: now, escalationId: e.id, to: a.to ?? 'family', type: a.type, message: a.message });
        }
      }
      const name = h().residentName;
      const family = h()
        .contacts.filter((c) => c.relation === 'family')
        .map((c) => c.name)
        .join(' and ');
      const text =
        outcome === 'call_family'
          ? `Thank you, ${name}. I've asked ${family || 'your family'} to call you.`
          : outcome === 'ok'
          ? from === 'resident'
            ? `Thank you, ${name}. Glad you're alright. I've let anyone I'd contacted know.`
            : `Thanks. I've marked ${name} as OK and told the family.`
          : outcome === 'problem'
            ? `Understood. I've asked the family to decide whether to call 911. I will not call for them.`
            : `Thanks for trying. I'm letting the family know now.`;
      return speak(text, { escalations: updated.filter((e) => open.some((o) => o.id === e.id)) });
    },
  );

  server.registerTool(
    'pause_monitoring',
    {
      title: 'Pause Jirani',
      description:
        'The resident pauses monitoring for a few hours ("Jirani, pause for two hours"). Family can see that it was paused, not why.',
      inputSchema: {
        hours: z.number().min(0.5).max(12),
        reason: z.string().optional().describe('Private: never shown to family'),
      },
      annotations: { readOnlyHint: false, idempotentHint: true },
    },
    async ({ hours, reason }) => {
      const until = new Date(Date.parse(store.now()) + hours * 3600_000).toISOString();
      store.setPause({ until, by: 'resident', ...(reason ? { reason } : {}) });
      runEvaluation(store);
      return speak(`Okay, ${h().residentName}. I'm paused until ${hhmm(toLocal(h().timeZone, until).minutes)}. Amina will only see that I'm paused.`, {
        pausedUntil: until,
      });
    },
  );

  server.registerTool(
    'how_is_she',
    {
      title: 'How is she today?',
      description: 'For family: today in plain words, with the events behind it. Facts only.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const ev = runEvaluation(store);
      const s = store.state();
      const summary = summariseDay(h(), s.events, ev.baseline, s.escalations, s.contexts, store.now(), ev.notices);
      const paused = s.pause && Date.parse(s.pause.until) > Date.parse(store.now());
      const lines = paused ? [`Jirani is paused by ${h().residentName} until ${hhmm(toLocal(h().timeZone, s.pause!.until).minutes)}.`, ...summary.lines] : summary.lines;
      return speak(lines.join(' '), { summary });
    },
  );

  server.registerTool(
    'why_alert',
    {
      title: 'Why did Jirani alert?',
      description: 'Explains an alert: which expectation broke, by how much, what context was checked, and who was asked when.',
      inputSchema: { escalation_id: z.string().optional().describe('Defaults to the most recent alert') },
      annotations: { readOnlyHint: true },
    },
    async ({ escalation_id }) => {
      const ev = runEvaluation(store);
      const all = store.state().escalations.filter((e) => e.status !== 'logged');
      const e = escalation_id ? all.find((x) => x.id === escalation_id) : all.at(-1);
      if (!e) return speak('There haven\'t been any alerts.');
      const deviation =
        ev.deviations.find((d) => d.id === e.deviationId) ??
        ev.suppressed.find((x) => x.deviation.id === e.deviationId)?.deviation;
      // Plain, ordered sentences with names and times, so whoever relays this (voice or the
      // agent) can't reorder the ladder or guess how someone was reached.
      const name = h().residentName;
      const who = (to?: string) => {
        if (to === 'resident') return name;
        if (to === 'family' || !to) return 'family';
        const c = h().contacts.find((x) => x.id === to);
        return c ? `${c.name} (${c.relation === 'neighbour' ? 'her neighbour' : 'family'})` : to;
      };
      const did = (a: Escalation['history'][number]['actions'][number]) => {
        switch (a.type) {
          case 'chime_resident':
            // No runtime calls Ring's playback yet: there is no real Chime to try it on.
            return `played a soft tone on ${name}'s Ring Chime (simulated: no real Chime is linked)`;
          case 'checkin_resident':
            return `asked ${name} by voice and on her TV whether she was alright`;
          case 'notify_contact':
            return `messaged ${who(a.to)}`;
          case 'offer_live_view':
            return `offered ${who(a.to)} a look at the front-door camera, which ${name} had agreed to`;
          case 'suggest_emergency':
            return `told ${who(a.to)} to call 911 if they think she needs help (Jirani never calls for you)`;
          case 'all_clear':
            // Neutral on purpose: an alert can close on sensor activity, which isn't someone confirming she's OK.
            return `let ${who(a.to)} know the alert was closed`;
          case 'log':
            return 'noted it without contacting anyone';
        }
      };
      const today = toLocal(h().timeZone, store.now()).date;
      const when = (iso: string) => {
        const l = toLocal(h().timeZone, iso);
        return l.date === today ? hhmm(l.minutes) : `${hhmm(l.minutes)} on ${l.date}`;
      };
      const steps = [...e.history]
        .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
        .map((st) => {
          const seen = st.note?.match(/^Activity recorded: (.+)$/)?.[1];
          if (seen) {
            // Closed by sensors, not by a person: say so plainly so nobody retells it as "Joe confirmed".
            const told = st.actions.map((a) => who(a.to));
            return `Sensors then recorded activity (${seen}), so at ${when(st.at)} Jirani closed the alert${told.length ? ` and let ${told.join(' and ')} know` : ''}.`;
          }
          const actions = st.actions.map(did);
          const list = actions.length > 1 ? `${actions.slice(0, -1).join(', ')} and ${actions.at(-1)}` : (actions[0] ?? 'did nothing yet');
          return `${st.note ? `${st.note.replace(/\.$/, '')}, so at` : 'At'} ${when(st.at)} Jirani ${list}.`;
        });
      const contexts = store.state().contexts.filter((c) => Date.parse(c.endsAt) >= Date.parse(e.openedAt) - 86_400_000);
      const text = [
        `${e.summary}`,
        deviation
          ? `Expected: ${deviation.evidence.expected.replace(/\.$/, '')}. Observed: ${deviation.evidence.observed.replace(/\.$/, '')}.`
          : '',
        contexts.length ? `Plans I checked: ${contexts.map((c) => `"${c.text}"`).join(', ')}. None covered this time.` : 'No plans on file covered this time.',
        `What Jirani did, in order: ${steps.join(' ')}`,
        e.resolution
          ? e.resolution.by === 'Jirani'
            ? `Closed at ${when(e.resolution.at)} because sensors recorded activity. Nobody has confirmed in person that ${name} is OK.`
            : `Resolved at ${when(e.resolution.at)}: ${e.resolution.by} said "${e.resolution.note}".`
          : `Still open: nobody has confirmed ${name} is OK yet.`,
      ]
        .filter(Boolean)
        .join(' ');
      return speak(text, { escalation: e, ...(deviation ? { deviation } : {}) });
    },
  );

  server.registerTool(
    'weekly_report',
    {
      title: 'Weekly rhythm report',
      description: 'Last 7 lived-in days compared with the weeks before (with a guard week in between). Flags slow changes. Never diagnoses.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = store.state();
      const report = weeklyReport(h(), s.events, store.now(), s.contexts);
      return speak(reportSummary(report), { report });
    },
  );

  server.registerTool(
    'view_front_door',
    {
      title: 'Look at the front door',
      description:
        'Family only. Opens the Ring front-door live view, but only during a Level 3+ alert and only if the resident agreed in advance.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      runEvaluation(store);
      const open = store.state().escalations.filter((e) => e.status === 'open' && e.level >= 3);
      const consent = h().consent.liveViewAtLevel3;
      if (!consent) return speak(`${h().residentName} hasn't agreed to camera access, so I can't open it.`, { allowed: false });
      if (open.length === 0) return speak('The camera is only available during a serious alert. Right now there isn\'t one.', { allowed: false });
      const url = `${process.env.PUBLIC_WEB_URL ?? 'http://localhost:3000'}/live/front-door`;
      return speak(`Opening the front-door camera. ${h().residentName} agreed to this for situations like now.`, {
        allowed: true,
        url,
        deviceId: process.env.RING_FRONT_DOOR_DEVICE_ID ?? null,
      });
    },
  );

  // Exposed for completeness: lets an agent ground answers in the learned routine.
  server.registerTool(
    'usual_routine',
    {
      title: 'What is her usual routine?',
      description: 'The learned baseline in plain words: usual wake time, quiet spells, days learned from.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const s = store.state();
      const b = buildBaseline(h(), s.events, { now: store.now(), contexts: s.contexts });
      const text =
        b.days < 7
          ? `Still learning: ${b.days} days so far.`
          : `Learned from ${b.days} days. ${h().residentName} is usually up around ${hhmm(b.firstActivity.median)} and winds down around ${hhmm(b.lastActivity.median)}. Quiet spells at home during the day are usually under ${b.maxGap.p95 >= 90 ? `${Math.round((b.maxGap.p95 / 60) * 10) / 10} hours` : `${Math.round(b.maxGap.p95)} minutes`}.`;
      return speak(text, { days: b.days, firstActivity: b.firstActivity, lastActivity: b.lastActivity, maxGap: b.maxGap });
    },
  );

  return server;
}
