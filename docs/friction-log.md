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

### Installing the Vega SDK is heavy and the docs lag the sample
- Date: 19 Oct 2026
- Task: Prepare to run the Fire TV check-in card on the Vega Virtual Device on an Apple-silicon Mac.
- Steps:
  1. Followed the Vega SDK install docs.
  2. Compared them with the SDK version `react-native-multi-tv-app-sample` targets.
- Expected vs actual: Expected a single installer. Actual: about 20 GB of free disk, a developer-portal sign-in to download, Rosetta plus eight Homebrew packages, telemetry on by default, and install docs marked open beta that cover 0.21 while the sample targets 0.24.
- Severity: major
- Workaround: Planned the install on an external drive; kept the Android TV emulator as a fallback.
- Suggestion: Ship one signed installer that checks prerequisites, asks before enabling telemetry, and keep the install docs in step with the version the samples use.

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
