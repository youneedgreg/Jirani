import { App } from 'aws-cdk-lib';
import { JiraniStack } from '../lib/jirani-stack.ts';

/**
 * cdk deploy                                   default: us-east-1 (where Bedrock is), schedule every minute
 * cdk deploy -c demo=true                      also enable POST /demo/clock for the video
 * cdk deploy -c corsOrigins=https://jirani.app,http://localhost:3000
 * cdk deploy -c evaluateEveryMinutes=0         remove the schedule (no recurring compute)
 * cdk deploy -c budgetEmail=you@example.com    $10/month AWS Budgets alert
 * cdk deploy -c bedrockModelId=<id>            use another Bedrock model or inference profile for the agent
 * cdk deploy -c senderEmail=jirani@you.com -c contactEmails=joe=a@x.com,amina=b@x.com -c dashboardUrl=https://...
 *                                              email escalation messages (SES) and the weekly report
 */
const app = new App();
const ctx = (k: string): string | undefined => app.node.tryGetContext(k);

new JiraniStack(app, 'Jirani', {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION ?? 'us-east-1' },
  demo: ctx('demo') === 'true',
  ...(ctx('corsOrigins') ? { corsOrigins: ctx('corsOrigins')!.split(',').map((s) => s.trim()) } : {}),
  ...(ctx('evaluateEveryMinutes') !== undefined ? { evaluateEveryMinutes: Number(ctx('evaluateEveryMinutes')) } : {}),
  ...(ctx('budgetEmail') ? { budgetEmail: ctx('budgetEmail')! } : {}),
  ...(ctx('bedrockModelId') ? { bedrockModelId: ctx('bedrockModelId')! } : {}),
  ...(ctx('senderEmail') ? { senderEmail: ctx('senderEmail')! } : {}),
  ...(ctx('contactEmails') ? { contactEmails: ctx('contactEmails')! } : {}),
  ...(ctx('dashboardUrl') ? { dashboardUrl: ctx('dashboardUrl')! } : {}),
  description: 'Jirani: privacy-first caregiving agent (Ring + Alexa+ hackathon entry)',
});
