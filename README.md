# Jirani

**The neighbour who notices.** *Jirani* is Swahili for neighbour.

Jirani is a privacy-first caregiving agent for older adults who live alone. It learns a person's daily rhythm from Ring signals (door and contact sensors, doorbell motion and presses), never from video by default. When a day breaks pattern and nothing she told it explains why, Jirani asks **her** first, then a neighbour, then family with the evidence. A weekly report notices slow changes a timer never would.

> Statistics decide when something is off. The agent only explains it and picks the next step.

Built for the [Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/) (Ring track + Alexa+ track, AWS Builder and Open Source mini challenges).

## Try it in one command

```bash
pnpm install
pnpm demo
```

No AWS account, Ring device or API keys needed. The demo starts the real server, replays four weeks of signed Ring-shaped events through the real webhook (HMAC-verified), and drives the real MCP server over Streamable HTTP with an MCP client, the way an Alexa+ experience would:

1. **No false alarm.** Margaret tells Jirani she'll be at her sister's this weekend. On Sunday the house is silent, and nobody is bothered.
2. **The ladder.** Monday 10:05, no morning activity and no plan explains it. Jirani checks in with Margaret, then asks Joe next door, then tells Amina with the evidence and (with Margaret's prior consent) the front-door camera. Joe finds her in the garden; everyone gets the all-clear.
3. **Slow drift.** The weekly report notices night-time bathroom trips rising over three weeks and suggests a conversation with her doctor. It never diagnoses.
4. **She stays in charge.** "Jirani, pause for two hours."

## How it decides

| Situation | Signal | Default threshold |
| --- | --- | --- |
| No morning activity | Nothing but a lone bathroom trip after 5am | Later than her median wake time + max(2.5 robust SD, 45 min) |
| Usual thing missing | Fridge or medicine cabinet not opened after getting up | Typical delay + max(3 robust SD, 60 min); low severity, logged only |
| Unusual event | Door or doorbell at an hour seen on under 4% of days | Front door / doorbell at night is high severity |
| Long stillness | No activity at home during waking hours | max(1.25 × her 95th-percentile quiet spell, 3 h); not after leaving by the front door |
| Slow drift | Last 7 lived-in days vs up to 21 days ending a week earlier (a guard week, so a slow rise isn't its own baseline); only days she was home for the morning count | ≥ 2.5 standard errors **and** a practical change (e.g. +1 night trip) |

Context Margaret or Amina gives (`away`, `late_start`, `visitor_expected`) suppresses or shifts these, and every suppression keeps its reason so `why_alert` can explain it. A sensor that goes offline is a maintenance notice, never an emergency. Days she was away are never learned as "normal".

**Measured on simulated households** (`packages/core/test/scenarios.test.ts`, 40 seeds): the weekly report caught a three-week rise in night trips in 31 of 40 households, and flagged 0 of 40 steady routines.

## The escalation ladder

| Level | Who | Waits |
| --- | --- | --- |
| 0 | Logged only (small deviations) | n/a |
| 1 | Margaret: voice check-in + Fire TV card | 20 min |
| 2 | Neighbour: "Could you knock?" | 20 min |
| 3 | Family, with the evidence; live view only if Margaret consented | family decides |
| 4 | Suggest calling 911 with a summary ready | a human decides; Jirani never calls |

## MCP server (Alexa+ track)

Spec **2025-11-25**, **Streamable HTTP**, stateless (`POST /mcp`). Run it with `pnpm mcp`.

| Tool | For | What it does |
| --- | --- | --- |
| `tell_jirani` | Margaret, Amina | Save a plan with start/end ("at my sister's Saturday") |
| `list_plans` | Margaret, Amina | Current and upcoming plans, with ids |
| `cancel_plan` | Margaret, Amina | Remove a plan that was saved wrongly or is off |
| `answer_checkin` | Margaret, Joe | Resolve or escalate the open alert |
| `pause_monitoring` | Margaret | Pause for N hours; family sees *that* it's paused, not why |
| `how_is_she` | Amina | Today in plain words, from real events |
| `why_alert` | Amina | Which expectation broke, by how much, what context was checked, who was asked when |
| `weekly_report` | Amina | The drift report |
| `view_front_door` | Amina | Ring live view, only at Level 3+ and only with consent |
| `usual_routine` | anyone | The learned baseline in plain words |

## The agent (Amazon Bedrock)

A [Strands](https://strandsagents.com) agent on Amazon Bedrock (Amazon Nova 2 Lite) answers Margaret and Amina in a sentence or two. It can only reach Jirani through the MCP server above, and only with the tools allowed for whoever is speaking: Margaret's pause control isn't available to family, and the front-door camera isn't a tool on her side. It must cite what the tools returned, say "I don't know" otherwise, and never diagnose.

```bash
pnpm ask "How's Mum this week?"                       # needs AWS credentials with Bedrock access
pnpm ask --as resident "I'm at my sister's Saturday"
```

## Repository

```
packages/core              rhythm baseline, deviations, context, escalation ladder, drift report (pure TS, no I/O)
packages/ring              Ring Partner API client, webhook schemas, HMAC-SHA256 verification
packages/ring-routine-sim  weeks of Ring-shaped household events + signed replay (published separately, MIT)
services/webhook           framework-agnostic Ring webhook handler (Express locally, Lambda in AWS)
services/mcp               MCP server, dashboard API, local runtime, the demo
services/agent             Strands agent on Bedrock that answers through the MCP server
services/aws               DynamoDB store + Lambda handlers (webhook, MCP/API, agent, scheduled evaluation)
infra/                     AWS CDK app: DynamoDB, Lambda + Function URLs, Bedrock access, EventBridge Scheduler, Secrets Manager
docs/                      aws.md, feedback.md, friction-log.md
```

| Command | What it does |
| --- | --- |
| `pnpm demo` | The whole story end to end |
| `pnpm test` / `pnpm coverage` | Six roadmap scenarios, ladder, drift statistics, webhook, MCP, agent wiring, CDK stack |
| `pnpm ask "<question>"` | Ask the Bedrock agent (`--as resident` for Margaret's side) |
| `pnpm ddb:local` + `pnpm test:aws` | DynamoDB store and all three Lambda handlers, end to end on DynamoDB Local |
| `pnpm aws:deploy` / `pnpm aws:destroy` | Deploy to / remove from your AWS account (see [docs/aws.md](docs/aws.md)) |
| `pnpm aws:story <thursday --plan\|sunday\|monday\|tuesday\|all>` | Play the demo story against the deployed stack, step by step (`--local` for `pnpm mcp`; see [docs/aws.md](docs/aws.md)) |
| `pnpm mcp` | Local server: `/mcp`, `/ring/webhook`, and the dashboard's read API `/api/state`, `/api/report`, `/api/timeline` (today's events in plain words), `/api/days` (28 days of rhythm for the chart) |
| `pnpm sim presets` | List simulated households |
| `pnpm sim generate --preset demo --out data/demo.ndjson` | Generate events |
| `pnpm sim replay --file data/demo.ndjson --url http://localhost:3333/ring/webhook --key dev-only-change-me` | Replay them, signed |

## Status

Built during the hackathon submission window. Working today: the core engine, Ring webhook verification, the Ring API client, the simulator, the MCP server, the end-to-end demo, the AWS stack in CDK (DynamoDB, Lambda functions with Function URLs, EventBridge Scheduler, Secrets Manager), tested against DynamoDB Local, the Strands agent, tested with a scripted stand-in model, and email delivery through Amazon SES (escalation messages and a weekly report), tested with a fake sender. In progress: the first real deployment, Bedrock run and SES send, the family dashboard and voice client, the Fire TV check-in card, and live Ring Developer Playground integration.

**Ring data honesty:** the Ring Developer Playground provides simulated live-view streams but no motion, doorbell or sensor events, so event data in this repo comes from `ring-routine-sim`, in the Ring webhook v1.1 shape, signed exactly like Ring signs webhooks. Contact-sensor event names are an assumption until confirmed against Ring's docs.

**Not a medical device.** Jirani describes changes in routine and suggests conversations. It does not diagnose anything and never contacts emergency services itself.

## License

MIT. See [LICENSE](LICENSE).
