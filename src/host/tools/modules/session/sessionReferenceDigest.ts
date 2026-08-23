import { createHash } from 'node:crypto';

import type { Message } from '../../../../shared/contract/message';
import type { Session } from '../../../../shared/contract/session';
import { compactModelSummarize } from '../../../context/compactModel';
import { getDatabase } from '../../../services/core';

const FULL_TEXT_MESSAGE_LIMIT = 15;
const DIGEST_MAX_TOKENS = 800;

interface CachedDigestRow {
  message_count: number;
  content_hash: string;
  digest: string;
  topics: string;
}

interface SessionReferenceResult {
  output: string;
  totalMessages: number;
  mode: 'full' | 'digest';
  cacheHit: boolean;
  digestThreshold: number;
}

const pendingDigests = new Map<string, Promise<{ digest: string; topics: string }>>();

function formatMessage(message: Message, position: number): string {
  const timestamp = Number.isFinite(message.timestamp)
    ? new Date(message.timestamp).toISOString()
    : 'unknown time';
  return `[${position}] ${message.role} (${message.id}, ${timestamp})\n${message.content}`;
}

function fingerprintMessages(messages: readonly Message[]): string {
  const hash = createHash('sha256');
  for (const message of messages) {
    hash.update(message.id);
    hash.update('\0');
    hash.update(message.role);
    hash.update('\0');
    hash.update(String(message.timestamp));
    hash.update('\0');
    hash.update(message.content);
    hash.update('\0');
  }
  return hash.digest('hex');
}

function buildDigestPrompt(session: Session, messages: readonly Message[]): string {
  return [
    'Summarize this historical Agent Neo session for another agent that has just referenced it.',
    'Identify the concrete topics, decisions, results, unresolved work, and important file or command references.',
    'Do not invent details. Keep the summary compact and preserve facts needed to decide what to read next.',
    'Return plain text in exactly this shape:',
    'Topics: comma-separated topic names',
    'Summary:',
    'the concise digest',
    '',
    `Session title: ${session.title}`,
    `Session ID: ${session.id}`,
    `Conversation (${messages.length} messages):`,
    ...messages.map((message, index) => formatMessage(message, index + 1)),
  ].join('\n');
}

function parseGeneratedDigest(generated: string): { digest: string; topics: string } {
  const trimmed = generated.trim();
  const lines = trimmed.split('\n');
  const topicsIndex = lines.findIndex((line) => /^Topics:\s*/i.test(line));
  const topics = topicsIndex >= 0
    ? lines[topicsIndex].replace(/^Topics:\s*/i, '').trim()
    : lines.find((line) => line.trim().length > 0)?.trim() ?? 'See digest';
  const digest = lines
    .filter((_, index) => index !== topicsIndex)
    .join('\n')
    .replace(/^Summary:\s*/i, '')
    .trim();
  return { digest: digest || trimmed, topics: topics || 'See digest' };
}

function formatDigestReference(
  session: Session,
  totalMessages: number,
  digest: string,
  topics: string,
): string {
  return [
    `Session ${session.id}: ${session.title}`,
    'Digest:',
    digest,
    '',
    `This session has ${totalMessages} messages. Topics: ${topics}. Use SessionManager with action="read" and sessionId="${session.id}" to load specific details.`,
  ].join('\n');
}

export async function resolveSessionReference(
  session: Session,
  messages: readonly Message[],
): Promise<SessionReferenceResult> {
  const totalMessages = messages.length;
  if (totalMessages <= FULL_TEXT_MESSAGE_LIMIT) {
    return {
      output: [
        `Session ${session.id}: ${session.title}`,
        `Full conversation (${totalMessages} messages; no digest generated):`,
        ...messages.map((message, index) => formatMessage(message, index + 1)),
      ].join('\n'),
      totalMessages,
      mode: 'full',
      cacheHit: false,
      digestThreshold: FULL_TEXT_MESSAGE_LIMIT,
    };
  }

  const rawDb = getDatabase().getDb();
  if (!rawDb) {
    throw new Error('Session digest cache is unavailable');
  }

  const contentHash = fingerprintMessages(messages);
  const cached = rawDb.prepare(`
    SELECT message_count, content_hash, digest, topics
    FROM session_reference_digests
    WHERE session_id = ?
  `).get(session.id) as CachedDigestRow | undefined;

  if (
    cached?.message_count === totalMessages
    && cached.content_hash === contentHash
  ) {
    return {
      output: formatDigestReference(session, totalMessages, cached.digest, cached.topics),
      totalMessages,
      mode: 'digest',
      cacheHit: true,
      digestThreshold: FULL_TEXT_MESSAGE_LIMIT,
    };
  }

  const pendingKey = `${session.id}:${contentHash}`;
  let generation = pendingDigests.get(pendingKey);
  if (!generation) {
    generation = compactModelSummarize(
      buildDigestPrompt(session, messages),
      DIGEST_MAX_TOKENS,
    ).then(parseGeneratedDigest);
    pendingDigests.set(pendingKey, generation);
  }

  try {
    const generated = await generation;
    rawDb.prepare(`
      INSERT INTO session_reference_digests (
        session_id, message_count, content_hash, digest, topics, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        message_count = excluded.message_count,
        content_hash = excluded.content_hash,
        digest = excluded.digest,
        topics = excluded.topics,
        generated_at = excluded.generated_at
    `).run(
      session.id,
      totalMessages,
      contentHash,
      generated.digest,
      generated.topics,
      Date.now(),
    );
    return {
      output: formatDigestReference(session, totalMessages, generated.digest, generated.topics),
      totalMessages,
      mode: 'digest',
      cacheHit: false,
      digestThreshold: FULL_TEXT_MESSAGE_LIMIT,
    };
  } finally {
    if (pendingDigests.get(pendingKey) === generation) {
      pendingDigests.delete(pendingKey);
    }
  }
}
