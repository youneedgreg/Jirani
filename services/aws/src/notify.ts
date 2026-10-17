import { GetCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { reportSummary, type Household, type WeeklyReport } from '@jirani/core';
import type { OutboxMessage } from '@jirani/mcp';

/**
 * Email delivery for the messages the ladder decides to send. The ladder only
 * writes them to the outbox (OUT# items); a DynamoDB Stream hands each new one
 * to the notifier, so a slow or failing mail service never blocks or repeats
 * an escalation step.
 */

export interface Email {
  to: string[];
  subject: string;
  text: string;
}

/** Sends one email and returns the provider's message id. */
export type SendEmail = (email: Email) => Promise<string>;

export function sesSender(from: string, client = new SESv2Client({})): SendEmail {
  return async (e) => {
    const r = await client.send(
      new SendEmailCommand({
        FromEmailAddress: from,
        Destination: { ToAddresses: e.to },
        Content: { Simple: { Subject: { Data: e.subject, Charset: 'UTF-8' }, Body: { Text: { Data: e.text, Charset: 'UTF-8' } } } },
      }),
    );
    return r.MessageId ?? '';
  };
}

/**
 * Who gets an email for a message. The resident is reached by voice and on her
 * TV, not by email; "family" means every family contact.
 */
export function recipientsFor(to: string, h: Household): string[] {
  if (to === 'resident') return [];
  const contacts = to === 'family' ? h.contacts.filter((c) => c.relation === 'family') : h.contacts.filter((c) => c.id === to);
  return contacts.map((c) => c.email).filter((e): e is string => !!e);
}

const SUBJECTS: Record<OutboxMessage['type'], (name: string) => string> = {
  checkin_resident: (n) => `Jirani: checking in with ${n}`,
  notify_contact: (n) => `Jirani: please check on ${n}`,
  offer_live_view: (n) => `Jirani: front-door camera available for ${n}`,
  suggest_emergency: (n) => `Jirani: ${n} may need help`,
  all_clear: (n) => `Jirani: ${n} is OK`,
  log: (n) => `Jirani: note about ${n}`,
};

export function emailFor(m: OutboxMessage, h: Household, dashboardUrl?: string): Email {
  const footer = [
    dashboardUrl ? `See the timeline: ${dashboardUrl}` : '',
    "Jirani describes changes in routine. It is not a medical device and never contacts emergency services itself.",
  ].filter(Boolean);
  return {
    to: recipientsFor(m.to, h),
    subject: SUBJECTS[m.type](h.residentName),
    text: [m.message, '', ...footer].join('\n'),
  };
}

export function weeklyEmail(report: WeeklyReport, h: Household, dashboardUrl?: string): Email {
  const lines = report.metrics.map((m) => `- ${m.label}: ${m.sentence}`);
  return {
    to: recipientsFor('family', h),
    subject: `Jirani: ${h.residentName}'s week (to ${report.weekEnding})`,
    text: [
      reportSummary(report),
      '',
      `Last ${report.recentDays} days compared with the ${report.priorDays} before:`,
      ...lines,
      '',
      ...(dashboardUrl ? [`Details: ${dashboardUrl}`] : []),
      'Jirani never diagnoses anything. If something here surprises you, a gentle conversation with her, or her doctor, is a good next step.',
    ].join('\n'),
  };
}

export type DeliveryResult = { status: 'sent'; messageId: string } | { status: 'skipped'; reason: string };

/**
 * Email one outbox item at most once in normal operation: skip it if it is
 * already marked as emailed, send, then mark it. If the mark fails after a
 * successful send, a stream retry can send it again (at-least-once).
 */
export async function deliverOutboxItem(
  deps: { db: DynamoDBDocumentClient; table: string; send: SendEmail; household: Household; dashboardUrl?: string },
  key: { PK: string; SK: string },
  nowIso = new Date().toISOString(),
): Promise<DeliveryResult> {
  const { Item } = await deps.db.send(new GetCommand({ TableName: deps.table, Key: key, ConsistentRead: true }));
  if (!Item) return { status: 'skipped', reason: 'item no longer exists' };
  if (Item.emailedAt) return { status: 'skipped', reason: 'already emailed' };

  const email = emailFor(Item.data as OutboxMessage, deps.household, deps.dashboardUrl);
  if (email.to.length === 0) return { status: 'skipped', reason: `no email address for "${(Item.data as OutboxMessage).to}"` };

  const messageId = await deps.send(email);
  await deps.db.send(
    new UpdateCommand({
      TableName: deps.table,
      Key: key,
      UpdateExpression: 'SET emailedAt = :at, emailedTo = :to, emailId = :id',
      ExpressionAttributeValues: { ':at': nowIso, ':to': email.to, ':id': messageId },
    }),
  );
  return { status: 'sent', messageId };
}
