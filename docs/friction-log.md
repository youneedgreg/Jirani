# Friction log

Submissions with friction logs can earn up to a 10% judging bonus. Log only what
actually happened to you, the moment it happens. One entry per problem.

Template:

```markdown
### <Short title>
- Date:
- Task: <what you were trying to do>
- Steps: <numbered, exact>
- Expected vs actual: <one line each>
- Severity: blocker / major / minor
- Workaround: <what you did>
- Suggestion: <one concrete, actionable fix>
```

## Entries

### Claude on Bedrock stayed blocked on a new free-plan project
- Date: 17 Oct 2026
- Task: Run the agent on Claude Sonnet 5.5 through Amazon Bedrock in eu-north-1.
- Steps:
  1. Submitted the Anthropic use-case form in the Bedrock console.
  2. Created the Marketplace agreement (pay-per-use offer); its status showed `AVAILABLE`.
  3. Called the model through the EU inference profile with the Converse API.
- Expected vs actual: Expected calls to work once the form and agreement were in place. Actual: `AccessDeniedException` saying the model is not available for this account and to contact AWS Sales.
- Severity: blocker
- Workaround: Switched the agent to Amazon Nova 2 Lite (`eu.amazon.nova-2-lite-v1:0`), which needed no form or agreement.
- Suggestion: Say up front (in the model catalog and in the error) that new free-plan projects can't call this model, and what unlocks it, instead of a "contact AWS Sales" dead end after the form and agreement succeed.

### The Bedrock playground didn't create the Marketplace agreement
- Date: 17 Oct 2026
- Task: Enable a third-party model by sending a first message in the Bedrock playground.
- Steps:
  1. Opened the model in the Bedrock chat playground and sent a message.
  2. Checked the model's agreement status.
- Expected vs actual: Expected the first message to create the agreement. Actual: no agreement existed; it needed an explicit `CreateFoundationModelAgreement` call.
- Severity: minor
- Workaround: Created the agreement with the API.
- Suggestion: Either create the agreement on first use as described, or show a "Create agreement" button in the playground when it's missing.

### In eu-north-1, models are only callable through inference profiles
- Date: 17 Oct 2026
- Task: Call a Bedrock model from Lambda in the project's only Region (eu-north-1).
- Steps:
  1. Called Converse with the plain model ID.
  2. Called it again with the `eu.` inference-profile ID.
- Expected vs actual: Expected the plain model ID to work in a Region where the model is listed. Actual: only the inference-profile ID works.
- Severity: minor
- Workaround: Use `eu.<model-id>` (and not `global.`, which can route outside the EU).
- Suggestion: In the model catalog, show "available in this Region only through the EU inference profile" next to the model, with the exact ID to copy.

### CloudFormation in eu-north-1 has no AWS::Budgets::Budget, so one budget fails the whole deploy
- Date: 17 Oct 2026
- Task: Add a $10 cost budget with an email alert to the CDK stack.
- Steps:
  1. Added `budgets.CfnBudget` to the CDK stack and ran `cdk deploy` in eu-north-1.
  2. Investigated with `aws cloudformation describe-type --type RESOURCE --type-name AWS::Budgets::Budget` in eu-north-1, then tried us-east-1.
- Expected vs actual: Expected the budget to be created with the stack. Actual: the deploy failed; `DescribeType` in eu-north-1 returned `TypeNotFoundException`, and in us-east-1 a service control policy denied `cloudformation:DescribeType`. The Budgets API itself works from the CLI.
- Severity: major
- Workaround: Removed the budget from the stack; budgets are created in the Billing console or with the CLI.
- Suggestion: Make `AWS::Budgets::Budget` available in every commercial Region, or have `cdk synth` warn when a resource type isn't supported in the target Region.

### SES sandbox emails sent "from" a Gmail address land in spam
- Date: 17 Oct 2026
- Task: Send escalation emails and the weekly report through Amazon SES.
- Steps:
  1. Verified a Gmail plus-address as sender and three recipients (SES sandbox).
  2. Sent test emails through SES.
- Expected vs actual: Expected the emails in the inbox. Actual: they went to spam; mail "from" gmail.com sent by SES isn't DMARC-aligned.
- Severity: minor
- Workaround: Told testers to check spam; a verified domain would fix it.
- Suggestion: When someone verifies a single address at a consumer mail provider, show a warning that mail will fail DMARC and suggest verifying a domain.

### The Ring Developer Playground has no sensors and records no events
- Date: 20 Oct 2026
- Task: Test Jirani's Ring integration end to end, including contact-sensor webhooks.
- Steps:
  1. Generated a Playground token and listed devices: one "Playground Device" (a doorbell).
  2. Opened Event History for it: `{"data": []}`.
  3. Looked for a way to trigger motion, doorbell or sensor webhooks.
- Expected vs actual: Expected a simulated sensor and a way to fire webhooks at a test URL. Actual: one doorbell, empty event history, and only simulated live-view streams; no webhook delivery.
- Severity: major
- Workaround: Built `ring-routine-sim` (open source) to generate weeks of Ring-shaped events and replay them, signed, to the webhook.
- Suggestion: Add a simulated contact sensor to the Playground and a "send test webhook" button that posts a signed sample event to a partner URL.

### Sensor webhook names and payload are easy to miss in the Ring docs
- Date: 20 Oct 2026
- Task: Confirm the webhook payload and contact-sensor event names Jirani should accept.
- Steps:
  1. Read the "Event Types" table under Notifications in the Ring API docs.
  2. Found the sensor events much further down, in the separate Early Access "Sensors" section.
- Expected vs actual: Expected every webhook event type in the main Event Types table. Actual: the table lists ten camera and account events; contact sensors (`contact_sensor_faulted` for "opened", `contact_sensor_cleared` for "closed") live in a section far further down the single page (about 370,000 characters). An earlier reading missed them, so Jirani guessed `_opened`/`_closed` and an older envelope, which a real Ring webhook would have failed.
- Severity: major
- Workaround: Fixed the receiver and simulator to Ring's documented v1.1 payload and added tests that parse Ring's example payloads verbatim.
- Suggestion: List sensor events in the main Event Types table (marked Early Access), and split the API docs into separate pages per area.

### The Playground prints the OAuth token in every curl sample
- Date: 20 Oct 2026
- Task: Share a Playground screenshot while working through the API explorer.
- Steps:
  1. Generated a token.
  2. Opened Explore APIs → Device List.
- Expected vs actual: Expected the token to appear once, masked. Actual: the full token is shown in the token box and again in the `export TOKEN="..."` line of every curl sample, so any screenshot of the explorer leaks it.
- Severity: minor
- Workaround: Scrolled the token out of view before taking screenshots; the token expires after 30 minutes.
- Suggestion: Mask the token in the curl samples (`export TOKEN="<copy from above>"`) and add a "copy with token" button.

### Installing the Vega SDK is heavy, and the first setup needs manual fixes
- Date: 19–20 Oct 2026
- Task: Run the Fire TV check-in card on the Vega Virtual Device on an Apple-silicon Mac, against Jirani running on the Mac.
- Steps:
  1. Followed the Vega SDK install docs and compared them with the SDK version `react-native-multi-tv-app-sample` targets.
  2. Installed the prerequisites (Rosetta and eight Homebrew packages) and the Vega CLI 1.4.5, pointed SDK storage at an external drive and turned telemetry off.
  3. Ran `vega sdk install --non-interactive`. The first download timed out on the network; a later retry was stopped, and its 688 MB partial file had to be deleted, because a download can't be resumed. The next attempt took about 13 minutes and installed SDK 0.24.12112 (5.4 GB).
  4. Found that `~/vega/env`, written when the CLI was installed, had no `KEPLER_SDK_PATH`, and added it by hand.
  5. Started the Virtual Device (`vega virtual-device start`, about 25 seconds), built the app (`build:vega:debug`), ran it (`vega run-app`), and let the device reach the Mac with `vega device start-port-forwarding --port 3333 --forward false`.
- Expected vs actual: Expected a single installer and docs that match the sample. Actual: about 20 GB of free disk, a developer-portal sign-in, Rosetta plus eight Homebrew packages, telemetry on by default, install docs marked open beta that cover 0.21 while the sample targets 0.24, sample docs that still use the old `kepler` commands, a download with no resume, and an env file missing the SDK path. Once set up, building and running worked first time: the card appeared and "I'm OK" from the remote resolved the alert. The Virtual Device is a plain QEMU window, and I couldn't find a documented way to take a screenshot or send remote keys from a script, so every check was by hand.
- Severity: major
- Workaround: Installed on an external drive, retried the download, added `KEPLER_SDK_PATH` to `~/vega/env` by hand, and checked the card by eye on the device.
- Suggestion: Make SDK downloads resumable, write `KEPLER_SDK_PATH` when `vega sdk install` finishes, keep the install docs and the samples on the same version and the `vega` command names, ask before enabling telemetry, and add CLI commands to screenshot the Virtual Device and send remote keys.

### react-native-multi-tv-app-sample doesn't typecheck on a clean clone
- Date: 19 Oct 2026
- Task: Add Jirani's check-in card to Amazon's multi-TV sample and typecheck the change.
- Steps:
  1. Cloned `main` and ran `corepack yarn install`.
  2. Ran `tsc` in the Expo and Vega apps; ran `expo start`.
- Expected vs actual: Expected a clean typecheck before any change. Actual: 76 errors in the Expo app and 16 in the Vega app, mostly "Cannot find module 'react-native'" from `shared-ui` (caused by `nmHoistingLimits: workspaces`); `expo start` warned that about 19 packages don't match Expo 54.
- Severity: minor
- Workaround: Verified changes by bundling (`expo export`, the Vega bundle) and running the app instead of `tsc`.
- Suggestion: Add a CI job that runs `tsc` on the sample's `main` and fix the module resolution for `shared-ui`.

### Ring's WHEP docs and sample don't match what the live-view API does
- Date: 21 Oct 2026
- Task: Open the Ring live view from Jirani's dashboard with a Playground token, and close each session properly.
- Steps:
  1. Read "WHEP Live Video Streaming" in the Ring Partner API docs and the live-view hook in Amazon's `ring-api-helloworld` sample (`app/hooks/useWebRTCStream.ts`).
  2. Sent a video-only, `recvonly` offer to `POST /v1/devices/{id}/media/streaming/whep/sessions`: 201 with an SDP answer, and the simulated stream played.
  3. Closed the session with `DELETE` on the URL from the `Location` header, after checking that it was a Ring WHEP session URL.
- Expected vs actual: Expected the `Location` URL the docs show (`.../whep/sessions/{session_id}`). Actual: it ends in `?location=ava1.ring.whep.location...`, so the strict URL check refused it and the first session ran until Ring's time limit. Separately, the sample adds its audio track as `sendrecv`, while the docs say every track must be `recvonly` (I didn't test whether Ring rejects that).
- Severity: minor
- Workaround: Allowed exactly one `location` query parameter on Ring's session URLs; the dashboard asks for video only, `recvonly`.
- Suggestion: Show the full `Location` value, including `?location=`, in the WHEP docs, and make the sample's audio track `recvonly`.
