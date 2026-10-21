import { describe, expect, it } from 'vitest';
import { reportError, withSentry } from '../src/sentry.ts';

describe('Sentry wrapper', () => {
  it('leaves handlers untouched and reports nothing without SENTRY_DSN', async () => {
    expect(process.env.SENTRY_DSN).toBeUndefined();
    const handler = async (n: number) => n + 1;
    expect(withSentry(handler)).toBe(handler);
    expect(await withSentry(handler)(1)).toBe(2);
    expect(() => reportError(new Error('ignored'))).not.toThrow();
  });
});
