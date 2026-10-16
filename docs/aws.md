# AWS integration (AWS Builder mini challenge)

Jirani runs on AWS as four Lambda functions over one DynamoDB table, defined in
AWS CDK (TypeScript) in [`infra/`](../infra). The core engine and the MCP tools are
the same code that runs locally (`pnpm demo`); only the storage and the trigger change.

```
Ring (or ring-routine-sim) ──HMAC-signed POST──▶ WebhookFn (Function URL) ──▶ DynamoDB
Alexa+-style MCP client / dashboard ──Bearer──▶ ApiFn (Function URL: /mcp, /api/*) ◀──▶ DynamoDB
EventBridge Scheduler (every minute) ──────────▶ EvaluateFn (rhythm engine + ladder) ◀──▶ DynamoDB
Voice client / dashboard ──Bearer──▶ AgentFn (/ask) ──Converse──▶ Amazon Bedrock (Claude Sonnet 5.5)
                                         └──MCP over HTTP (Bearer)──▶ ApiFn /mcp
```

## What's built

| Piece | AWS | Code |
| --- | --- | --- |
| Ring webhook | Lambda + Function URL (no IAM auth: Ring's HMAC signature authenticates it) | `services/aws/src/lambda/webhook.ts` |
| MCP server + dashboard API | Lambda + Function URL, bearer token checked in code, stateless Streamable HTTP with JSON responses | `services/aws/src/lambda/api.ts` |
| Agent | Lambda + Function URL running a Strands agent on Amazon Bedrock; it reaches Jirani only through the MCP server, with per-speaker tool filters | `services/aws/src/lambda/agent.ts`, `services/agent/src/agent.ts` |
| Rhythm engine heartbeat | Lambda, invoked by EventBridge Scheduler (`rate(1 minute)` by default) | `services/aws/src/lambda/evaluate.ts` |
| State | DynamoDB, single table, on-demand, TTL on idempotency keys | `services/aws/src/dynamo-store.ts` |
| Email | DynamoDB Stream on new outbox items → NotifyFn → Amazon SES; WeeklyFn on an EventBridge Scheduler cron (optional, `-c senderEmail`) | `services/aws/src/notify.ts`, `services/aws/src/lambda/notify.ts`, `weekly.ts` |
| Secrets | Secrets Manager: Ring HMAC key + API token, generated at deploy; functions get only the ARNs | `services/aws/src/config.ts` |
| Logs | CloudWatch log group per function, 1-week retention | `infra/lib/jirani-stack.ts` |
| Cost guard | Optional AWS Budgets alert at $10/month (`-c budgetEmail=...`) | `infra/lib/jirani-stack.ts` |

All functions: Node.js 22, arm64, ESM bundles built by esbuild during `cdk synth`. Only the
agent's role may call Bedrock (`bedrock:InvokeModel*` on foundation models and inference profiles).

### Single-table keys

`PK = HOUSE#<id>`, and `SK` is one of:

| SK | Item |
| --- | --- |
| `EVENT#<at>#<eventId>` | Ring event |
| `REQ#<requestId>` | webhook idempotency key, `ttl` 7 days |
| `CTX#<id>` | context note ("at my sister's Saturday") |
| `ESC#<id>` | escalation, with a version number `v` |
| `OUT#<at>#<seq>#<uuid>` | message Jirani sent (`seq` keeps same-instant messages in order) |
| `META#state`, `META#pause`, `META#clock` | last evaluation time, pause, demo clock |

### Correctness choices worth knowing

- **Exactly-once webhook storage.** The idempotency key (`REQ#`) and the event are written
  in one DynamoDB transaction, so a crash between them can't lose an event when Ring retries.
- **No lost answers, no double messages.** Each request loads a snapshot, runs the same pure
  core code, and writes only what changed in one transaction. Escalations carry a version;
  if the scheduler and an MCP call (e.g. Joe's "she's fine") touch the same alert at once,
  one transaction fails and that request re-runs on fresh data instead of overwriting the other.
  Writes over 100 items (only the first evaluation after a bulk replay) are split into
  several transactions and lose that all-or-nothing guarantee.
- **Bounded reads.** Each request loads the last 45 days of events: enough for the
  28-lived-in-day baseline and the drift report, with room for away days.

## Deploy

Prerequisites: an AWS account, AWS CLI credentials (`aws configure` or SSO), Node 22, pnpm.

```bash
pnpm install
pnpm aws:synth                                   # optional: build and check the template locally
pnpm --filter @jirani/infra exec cdk bootstrap   # once per account/region
pnpm aws:deploy                                  # us-east-1 by default (where you enabled Bedrock)
```

Options (append them directly, e.g. `pnpm aws:deploy -c demo=true`; with `--` in between, pnpm drops them):

| Context | Effect |
| --- | --- |
| `-c demo=true` | Enables `POST /demo/clock` so the video can fast-forward time against the real stack |
| `-c corsOrigins=https://jirani.app,http://localhost:3000` | Browser origins for the dashboard and voice client |
| `-c evaluateEveryMinutes=0` | Removes the schedule (nothing recurring left) |
| `-c budgetEmail=you@example.com` | $10/month AWS Budgets alert at 80% and 100% |
| `-c senderEmail=... -c contactEmails=... -c dashboardUrl=...` | Email escalation messages and the weekly report through SES (see Email below) |
| `-c bedrockModelId=<id>` | Bedrock model or inference profile for the agent (default `anthropic.claude-sonnet-5-5`) |

The deploy prints `WebhookUrl`, `McpUrl`, `ApiUrl`, `AskUrl` and the two secret names. Read the secrets with:

```bash
aws secretsmanager get-secret-value --secret-id <RingHmacKeySecret> --query SecretString --output text
aws secretsmanager get-secret-value --secret-id <ApiTokenSecret> --query SecretString --output text
```

Fill the stack with four weeks of Margaret's life, then talk to it:

```bash
pnpm sim generate --preset demo --out data/demo.ndjson
pnpm sim replay --file data/demo.ndjson --url <WebhookUrl> --key <ring hmac key>

curl -H "Authorization: Bearer <api token>" <ApiUrl>api/state
npx @modelcontextprotocol/inspector   # Streamable HTTP, URL = McpUrl, header Authorization: Bearer <api token>

curl -X POST <AskUrl> -H "Authorization: Bearer <api token>" -H "Content-Type: application/json" \
  -d '{"question": "How is Mum this week?", "as": "family"}'
```

### The agent and Bedrock

Before the first `/ask`, open the Bedrock console in us-east-1 and make sure the account can
use Claude Sonnet 5.5 (model access, and quotas above 0). The agent uses the Bedrock model ID
`anthropic.claude-sonnet-5-5`. If Bedrock answers that on-demand throughput isn't supported for
that ID, redeploy with the inference profile ID the console shows for the model:
`pnpm aws:deploy -c bedrockModelId=<inference profile id>`. Neither has been tried against a real
account yet. The agent sends no `temperature` or `topP`: Claude Sonnet 5.5 rejects non-default
sampling settings.

What the agent may do depends on who is speaking (`"as"`):

| Speaker | MCP tools |
| --- | --- |
| `resident` (Margaret) | `tell_jirani`, `answer_checkin`, `pause_monitoring`, `usual_routine` |
| `family` (Amina) | `tell_jirani`, `answer_checkin`, `how_is_she`, `why_alert`, `weekly_report`, `view_front_door`, `usual_routine` |

Locally, against `pnpm mcp`, with your own AWS credentials: `pnpm ask "How's Mum this week?"`
or `pnpm ask --as resident "I'm at my sister's Saturday"`.

With a real Ring app, replace the generated HMAC key with the one Ring issued:
`aws secretsmanager put-secret-value --secret-id <RingHmacKeySecret> --secret-string '<key>'`
(the webhook function caches it per container, so redeploy or wait for new containers).

Tear everything down, data included: `pnpm aws:destroy`.

## Email (Amazon SES)

Optional: deployed only with `-c senderEmail=...`. Without it, messages stay in the outbox
and show on the dashboard (`/api/state`), and nothing is emailed.

```
ladder decides ─▶ OUT# item (same transaction as the escalation) ─▶ DynamoDB Stream (INSERT, SK begins with OUT#)
  ─▶ NotifyFn ─▶ Amazon SES ─▶ Joe / Amina        and every Sunday 6pm (New York time): WeeklyFn ─▶ family
```

- Escalation steps never wait on email: the ladder writes the message, and the notifier sends it.
  A failed send is retried for that record only (`ReportBatchItemFailures`), up to 5 times.
- Each item is marked `emailedAt` after sending and skipped if already marked, so a stream
  redelivery doesn't email twice. If the mark itself fails after a send, a retry can send a
  duplicate (at-least-once).
- Margaret's own check-ins are not emailed; she's reached by voice and on the TV. `family`
  messages (live-view offer) go to every family contact.

Setup (SES starts in the sandbox: both the sender and every recipient must be verified):

```bash
aws sesv2 create-email-identity --email-identity jirani@yourdomain.com      # sender
aws sesv2 create-email-identity --email-identity you+joe@gmail.com           # each recipient, in the sandbox
aws sesv2 create-email-identity --email-identity you+amina@gmail.com
# click the verification link in each email, then:
pnpm aws:deploy -c senderEmail=jirani@yourdomain.com \
  -c contactEmails=joe=you+joe@gmail.com,amina=you+amina@gmail.com \
  -c dashboardUrl=https://your-dashboard-url
```

Context values are not remembered between deploys: pass the same `-c` flags every time, or put
them in `infra/cdk.context.json` (git-ignored, since it would hold personal email addresses):
`{"senderEmail": "...", "contactEmails": "...", "dashboardUrl": "..."}`.

## Cost

Rough, not measured yet. Bedrock is billed per token for each `/ask`; nothing calls it on a
schedule. The only recurring work is the evaluation schedule (about
43,000 Lambda invocations a month at one per minute), which should sit inside the Lambda
and EventBridge Scheduler free tiers. DynamoDB on-demand reads for those evaluations
should be cents a month at demo scale. The two Secrets Manager secrets are the main fixed
cost, about $0.40 each per month, prorated. Replace these estimates with the real numbers
from Cost Explorer after a few days. To stop all recurring work without destroying data:
`pnpm aws:deploy -c evaluateEveryMinutes=0`.

## Testing without AWS

```bash
pnpm ddb:local    # in one terminal: DynamoDB Local in Docker
pnpm test:aws     # the DynamoDB store and all three Lambda handlers, end to end
```

`services/aws/test/lambda.test.ts` serves the real handlers behind a Function-URL-shaped
HTTP shim, replays signed simulator events into the webhook, drives the API with the
MCP SDK client through the whole story (no false alarm, the ladder, the all-clear), and
calls `/ask` with a scripted model standing in for Bedrock. `services/agent/test` runs the
real Strands agent loop against the real MCP server the same way. These tests check the
wiring, not the model's answers; that needs a real Bedrock run.
`infra/test/stack.test.ts` checks the synthesized CloudFormation template. CI runs both,
with DynamoDB Local as a service container.

## Not built yet

| Piece | Plan |
| --- | --- |
| Ladder timers | One-off EventBridge Scheduler schedules per escalation step, instead of the every-minute heartbeat |
| Households | One demo household is built into the code (`demoHousehold()`); multi-household config is not done |
