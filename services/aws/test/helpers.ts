import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { LambdaFunctionURLEvent, LambdaFunctionURLResult } from 'aws-lambda';

export const endpoint = process.env.DYNAMODB_ENDPOINT;

/** A throwaway table with the same keys and TTL attribute as the CDK stack. */
export async function createTable(name: string) {
  const client = new DynamoDBClient({ endpoint, region: 'us-east-1', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } });
  await client.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'PK', AttributeType: 'S' },
        { AttributeName: 'SK', AttributeType: 'S' },
      ],
      KeySchema: [
        { AttributeName: 'PK', KeyType: 'HASH' },
        { AttributeName: 'SK', KeyType: 'RANGE' },
      ],
    }),
  );
  return () => client.send(new DeleteTableCommand({ TableName: name }));
}

/** DynamoDB Local accepts any credentials; the SDK just needs some. */
export function useLocalAws() {
  process.env.AWS_REGION = 'us-east-1';
  process.env.AWS_ACCESS_KEY_ID = 'local';
  process.env.AWS_SECRET_ACCESS_KEY = 'local';
}

/**
 * Serve a Lambda handler over HTTP the way a Function URL does (payload v2.0),
 * so real clients (the MCP SDK client, ring-routine-sim replay) can call it.
 */
export async function functionUrl(
  handler: (e: LambdaFunctionURLEvent) => Promise<LambdaFunctionURLResult>,
): Promise<{ url: string; server: Server }> {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const u = new URL(req.url ?? '/', 'http://localhost');
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(',') : v;
    const body = Buffer.concat(chunks);
    const event = {
      version: '2.0',
      routeKey: '$default',
      rawPath: u.pathname,
      rawQueryString: u.search.slice(1),
      headers,
      isBase64Encoded: true,
      ...(body.length ? { body: body.toString('base64') } : {}),
      requestContext: { domainName: headers.host ?? 'localhost', http: { method: req.method ?? 'GET', path: u.pathname } },
    } as unknown as LambdaFunctionURLEvent;
    const r = await handler(event);
    const out = typeof r === 'string' ? { statusCode: 200, body: r } : r;
    res.writeHead(out.statusCode ?? 200, (out.headers ?? {}) as Record<string, string>).end(out.body ?? '');
  });
  server.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
