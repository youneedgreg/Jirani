# Product feedback

Feedback on every tool, API and SDK Jirani used, as submitted to the Amazon Developer Hackathon: what it was used for, what worked, what needs work, onboarding, and whether I'd build with it again. Problems with full steps and suggestions are in the [friction log](friction-log.md).

## Ring Developer Playground

- Used it for: Getting a Ring API token without a Ring device, exploring the API, and running Jirani's Ring client against the real API (`api.amazonvision.com`). Also the Ring developer console, to create Jirani's private app (Cameras and Doorbells, Contact Sensors, Chimes with Chime Controls).
- Worked well: The one-click OAuth token and the interactive API explorer: a first working `GET /v1/devices` from my own client in one sitting, with no Ring hardware and no account linking. The simulated live-view streams (Package, Vehicle, Motion) mean a camera feature can be built without owning a device.
- Needs work: The Playground has one doorbell, an empty event history and no webhook delivery, so an event-driven app (Jirani is a caretaking monitor) has nothing to react to. I built and open-sourced my own feeder (`ring-routine-sim`) that sends Ring webhook v1.1 payloads, signed the way Ring signs them. A simulated contact sensor and a "send test webhook" button would have saved days. The full token appears again in every curl sample, so any screenshot of the explorer leaks it. In the console, creating the app was the confusing part: it wasn't clear which scope groups an app like Jirani needs, or which of the keys (client ID, client secret, HMAC key) is used where (OAuth versus webhook signing). The 30-minute token is short for a long debugging session.
- Onboarding (zero to hello world): Quick for the API: the one-click token and the explorer got a real `/v1/devices` call working in one sitting (I didn't time it). Slower for the app setup, because of the scopes and keys above.
- Would I build with it again? Yes, with caveats: the real API is clean and caretaking fits Ring well, but the Playground needs simulated events and sensors before an event-driven app can be tested end to end without a custom simulator.

## Ring Partner API (devices, capabilities, history, webhooks)

- Used it for: Jirani's typed Ring client (devices, status, capabilities, event history, the user endpoint) and the Ring webhook receiver the whole pipeline is built on (HMAC-SHA256 verification, then Ring's webhook v1.1 payload). Live view (WHEP) is next.
- Worked well: Everything I called worked first time with a Playground token: `GET /v1/devices` (plain, with `?include=status,capabilities`, and with all four includes), a single device, its status and capabilities, `/v1/history/devices/{id}/events` and `/v1/users/me` all returned 200, and the JSON:API shape needed no client changes. The webhook signature scheme (`X-Signature: sha256=<hex>` over the raw body) was simple to implement; Jirani accepts 1,024 signed simulated events locally in the v1.1 format.
- Needs work: The docs are one very long page. The main Event Types table lists ten camera and account events, and the contact-sensor events (`contact_sensor_faulted` for opened, `contact_sensor_cleared` for closed) sit much further down in the Early Access "Sensors" section. I missed them on the first read and built against guessed names and an older envelope, which real webhooks would have failed; the fix was to parse Ring's example payloads verbatim in tests. Listing every event in the main table and splitting the docs into pages would prevent that. Sensors and Chimes are Early Access, so they can't be exercised in the Playground.
- Onboarding (zero to hello world): Fast once I had a token: the first real call worked with no changes to my client.
- Would I build with it again? Yes: clean, predictable API and a simple, well-specified signature scheme.

## Ring Appstore MCP server

Not used. It is a documentation server for AI coding assistants (`search_docs`, `get_doc` over the Ring Appstore docs), and we read the Ring docs directly. Jirani's own MCP server is a different thing: it is the product's interface for Alexa+ and family, with tools about Margaret's day.

## AmazonAppDev/ring-api-helloworld

- Used it for: The starting point of Jirani's family dashboard. We kept the Ring live-view sample at `/sample` and built the family pages, a voice client and sign-in around it.
- Worked well: A real, working Next.js app with WebRTC live view is a far better start than a blank project. The environment-variable table in the README is clear, and the fork imported into Vercel as a normal Next.js project.
- Needs work: `npm audit` on an unchanged clone reports 17 vulnerabilities, including one critical in `next` 15.5.18, so the first thing a team ships from this sample is a known-vulnerable framework version. `/api/ring/token` returns the Ring token to any caller, which is fine on localhost but dangerous the moment the sample is deployed; a warning in the README, or putting it behind a flag, would help. `POST /api/webhook` only checks a bearer token when `RING_WEBHOOK_SECRET` is set, so it is open by default.
- Onboarding (zero to hello world): Under an hour to see the sample running; without a Ring token it shows a clear configuration message.
- Would I build with it again? Yes, as a starting point, after upgrading Next.js.

## MCP TypeScript SDK (@modelcontextprotocol/sdk 1.32, spec 2025-11-25)

- Used it for: Jirani's MCP server: 10 tools over stateless Streamable HTTP at `POST /mcp`, served locally and from a Lambda Function URL. Also its client, to drive the server in our end-to-end demo.
- Worked well: Zod input schemas and tool annotations (`readOnlyHint`) keep each tool definition short and self-documenting. The same server code runs under Express locally and inside Lambda. Connecting the MCP Inspector (2.11) to the deployed server with a bearer header worked first time, and every call showed up in its protocol log with timings.
- Needs work: In Inspector 2.11, custom headers live under each server's Settings → Custom Headers rather than in the add-server form, which took a while to find, and the header value field is plain text, so a bearer token is visible on screen while you type it.
- Onboarding (zero to hello world): An hour or two to a first tool over Streamable HTTP.
- Would I build with it again? Yes: it is how Jirani reaches Alexa+ and any other MCP client.

## Amazon Bedrock

- Used it for: The agent's model, Amazon Nova 2 Lite through the EU cross-region inference profile (`eu.amazon.nova-2-lite-v1:0`), called from a Strands agent.
- Worked well: Nova 2 Lite needed no agreement or form, does tool calling through Converse, and is cheap: 42 test calls cost about $0.03, and one question to Jirani costs under 0.2 cents.
- Needs work: We first planned to use Anthropic Claude Sonnet 5.5. On a new free-plan project, calls kept returning "not available for this account … contact AWS Sales" even after the use-case form was approved and the Marketplace agreement showed `AVAILABLE`. A first playground message didn't create the agreement; that took an explicit `CreateFoundationModelAgreement` call. In eu-north-1 the model was only callable through an inference profile. Nova's quirks: prompt rules were sometimes ignored until placed next to the tool they concern, and "Sunday evening" varied between 18:00 and 22:00 across identical calls at temperature 0.
- Onboarding (zero to hello world): A few hours lost on Claude's access, then about 15 minutes to a first Amazon Nova answer.
- Would I build with it again? Yes. Nova is cheap and its tool calling works; next time I'd check model access on a new project before designing around a model.

## Strands Agents TypeScript SDK

- Used it for: Jirani's agent (`services/agent`, SDK 1.21), which answers Margaret and her family in a sentence or two and can only reach Jirani through our MCP server.
- Worked well: It worked with Amazon Nova 2 Lite on Bedrock with no special handling, including tool calls. Giving each role its own tool list (Margaret can pause monitoring, family can't; family can ask for the front-door camera, Margaret's side can't) was a few lines. A scripted stand-in model let us test the agent's wiring without paying for model calls.
- Needs work: Nothing in the SDK slowed us down. One friction was ours, not the SDK's: serving the agent from the MCP package created a pnpm workspace cycle, which we fixed by starting the server from the agent package.
- Onboarding (zero to hello world): Under an hour to a first agent answering through our MCP server.
- Would I build with it again? Yes: it worked with Amazon Nova out of the box, and per-role tool lists took a few lines.

## AWS Lambda

- Used it for: Six functions on Node.js 22: Ring webhook, MCP server plus the dashboard's read API, the agent, the every-minute evaluator, the email notifier, and the weekly report.
- Worked well: Function URLs gave each public endpoint an HTTPS address without API Gateway; we check a bearer token in code and set CORS per URL. CDK's esbuild bundling turned TypeScript into small bundles with source maps, and a code update of all six functions deployed in about 37 seconds.
- Needs work: The agent's bundle is 1.7 MB (it includes the Strands SDK and the AWS SDK), so esbuild warns about its size.
- Onboarding (zero to hello world): Under an hour to a first function, defined and bundled through CDK.
- Would I build with it again? Yes: Function URLs kept the public endpoints simple.

## Amazon DynamoDB

- Used it for: Jirani's single table: Ring events, Margaret's plans and context, open alerts and the escalation ladder. A keys-only stream triggers the email notifier.
- Worked well: DynamoDB Local in Docker (`amazon/dynamodb-local`) let us run the real store and all the Lambda handlers end to end in 17 tests, on a laptop, with no AWS account. On-demand capacity meant no sizing decisions for a demo. Streams made "send an email when an alert changes" a small, separate function instead of logic inside the ladder.
- Needs work: Nothing blocked us.
- Onboarding (zero to hello world): Under an hour, starting on DynamoDB Local.
- Would I build with it again? Yes.

## Amazon EventBridge Scheduler

- Used it for: Two schedules: the rhythm engine and escalation ladder every minute, and the weekly report every Sunday at 18:00 New York time.
- Worked well: Schedules take a real time zone (`America/New_York`), so the weekly report follows Margaret's clock, daylight saving included, without any conversion code. Defining both in CDK was a few lines each; we set retries to zero so a failed run isn't repeated alongside the next one.
- Needs work: An every-minute schedule keeps running while you replay test data, and in our first version it evaluated a half-replayed day and left a stale "no morning activity" alert open. The fix was ours (alerts now close themselves when late events show activity), but it is an easy trap with any frequent schedule.
- Onboarding (zero to hello world): Minutes; CDK defined both schedules.
- Would I build with it again? Yes, for the time-zone support alone.

## Amazon SES

- Used it for: Real alert emails to the neighbour and family, plus the weekly report, sent by the notifier and weekly Lambda functions.
- Worked well: Sending is a single SESv2 `SendEmail` call. Gmail plus-addresses (`name+joe@…`) let one inbox stand in for three people in the demo.
- Needs work: New accounts start in the sandbox: 200 emails a day, one per second, and every recipient must be verified, which is fine for a demo but not for real families. Sending "from" a gmail.com address through SES isn't DMARC-aligned, so our test emails landed in spam; the console could warn about this when you verify a free-mail sender.
- Onboarding (zero to hello world): Under an hour to the first email, including verifying the sender and recipients.
- Would I build with it again? Yes for alerts, after leaving the sandbox and sending from our own domain.

## AWS CDK

- Used it for: The whole stack in `infra/`: DynamoDB, six Lambda functions with Function URLs, Bedrock access, EventBridge Scheduler, SES permissions and Secrets Manager, in eu-north-1.
- Worked well: `cdk diff` builds a read-only change set, so before a redeploy we could see exactly what would change (in our case: new code for six functions, CORS, one environment variable, nothing replaced). Bootstrap was one command.
- Needs work: `AWS::Budgets::Budget` doesn't exist in CloudFormation in eu-north-1 (`DescribeType` returns `TypeNotFoundException`), so adding a budget to the stack failed the whole deploy; the Budgets API itself works there. Running `cdk` through `pnpm --filter … exec` broke esbuild bundling ("Command "esbuild" not found"), while a package script worked. A service control policy on our project denies `cloudformation:DescribeType` in us-east-1.
- Onboarding (zero to hello world): A few hours to the first deploy, mostly lost to the budget and bundling problems above.
- Would I build with it again? Yes: seeing a diff before every deploy is worth it.

## Vega SDK / Vega Virtual Device

- Used it for: Running Jirani's check-in card in the Vega version of the TV app on the Vega Virtual Device (SDK 0.24.12112, Vega CLI 1.4.5, Apple-silicon Mac), against a local Jirani.
- Worked well: The `vega` CLI install (`vega sdk install`): once started, about 13 minutes to download and 5.4 GB installed. The Virtual Device booted in about 25 seconds (`vega virtual-device start`). `build:vega:debug` and `vega run-app` worked first time: the card showed over the app, and pressing "I'm OK" with the remote resolved the alert and sent the family the all-clear. `vega device start-port-forwarding --port 3333 --forward false` let the device reach the Mac's local server with no config change.
- Needs work: The prerequisites are heavy for a small card: about 20 GB free disk, a developer-portal sign-in, Rosetta and eight Homebrew packages, and telemetry on by default. The install docs are marked open beta and describe 0.21 while the sample targets 0.24, and the sample's docs still use the old `kepler` command names. The first SDK download timed out on the network, and a retry starts from zero. `~/vega/env` was written before any SDK existed, so it had no `KEPLER_SDK_PATH` until I added it. The Virtual Device is a plain QEMU window: I couldn't find a documented way to take a screenshot or send remote keys from a script, so every check was by hand.
- Onboarding (zero to hello world): Long but doable: spread over two days (prerequisites on 19 Oct, the SDK and the first run on 20 Oct), most of it in setup rather than code. The card itself is shared React Native code; the Vega app only needed the screen wired into its own navigators.
- Would I build with it again? Yes, with caveats: the same React Native card runs on Vega with only navigation wiring, but the SDK is heavy to install and the Virtual Device can't be scripted or screenshotted, which makes automated testing hard.

## react-native-multi-tv-app-sample

- Used it for: The TV app shell for Jirani's check-in card: a card over whatever Margaret is watching, with "I'm OK" and "Call Amina", in the Expo app and the Vega app.
- Worked well: One codebase for Android TV, Fire TV, tvOS, web and Vega, with remote-control focus handling already done. The web build (`yarn dev:web`, arrow keys and Enter as the remote) made the card quick to test without any emulator.
- Needs work: `tsc` fails on a clean clone of `main` (76 errors for Expo, 16 for Vega, mostly "Cannot find module 'react-native'" from `shared-ui`, caused by `nmHoistingLimits: workspaces`), so we verified our code by bundling and running it instead. `expo start` warns that about 19 packages don't match Expo 54.
- Onboarding (zero to hello world): A few hours to the card on the web build, mostly lost to the `tsc` errors and the Expo version warnings.
- Would I build with it again? Yes: the multi-platform shell and remote-control focus handling are worth it.
