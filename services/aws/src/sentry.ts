import * as Sentry from '@sentry/aws-serverless';

/**
 * Error reporting to Sentry, only when SENTRY_DSN is set (the stack passes it
 * with `-c sentryDsn=...`). Errors only, no tracing, and no personal data:
 * household events never leave AWS through here, only stack traces.
 */
const dsn = process.env.SENTRY_DSN;
if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.SENTRY_ENVIRONMENT ?? 'aws',
    // Off by default in Jirani: no request bodies or headers, no user data, no model prompts or answers.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      genAI: { inputs: false, outputs: false },
    },
    tracesSampleRate: 0,
  });
}

/** Wraps a Lambda handler so thrown errors reach Sentry; returns it unchanged without a DSN. */
export function withSentry<H extends (...args: never[]) => unknown>(handler: H): H {
  return dsn ? ((Sentry.wrapHandler as (h: unknown) => unknown)(handler) as H) : handler;
}

/** Reports an error the handler caught and handled itself (e.g. a retried email). */
export function reportError(err: unknown): void {
  if (dsn) Sentry.captureException(err);
}
