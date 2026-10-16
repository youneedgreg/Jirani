import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import { LambdaInvoke } from 'aws-cdk-lib/aws-scheduler-targets';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

export interface JiraniStackProps extends StackProps {
  /** Browser origins allowed to call the API (dashboard, voice client). */
  corsOrigins?: string[];
  /** Enables POST /demo/clock (time travel for the demo video). */
  demo?: boolean;
  /** How often the rhythm engine runs. 0 disables the schedule. */
  evaluateEveryMinutes?: number;
  /** If set, an AWS Budgets alert emails this address at 80% and 100% of $10/month. */
  budgetEmail?: string;
  /** Bedrock model or inference profile ID for the agent. Defaults to the agent's built-in choice. */
  bedrockModelId?: string;
}

/**
 * Everything Jirani needs in AWS. Nothing runs idle except the evaluation
 * schedule, and `cdk destroy` removes all of it, data included.
 */
export class JiraniStack extends Stack {
  constructor(scope: Construct, id: string, props: JiraniStackProps = {}) {
    super(scope, id, props);
    const evaluateEvery = props.evaluateEveryMinutes ?? 1;

    // Single table, one partition per household. Keys: see services/aws/src/dynamo-store.ts.
    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: 'ttl',
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Both generated at deploy time and never in the repo. For a real Ring app,
    // overwrite the HMAC key with the one Ring issues (see docs/aws.md).
    const ringHmacKey = new secretsmanager.Secret(this, 'RingHmacKey', {
      description: 'Jirani: HMAC-SHA256 key that signs Ring webhooks',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });
    const apiToken = new secretsmanager.Secret(this, 'ApiToken', {
      description: 'Jirani: bearer token for the MCP server and dashboard API',
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const fn = (
      name: string,
      file: string,
      opts: { memorySize: number; timeout: Duration; environment?: Record<string, string>; bundleAwsSdk?: boolean },
    ) =>
      new NodejsFunction(this, name, {
        entry: join(repoRoot, 'services/aws/src/lambda', file),
        projectRoot: repoRoot,
        depsLockFilePath: join(repoRoot, 'pnpm-lock.yaml'),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: opts.memorySize,
        timeout: opts.timeout,
        environment: { TABLE_NAME: table.tableName, NODE_OPTIONS: '--enable-source-maps', ...opts.environment },
        logGroup: new logs.LogGroup(this, `${name}Logs`, {
          retention: logs.RetentionDays.ONE_WEEK,
          removalPolicy: RemovalPolicy.DESTROY,
        }),
        bundling: {
          format: OutputFormat.ESM,
          target: 'node22',
          minify: true,
          sourceMap: true,
          mainFields: ['module', 'main'],
          // Some CommonJS dependencies call require(); give the ESM bundle one.
          banner: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
          // By default the Lambda runtime's own AWS SDK is used; bundle it when a dependency needs a newer one.
          ...(opts.bundleAwsSdk ? { externalModules: [] } : {}),
        },
      });

    // Ring webhook: public URL, authenticated by Ring's HMAC signature.
    const webhook = fn('WebhookFn', 'webhook.ts', {
      memorySize: 256,
      timeout: Duration.seconds(10),
      environment: { RING_HMAC_SECRET_ARN: ringHmacKey.secretArn },
    });
    table.grantReadWriteData(webhook);
    ringHmacKey.grantRead(webhook);
    const webhookUrl = webhook.addFunctionUrl({ authType: lambda.FunctionUrlAuthType.NONE });

    // MCP server + dashboard API: public URL, bearer token checked in code.
    const api = fn('ApiFn', 'api.ts', {
      memorySize: 512,
      timeout: Duration.seconds(30),
      environment: { API_TOKEN_SECRET_ARN: apiToken.secretArn, JIRANI_DEMO: props.demo ? '1' : '0' },
    });
    table.grantReadWriteData(api);
    apiToken.grantRead(api);
    const apiUrl = api.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: props.corsOrigins ?? ['http://localhost:3000'],
        allowedMethods: [lambda.HttpMethod.GET, lambda.HttpMethod.POST],
        allowedHeaders: ['authorization', 'content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id'],
        exposedHeaders: ['mcp-protocol-version', 'mcp-session-id'],
        maxAge: Duration.hours(1),
      },
    });

    // Rhythm engine heartbeat: detect deviations and move the ladder.
    const evaluate = fn('EvaluateFn', 'evaluate.ts', { memorySize: 512, timeout: Duration.seconds(60) });
    table.grantReadWriteData(evaluate);
    if (evaluateEvery > 0) {
      new scheduler.Schedule(this, 'EvaluateSchedule', {
        description: 'Jirani: run the rhythm engine and escalation ladder',
        schedule: scheduler.ScheduleExpression.rate(Duration.minutes(evaluateEvery)),
        target: new LambdaInvoke(evaluate, { retryAttempts: 0 }),
      });
    }

    // The agent: a Strands agent on Bedrock that answers through the MCP server above.
    const agent = fn('AgentFn', 'agent.ts', {
      memorySize: 512,
      timeout: Duration.seconds(60),
      bundleAwsSdk: true,
      environment: {
        API_TOKEN_SECRET_ARN: apiToken.secretArn,
        JIRANI_API_URL: apiUrl.url,
        ...(props.bedrockModelId ? { BEDROCK_MODEL_ID: props.bedrockModelId } : {}),
      },
    });
    apiToken.grantRead(agent);
    agent.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream'],
        // Foundation models and cross-region inference profiles, so either kind of model ID works.
        resources: [`arn:aws:bedrock:*::foundation-model/*`, `arn:aws:bedrock:*:${this.account}:inference-profile/*`],
      }),
    );
    const agentUrl = agent.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      cors: {
        allowedOrigins: props.corsOrigins ?? ['http://localhost:3000'],
        allowedMethods: [lambda.HttpMethod.POST],
        allowedHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });

    if (props.budgetEmail) {
      new budgets.CfnBudget(this, 'Budget', {
        budget: { budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: 10, unit: 'USD' } },
        notificationsWithSubscribers: [80, 100].map((threshold) => ({
          notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
          subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetEmail! }],
        })),
      });
    }

    new CfnOutput(this, 'WebhookUrl', { value: `${webhookUrl.url}ring/webhook`, description: 'Point Ring (or ring-routine-sim replay) here' });
    new CfnOutput(this, 'McpUrl', { value: `${apiUrl.url}mcp`, description: 'MCP server, Streamable HTTP' });
    new CfnOutput(this, 'ApiUrl', { value: apiUrl.url });
    new CfnOutput(this, 'AskUrl', { value: `${agentUrl.url}ask`, description: 'POST {"question", "as"} to the Bedrock agent' });
    new CfnOutput(this, 'TableName', { value: table.tableName });
    new CfnOutput(this, 'RingHmacKeySecret', { value: ringHmacKey.secretName });
    new CfnOutput(this, 'ApiTokenSecret', { value: apiToken.secretName });
    new CfnOutput(this, 'EvaluateFunctionName', { value: evaluate.functionName });
  }
}
