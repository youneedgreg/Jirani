import { timingSafeEqual } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import type { Household } from '@jirani/core';
import { demoHousehold } from '@jirani/mcp';

/**
 * Lambda configuration, read once per container. Secrets come from AWS Secrets
 * Manager (ARNs in the environment), never from the repo or plain env vars.
 * Tests and local runs can pass values directly with RING_HMAC_KEY / JIRANI_API_TOKEN.
 */

export function documentClient(endpoint = process.env.DYNAMODB_ENDPOINT): DynamoDBDocumentClient {
  return DynamoDBDocumentClient.from(new DynamoDBClient(endpoint ? { endpoint } : {}), {
    marshallOptions: { removeUndefinedValues: true },
  });
}

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing environment variable ${name}`);
  return v;
}

const cache = new Map<string, Promise<string>>();

/** A secret's value: from `directEnv` if set (tests, local), else from Secrets Manager by the ARN in `arnEnv`. */
export function secret(directEnv: string, arnEnv: string): Promise<string> {
  const direct = process.env[directEnv];
  if (direct) return Promise.resolve(direct);
  const arn = requireEnv(arnEnv);
  let p = cache.get(arn);
  if (!p) {
    p = new SecretsManagerClient({})
      .send(new GetSecretValueCommand({ SecretId: arn }))
      .then((r) => {
        if (!r.SecretString) throw new Error(`Secret ${arnEnv} is empty`);
        return r.SecretString;
      });
    p.catch(() => cache.delete(arn));
    cache.set(arn, p);
  }
  return p;
}

export const ringHmacKey = () => secret('RING_HMAC_KEY', 'RING_HMAC_SECRET_ARN');
export const apiToken = () => secret('JIRANI_API_TOKEN', 'API_TOKEN_SECRET_ARN');

/** The household this deployment looks after. One demo household for now. */
export function household(): Household {
  return demoHousehold();
}

/** Constant-time check of an `Authorization: Bearer <token>` header. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const m = header?.match(/^Bearer\s+(.+)$/i);
  if (!m) return false;
  const got = Buffer.from(m[1]!.trim());
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}
