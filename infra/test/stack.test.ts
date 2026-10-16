import { describe, expect, it } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { JiraniStack, type JiraniStackProps } from '../lib/jirani-stack.ts';

// Skip esbuild bundling here; `pnpm --filter @jirani/infra synth` checks the real bundles.
const synth = (props: JiraniStackProps = {}) =>
  Template.fromStack(new JiraniStack(new App({ context: { 'aws:cdk:bundling-stacks': [] } }), 'Test', props));

describe('JiraniStack', () => {
  const t = synth();

  it('has one on-demand table with PK/SK and TTL, removed on destroy', () => {
    t.resourceCountIs('AWS::DynamoDB::GlobalTable', 1);
    t.hasResource('AWS::DynamoDB::GlobalTable', {
      DeletionPolicy: 'Delete',
      Properties: Match.objectLike({
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
        TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      }),
    });
  });

  it('runs four Node 22 arm64 functions, three of them behind Function URLs', () => {
    t.resourceCountIs('AWS::Lambda::Function', 4);
    t.allResourcesProperties('AWS::Lambda::Function', { Runtime: 'nodejs22.x', Architectures: ['arm64'] });
    t.resourceCountIs('AWS::Lambda::Url', 3);
  });

  it('lets only the agent call Bedrock', () => {
    const bedrock = Object.values(t.findResources('AWS::IAM::Policy')).filter((p) =>
      JSON.stringify(p).includes('bedrock:InvokeModel'),
    );
    expect(bedrock).toHaveLength(1);
    expect(JSON.stringify(bedrock[0])).toContain('AgentFn');
    synth({ bedrockModelId: 'us.example-model' }).hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ BEDROCK_MODEL_ID: 'us.example-model' }) },
    });
  });

  it('keeps secrets in Secrets Manager, passing only ARNs to the functions', () => {
    t.resourceCountIs('AWS::SecretsManager::Secret', 2);
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ RING_HMAC_SECRET_ARN: Match.anyValue() }) },
    });
    t.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ API_TOKEN_SECRET_ARN: Match.anyValue(), JIRANI_DEMO: '0' }) },
    });
  });

  it('runs the rhythm engine every minute by default, and can pause it', () => {
    t.hasResourceProperties('AWS::Scheduler::Schedule', { ScheduleExpression: 'rate(1 minute)' });
    synth({ evaluateEveryMinutes: 0 }).resourceCountIs('AWS::Scheduler::Schedule', 0);
  });

  it('adds a $10 budget alert only when an email is given', () => {
    t.resourceCountIs('AWS::Budgets::Budget', 0);
    synth({ budgetEmail: 'me@example.com' }).hasResourceProperties('AWS::Budgets::Budget', {
      Budget: Match.objectLike({ BudgetLimit: { Amount: 10, Unit: 'USD' } }),
    });
  });

  it('only allows the configured browser origins', () => {
    synth({ corsOrigins: ['https://jirani.app'] }).hasResourceProperties('AWS::Lambda::Url', {
      Cors: Match.objectLike({ AllowOrigins: ['https://jirani.app'] }),
    });
  });
});
