import { createHash } from 'crypto';
import type { Message } from '../../../shared/contract';
import type {
  MemoryEntry,
  MemoryEntryKind,
  MemoryEntryListResult,
  MemoryEntryUpdateResult,
} from '../../../shared/contract/memory';
import type { MemoryRecord, StoredSession } from '../core/repositories';
import {
  createMemoryMirrorRecord,
  listUnifiedMemoryEntries,
  updateMemoryEntry,
  writeActiveEntryToLightMemory,
} from '../../memory/memoryEntryRuntime';
import {
  TranscriptHistoryService,
  type TranscriptAroundResult,
  type TranscriptHistoryDatabase,
  type TranscriptSearchHit,
} from '../history/transcriptHistoryService';

export const DREAM_MEMORY_SOURCE = 'dream';

const DEFAULT_WINDOW_DAYS = 7;
const DEFAULT_SESSION_LIMIT = 50;
const DEFAULT_RECENT_MESSAGES = 30;
const DEFAULT_PRUNE_OLDER_THAN_DAYS = 90;

type SessionLike = Pick<StoredSession, 'id' | 'title' | 'workingDirectory' | 'createdAt' | 'updatedAt'>;

export interface DreamCandidate {
  id?: string;
  title: string;
  summary?: string;
  content: string;
  kind?: MemoryEntryKind;
  projectPath?: string | null;
  sessionId?: string | null;
  queries?: string[];
  confidence?: number;
}

export interface DreamCandidateExtractorInput {
  sessions: SessionLike[];
  messagesBySession: Map<string, Message[]>;
  existingMemory: MemoryEntry[];
  projectPath?: string | null;
  now: number;
}

export type DreamCandidateExtractor = (input: DreamCandidateExtractorInput) => Promise<DreamCandidate[]> | DreamCandidate[];

export interface DreamEvidence {
  candidateId: string;
  sessionId: string;
  messageId: string;
  snippet: string;
  timestamp: number;
}

export interface DreamSkippedCandidate {
  candidateId: string;
  reason: 'empty-candidate' | 'duplicate-memory' | 'no-fts-evidence';
}

export interface DreamRunReport {
  phase: 'completed';
  sessionsReviewed: number;
  existingMemoryCount: number;
  candidates: DreamCandidate[];
  verified: Array<{ candidate: DreamCandidate; evidence: DreamEvidence }>;
  written: Array<{ entryId: string; title: string; evidence: DreamEvidence }>;
  pruned: string[];
  skipped: DreamSkippedCandidate[];
}

export interface DreamMemoryDatabase extends TranscriptHistoryDatabase {
  listSessions(limit?: number, offset?: number, includeArchived?: boolean): SessionLike[];
  getRecentMessages(sessionId: string, count: number): Message[];
  listMemories(options?: {
    type?: string;
    category?: string;
    source?: string;
    projectPath?: string;
    sessionId?: string;
    limit?: number;
    offset?: number;
    orderBy?: string;
    orderDir?: 'ASC' | 'DESC';
  }): MemoryRecord[];
  createMemory(data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>): MemoryRecord;
  updateMemory(id: string, updates: Partial<MemoryRecord>): MemoryRecord | null;
  searchMemories?(query: string, options?: { limit?: number; applyDecay?: boolean }): MemoryRecord[];
}

export interface DreamMemoryIO {
  listEntries(db: DreamMemoryDatabase): Promise<MemoryEntryListResult>;
  writeEntry(entry: MemoryEntry): Promise<unknown>;
  createMirror(db: DreamMemoryDatabase, entry: MemoryEntry, options?: { metadata?: Record<string, unknown>; category?: string }): MemoryRecord;
  updateEntry(db: DreamMemoryDatabase, request: { entryId: string; status: 'stale' }): Promise<MemoryEntryUpdateResult | unknown>;
}

export interface DreamRunOptions {
  db: DreamMemoryDatabase;
  projectPath?: string | null;
  now?: number;
  windowDays?: number;
  sessionLimit?: number;
  candidateExtractor?: DreamCandidateExtractor;
  memoryIO?: DreamMemoryIO;
  pruneOlderThanDays?: number;
}

const defaultMemoryIO: DreamMemoryIO = {
  listEntries: listUnifiedMemoryEntries,
  writeEntry: writeActiveEntryToLightMemory,
  createMirror: createMemoryMirrorRecord,
  updateEntry: updateMemoryEntry,
};

function compact(value: string | null | undefined, limit: number): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function hashText(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 16);
}

function candidateId(candidate: DreamCandidate): string {
  return candidate.id || `cand_${hashText(`${candidate.title}\n${candidate.content}`)}`;
}

function memoryEntryId(candidate: DreamCandidate): string {
  return `dream_${hashText(`${candidate.title}\n${candidate.content}`)}`;
}

function isRecentSession(session: SessionLike, windowStart: number): boolean {
  const updatedAt = Number(session.updatedAt || session.createdAt || 0);
  return updatedAt >= windowStart;
}

function pickSessions(sessions: SessionLike[], projectPath: string | null | undefined, windowStart: number): SessionLike[] {
  const scoped = projectPath
    ? sessions.filter((session) => !session.workingDirectory || session.workingDirectory === projectPath)
    : sessions;
  // 窗口内无会话 → 返回空（上游 dream.txt 的语义是"报告 nothing 并停止"），
  // 不降级全历史——否则数年前的会话会被当作"最近 7 天"处理（audit A-M2）
  return scoped.filter((session) => isRecentSession(session, windowStart));
}

function extractMessageText(message: Message): string {
  const parts = [
    typeof message.content === 'string' ? message.content : '',
    typeof message.thinking === 'string' ? message.thinking : '',
    ...(message.toolCalls || []).flatMap((call) => [
      call.name,
      typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments ?? ''),
      typeof call.result?.output === 'string' ? call.result.output : '',
    ]),
  ];
  return parts.join('\n').trim();
}

function hasDurableSignal(text: string): boolean {
  return /remember|always|never|decision|decided|tradeoff|workflow|gotcha|again|以后|记住|决定|原则|必须|不要|总是|每次|偏好|踩坑|修复|原因/i.test(text);
}

function queryTokens(value: string): string[] {
  const ascii = value.toLowerCase().match(/[a-z0-9_]{4,}/g) ?? [];
  const cjk = value.match(/[\u4e00-\u9fff]{2,}/g) ?? [];
  return Array.from(new Set([...ascii, ...cjk]))
    .filter((token) => token.length >= 2)
    .slice(0, 8);
}

function buildCandidateQueries(candidate: DreamCandidate): string[] {
  const explicit = (candidate.queries || []).map((query) => query.trim()).filter((query) => query.length >= 3);
  const generated = [
    queryTokens(candidate.title).slice(0, 4).join(' '),
    queryTokens(candidate.summary || candidate.content).slice(0, 5).join(' '),
  ].filter((query) => query.length >= 3);
  return Array.from(new Set([...explicit, ...generated])).slice(0, 5);
}

function contextText(around: TranscriptAroundResult | null): string {
  if (!around) return '';
  return around.messages
    .map((item) => extractMessageText(item.message))
    .join('\n');
}

// 防幻觉门参数（audit fix A-H1）：逐字短路需要足够长的证据；token 路径阈值
// 随候选 token 数缩放且下限 2——原实现阈值封顶 2，长候选命中 2 个泛词即放行。
const VERBATIM_MATCH_MIN_CHARS = 12;
const TOKEN_MATCH_MIN = 2;
const TOKEN_MATCH_RATIO = 0.5;

export function supportsCandidate(candidate: DreamCandidate, hit: TranscriptSearchHit, around: TranscriptAroundResult | null): boolean {
  const haystack = normalizeText([hit.snippet, contextText(around)].join('\n'));
  if (!haystack) return false;
  const summary = normalizeText(candidate.summary || '');
  if (summary.length >= VERBATIM_MATCH_MIN_CHARS && haystack.includes(summary)) return true;
  const title = normalizeText(candidate.title);
  if (title.length >= VERBATIM_MATCH_MIN_CHARS && haystack.includes(title)) return true;
  const tokens = queryTokens([candidate.title, candidate.summary, candidate.content].join('\n'));
  if (tokens.length === 0) return false;
  const matched = tokens.filter((token) => haystack.includes(normalizeText(token)));
  const threshold = Math.max(TOKEN_MATCH_MIN, Math.ceil(tokens.length * TOKEN_MATCH_RATIO));
  return matched.length >= threshold;
}

async function verifyCandidate(
  candidate: DreamCandidate,
  history: TranscriptHistoryService,
): Promise<DreamEvidence | null> {
  for (const query of buildCandidateQueries(candidate)) {
    const hits = await history.search(query, {
      sessionId: candidate.sessionId || undefined,
      limit: 5,
    });
    for (const hit of hits) {
      const around = await history.around(hit.messageId, { before: 3, after: 3 });
      if (!supportsCandidate(candidate, hit, around)) continue;
      return {
        candidateId: candidateId(candidate),
        sessionId: hit.sessionId,
        messageId: hit.messageId,
        snippet: compact(hit.snippet, 500),
        timestamp: hit.timestamp,
      };
    }
  }
  return null;
}

function isDuplicate(candidate: DreamCandidate, existingMemory: MemoryEntry[]): boolean {
  const candidateContent = normalizeText(candidate.content);
  const candidateTitle = normalizeText(candidate.title);
  return existingMemory.some((entry) => {
    const entryContent = normalizeText(entry.content);
    const entryTitle = normalizeText(entry.title);
    return entryContent === candidateContent
      || (candidateTitle.length > 0 && entryTitle === candidateTitle)
      || (candidateContent.length > 80 && entryContent.includes(candidateContent.slice(0, 80)));
  });
}

function buildDreamEntry(
  candidate: DreamCandidate,
  evidence: DreamEvidence,
  projectPath: string | null | undefined,
  now: number,
): MemoryEntry {
  const id = memoryEntryId(candidate);
  const kind = candidate.kind || 'project';
  let scope: MemoryEntry['scope'];
  if (candidate.sessionId) {
    scope = 'session';
  } else if (projectPath || kind === 'project' || kind === 'pattern') {
    scope = 'project';
  } else {
    scope = 'global';
  }
  return {
    id,
    schemaVersion: 2,
    status: 'active',
    kind,
    scope,
    title: compact(candidate.title, 120) || id,
    summary: compact(candidate.summary || candidate.content, 180),
    content: candidate.content.trim(),
    source: {
      kind: 'recent_conversation',
      sourceOfTruth: 'light_file',
      filePath: `memory-${id}.md`,
      label: 'Dream consolidation',
    },
    evidence: [{
      candidateId: evidence.candidateId,
      sessionId: evidence.sessionId,
      messageId: evidence.messageId,
      source: DREAM_MEMORY_SOURCE,
    }],
    projectPath: candidate.projectPath ?? projectPath ?? null,
    sessionId: candidate.sessionId ?? null,
    confidence: Math.max(0, Math.min(1, candidate.confidence ?? 0.9)),
    createdAt: now,
    updatedAt: now,
  };
}

function isDreamOwned(entry: MemoryEntry): boolean {
  return entry.id.startsWith('dream_') || entry.evidence.some((item) => item.source === DREAM_MEMORY_SOURCE);
}

async function pruneStaleDreamEntries(
  db: DreamMemoryDatabase,
  memoryIO: DreamMemoryIO,
  entries: MemoryEntry[],
  now: number,
  pruneOlderThanDays: number,
): Promise<string[]> {
  const cutoff = now - pruneOlderThanDays * 24 * 60 * 60 * 1000;
  const pruned: string[] = [];
  for (const entry of entries) {
    if (entry.status !== 'active' || !isDreamOwned(entry) || entry.updatedAt >= cutoff) continue;
    await memoryIO.updateEntry(db, { entryId: entry.id, status: 'stale' });
    pruned.push(entry.id);
  }
  return pruned;
}

export async function extractDreamCandidatesFromRecentMessages(input: DreamCandidateExtractorInput): Promise<DreamCandidate[]> {
  const candidates: DreamCandidate[] = [];
  for (const session of input.sessions) {
    const messages = input.messagesBySession.get(session.id) || [];
    for (const msg of messages) {
      const text = compact(extractMessageText(msg), 900);
      if (text.length < 20 || !hasDurableSignal(text)) continue;
      const firstLine = compact(text.split(/\r?\n/)[0], 100);
      candidates.push({
        id: `cand_${hashText(`${session.id}\n${msg.id}\n${text}`)}`,
        title: firstLine.replace(/^(决定|原则|记住|以后)[:：]\s*/, '') || session.title || 'Dream memory',
        summary: firstLine,
        content: text,
        kind: msg.role === 'user' ? 'feedback' : 'project',
        projectPath: input.projectPath ?? session.workingDirectory ?? null,
        sessionId: session.id,
        queries: queryTokens(text).slice(0, 5),
      });
    }
  }
  return candidates.slice(0, 12);
}

export async function runDreamMemoryConsolidation(options: DreamRunOptions): Promise<DreamRunReport> {
  const now = options.now ?? Date.now();
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  const sessionLimit = options.sessionLimit ?? DEFAULT_SESSION_LIMIT;
  const memoryIO = options.memoryIO ?? defaultMemoryIO;
  const windowStart = now - windowDays * 24 * 60 * 60 * 1000;
  const history = new TranscriptHistoryService(options.db);

  const allSessions = options.db.listSessions(sessionLimit, 0, true);
  const sessions = pickSessions(allSessions, options.projectPath, windowStart);
  const messagesBySession = new Map<string, Message[]>();
  for (const session of sessions) {
    messagesBySession.set(session.id, options.db.getRecentMessages(session.id, DEFAULT_RECENT_MESSAGES));
  }

  const listedMemory = await memoryIO.listEntries(options.db);
  const existingMemory = listedMemory.entries;
  const initialExistingMemoryCount = existingMemory.length;
  const extractor = options.candidateExtractor ?? extractDreamCandidatesFromRecentMessages;
  const candidates = await extractor({
    sessions,
    messagesBySession,
    existingMemory,
    projectPath: options.projectPath,
    now,
  });

  const verified: DreamRunReport['verified'] = [];
  const written: DreamRunReport['written'] = [];
  const skipped: DreamSkippedCandidate[] = [];
  for (const candidate of candidates) {
    const id = candidateId(candidate);
    if (!candidate.title.trim() || !candidate.content.trim()) {
      skipped.push({ candidateId: id, reason: 'empty-candidate' });
      continue;
    }
    if (isDuplicate(candidate, existingMemory)) {
      skipped.push({ candidateId: id, reason: 'duplicate-memory' });
      continue;
    }
    const evidence = await verifyCandidate(candidate, history);
    if (!evidence) {
      skipped.push({ candidateId: id, reason: 'no-fts-evidence' });
      continue;
    }
    verified.push({ candidate, evidence });
    const entry = buildDreamEntry(candidate, evidence, options.projectPath, now);
    await memoryIO.writeEntry(entry);
    memoryIO.createMirror(options.db, entry, {
      category: 'flush_decision',
      metadata: {
        dream: {
          source: DREAM_MEMORY_SOURCE,
          candidateId: evidence.candidateId,
          verifiedBy: 'transcript_fts',
        },
      },
    });
    existingMemory.push(entry);
    written.push({ entryId: entry.id, title: entry.title, evidence });
  }

  const pruned = await pruneStaleDreamEntries(
    options.db,
    memoryIO,
    existingMemory,
    now,
    options.pruneOlderThanDays ?? DEFAULT_PRUNE_OLDER_THAN_DAYS,
  );

  return {
    phase: 'completed',
    sessionsReviewed: sessions.length,
    existingMemoryCount: initialExistingMemoryCount,
    candidates,
    verified,
    written,
    pruned,
    skipped,
  };
}

export function formatDreamRunReport(report: DreamRunReport): string {
  return [
    `Consolidated: ${report.written.map((item) => item.title).join(', ') || 'none'}`,
    `Verified: ${report.verified.length}/${report.candidates.length}`,
    `Deleted: ${report.pruned.length > 0 ? report.pruned.join(', ') : 'none'}`,
    `Skipped: ${report.skipped.map((item) => `${item.candidateId}:${item.reason}`).join(', ') || 'none'}`,
  ].join('\n');
}
