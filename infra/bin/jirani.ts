import { App } from 'aws-cdk-lib';
import { JiraniStack } from '../lib/jirani-stack.ts';

/**
 * cdk deploy                                   eu-north-1 (the project's only Region), schedule every minute
 * cdk deploy -c demo=true                      also enable POST /demo/clock for the video
 * cdk deploy -c corsOrigins=https://jirani.app,http://localhost:3000
 * cdk deploy -c evaluateEveryMinutes=0         remove the schedule (no recurring compute)
 * cdk deploy -c bedrockModelId=<id>            use another Bedrock model or inference profile for the agent
 * cdk deploy -c region=<region>                 deploy elsewhere (only if your AWS account allows that Region)
 * cdk deploy -c senderEmail=jirani@you.com -c contactEmails=joe=a@x.com,amina=b@x.com -c dashboardUrl=https://...
 *                                              email escalation messages (SES) and the weekly report
 * cdk deploy -c sentryDsn=https://...          report Lambda errors to Sentry
 */
const app = new App();
const ctx = (k: string): string | undefined => app.node.tryGetContext(k);

// The AWS project this runs in may only create resources in eu-north-1, so that's the default
// regardless of the CLI profile's Region; -c region=... overrides it deliberately.
const region = ctx('region') ?? 'eu-north-1';

new JiraniStack(app, 'Jirani', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region },
  demo: ctx('demo') === 'true',
  ...(ctx('corsOrigins') ? { corsOrigins: ctx('corsOrigins')!.split(',').map((s) => s.trim()) } : {}),
  ...(ctx('evaluateEveryMinutes') !== undefined ? { evaluateEveryMinutes: Number(ctx('evaluateEveryMinutes')) } : {}),
  ...(ctx('bedrockModelId') ? { bedrockModelId: ctx('bedrockModelId')! } : {}),
  ...(ctx('senderEmail') ? { senderEmail: ctx('senderEmail')! } : {}),
  ...(ctx('contactEmails') ? { contactEmails: ctx('contactEmails')! } : {}),
  ...(ctx('dashboardUrl') ? { dashboardUrl: ctx('dashboardUrl')! } : {}),
  ...(ctx('sentryDsn') ? { sentryDsn: ctx('sentryDsn')! } : {}),
  description: 'Jirani: privacy-first caregiving agent (Ring + Alexa+ hackathon entry)',
});
