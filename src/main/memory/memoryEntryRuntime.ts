import type {
  MemoryEntry,
  MemoryEntryEvidence,
  MemoryEntryDeleteRequest,
  MemoryEntryDeleteResult,
  MemoryEntryKind,
  MemoryEntryListResult,
  MemoryEntryScope,
  MemoryEntryStatus,
  MemoryEntryUpdateRequest,
  MemoryEntryUpdateResult,
  MemoryImportV2ApplyResult,
  MemoryExportV2Bundle,
  MemoryImportV2DryRunResult,
  MemoryMirrorRebuildResult,
  MemoryPackRequest,
  MemoryPackResult,
  PackedMemoryItem,
} from '../../shared/contract/memory';
import * as fs from 'fs/promises';
import type { MemoryRecord } from '../services/core/repositories';
import { getMemoryIndexPath } from '../lightMemory/indexLoader';
import {
  deleteMemoryFile,
  listMemoryFiles,
  rebuildLightMemoryIndex,
  writeLightMemoryFile,
  type LightMemoryFile,
} from '../lightMemory/lightMemoryIpc';
import { hashInboxContent } from './knowledgeInboxDecision';
import { sanitizeMemoryContent } from '../utils/sanitizeMemoryContent';

interface MemoryEntryDatabase {
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
  deleteMemory?(id: string): boolean;
}

export interface BuildActiveMemoryEntryInput {
  candidateId: string;
  content: string;
  title: string;
  source: string;
  reason: string;
  kind?: string;
  projectPath?: string | null;
  sessionId?: string | null;
  contentHash?: string;
  now?: number;
}

export function memoryEntryKindForInboxKind(kind: string | undefined): MemoryEntryKind {
  switch (kind) {
    case '候选项目知识':
      return 'project';
    case '失败复盘':
    case '可沉淀经验':
      return 'pattern';
    case '会话结论':
      return 'session';
    default:
      return 'reference';
  }
}

function memoryEntryKindForLightType(type: string): MemoryEntryKind {
  switch (type) {
    case 'user':
      return 'user';
    case 'feedback':
      return 'feedback';
    case 'project':
      return 'project';
    case 'reference':
      return 'reference';
    default:
      return 'reference';
  }
}

function lightTypeForMemoryEntryKind(kind: MemoryEntryKind): string {
  switch (kind) {
    case 'user':
      return 'user';
    case 'feedback':
      return 'feedback';
    case 'project':
      return 'project';
    case 'pattern':
      return 'project';
    case 'session':
      return 'project';
    case 'reference':
    default:
      return 'reference';
  }
}

function categoryForMemoryEntryKind(kind: MemoryEntryKind): string {
  switch (kind) {
    case 'user':
      return 'preference';
    case 'feedback':
      return 'user_requirement';
    case 'project':
      return 'flush_decision';
    case 'pattern':
      return 'pattern';
    case 'session':
      return 'user_requirement';
    case 'reference':
    default:
      return 'reference';
  }
}

function scopeForEntry(kind: MemoryEntryKind, projectPath?: string | null, sessionId?: string | null): MemoryEntryScope {
  if (sessionId && kind === 'session') return 'session';
  if (projectPath || kind === 'project' || kind === 'pattern') return 'project';
  return 'global';
}

function compactText(value: string | undefined, limit: number): string {
  const text = (value || '').replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function clampNumber(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value as number)));
}

function normalizeText(value: string | null | undefined): string {
  return (value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function tokenizeQuery(query: string): string[] {
  const text = normalizeText(query);
  if (!text) return [];
  const tokens = text.split(/[^a-z0-9_\u4e00-\u9fff]+/i)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
  return Array.from(new Set(tokens)).slice(0, 12);
}

function truncateForBudget(value: string, limit: number): { content: string; truncated: boolean } {
  if (value.length <= limit) return { content: value, truncated: false };
  return {
    content: `${value.slice(0, Math.max(0, limit - 18)).trimEnd()}\n... [truncated]`,
    truncated: true,
  };
}

function memoryEntryFingerprint(entry: MemoryEntry): string {
  return hashInboxContent([
    entry.kind,
    entry.scope,
    entry.status,
    entry.title,
    entry.summary,
    entry.content,
  ].join('\n'));
}

function scopeMatches(entry: MemoryEntry, request: MemoryPackRequest): boolean {
  if (entry.scope === 'global') return true;
  if (entry.scope === 'project') return !entry.projectPath || Boolean(request.projectPath && entry.projectPath === request.projectPath);
  if (entry.scope === 'session') return Boolean(request.sessionId && entry.sessionId === request.sessionId);
  return false;
}

function scoreMemoryEntry(entry: MemoryEntry, request: MemoryPackRequest, tokens: string[]): {
  score: number;
  reasons: string[];
} {
  let score = 0;
  const reasons: string[] = [];
  if (entry.status === 'active') {
    score += 25;
    reasons.push('active');
  }
  if (entry.scope === 'global') {
    score += 4;
    reasons.push('global');
  }
  if (request.projectPath && entry.projectPath === request.projectPath) {
    score += 16;
    reasons.push('project-match');
  }
  if (request.sessionId && entry.sessionId === request.sessionId) {
    score += 10;
    reasons.push('session-match');
  }
  if (entry.source.sourceOfTruth === 'light_file') {
    score += 8;
    reasons.push('light-source');
  }
  score += Math.max(0, Math.min(12, entry.confidence * 12));

  if (tokens.length > 0) {
    const title = normalizeText(entry.title);
    const summary = normalizeText(entry.summary);
    const content = normalizeText(entry.content);
    let matched = 0;
    for (const token of tokens) {
      if (title.includes(token)) {
        score += 12;
        matched++;
      } else if (summary.includes(token)) {
        score += 8;
        matched++;
      } else if (content.includes(token)) {
        score += 4;
        matched++;
      }
    }
    if (matched > 0) reasons.push(`query-match:${matched}`);
    else score -= 12;
  }

  return { score, reasons };
}

function antiLostInMiddleOrder(items: PackedMemoryItem[]): PackedMemoryItem[] {
  if (items.length <= 2) return items;
  const [first, second, ...rest] = items;
  return [first, ...rest, second];
}

function renderPackedMemoryBlock(items: PackedMemoryItem[]): string {
  if (items.length === 0) return '';
  return [
    '<memory-pack>',
    ...items.map((item, index) => [
      `- [${index + 1}] ${item.title}`,
      `  id: ${item.entryId}`,
      `  kind: ${item.kind}; scope: ${item.scope}; score: ${Math.round(item.score)}`,
      `  source: ${item.source.label || item.source.filePath || item.source.memoryId || item.source.kind}`,
      `  content: ${item.content.replace(/\n/g, '\n    ')}`,
    ].join('\n')),
    '</memory-pack>',
  ].join('\n');
}

function sanitizePackedMemoryText(value: string): string {
  return value
    .split('\n')
    .map((line) => sanitizeMemoryContent(line))
    .join('\n');
}

const VALID_ENTRY_STATUSES = new Set<MemoryEntryStatus>([
  'candidate',
  'active',
  'rejected',
  'stale',
  'archived',
]);

const VALID_ENTRY_KINDS = new Set<MemoryEntryKind>([
  'user',
  'feedback',
  'project',
  'reference',
  'session',
  'pattern',
]);

const VALID_ENTRY_SCOPES = new Set<MemoryEntryScope>([
  'global',
  'project',
  'session',
]);

function normalizeEntryStatus(value: MemoryEntryStatus | undefined, fallback: MemoryEntryStatus): MemoryEntryStatus {
  return value && VALID_ENTRY_STATUSES.has(value) ? value : fallback;
}

function normalizeEntryKind(value: MemoryEntryKind | undefined, fallback: MemoryEntryKind): MemoryEntryKind {
  return value && VALID_ENTRY_KINDS.has(value) ? value : fallback;
}

function normalizeEntryScope(value: MemoryEntryScope | undefined, fallback: MemoryEntryScope): MemoryEntryScope {
  return value && VALID_ENTRY_SCOPES.has(value) ? value : fallback;
}

function memoryEntryIdForLightFile(file: LightMemoryFile): string {
  return file.entryId || `light:${file.filename}`;
}

function memoryEntryIdForInbox(input: BuildActiveMemoryEntryInput): string {
  return `mem_entry_${hashInboxContent(`${input.candidateId}\n${input.content}`)}`;
}

function memoryEntryFilenameForId(id: string): string {
  const rawId = id.replace(/^mem_entry_/, '');
  return `memory-${rawId}.md`;
}

function memoryEntryMetadata(memory: MemoryRecord): Record<string, unknown> | null {
  const value = memory.metadata?.memoryEntry;
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}

export function lightMemoryFileToEntry(file: LightMemoryFile): MemoryEntry {
  const kind = memoryEntryKindForLightType(file.type);
  const updatedAt = Date.parse(file.updatedAt) || Date.now();
  return {
    id: memoryEntryIdForLightFile(file),
    schemaVersion: 2,
    status: file.status || 'active',
    kind,
    scope: scopeForEntry(kind),
    title: file.name || file.filename.replace(/\.md$/, ''),
    summary: file.description || compactText(file.content, 160),
    content: file.content,
    source: {
      kind: 'light_file',
      sourceOfTruth: 'light_file',
      filePath: file.filename,
      label: `~/.code-agent/memory/${file.filename}`,
    },
    evidence: [{ filePath: file.filename, source: file.source || 'light-memory' }],
    projectPath: null,
    sessionId: null,
    confidence: 1,
    createdAt: updatedAt,
    updatedAt,
  };
}

export function storedMemoryToEntry(memory: MemoryRecord): MemoryEntry {
  const meta = memoryEntryMetadata(memory);
  const kind = (meta?.kind as MemoryEntryKind | undefined)
    || (memory.type === 'user_preference' ? 'user' : memory.category === 'pattern' ? 'pattern' : 'project');
  const status = meta?.status === 'candidate'
    || meta?.status === 'active'
    || meta?.status === 'rejected'
    || meta?.status === 'stale'
    || meta?.status === 'archived'
    ? meta.status
    : memory.source === 'session_extracted' ? 'candidate' : 'active';
  const sourceOfTruth = meta?.sourceOfTruth === 'light_file' ? 'light_file' : 'db_memory';
  const evidence = Array.isArray(meta?.evidence)
    ? meta.evidence as MemoryEntryEvidence[]
    : [{ memoryId: memory.id, sessionId: memory.sessionId ?? null, source: memory.source }];

  return {
    id: typeof meta?.id === 'string' ? meta.id : `db:${memory.id}`,
    schemaVersion: 2,
    status,
    kind,
    scope: scopeForEntry(kind, memory.projectPath ?? null, memory.sessionId ?? null),
    title: compactText(memory.summary || memory.content, 120) || memory.category,
    summary: compactText(memory.content, 180),
    content: memory.content,
    source: {
      kind: 'db_memory',
      sourceOfTruth,
      filePath: typeof meta?.filePath === 'string' ? meta.filePath : null,
      memoryId: memory.id,
      label: sourceOfTruth === 'light_file' ? 'DB mirror of Light Memory' : 'legacy DB memory',
    },
    evidence,
    projectPath: memory.projectPath ?? null,
    sessionId: memory.sessionId ?? null,
    confidence: memory.confidence,
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
  };
}

export function buildActiveMemoryEntryFromInbox(input: BuildActiveMemoryEntryInput): MemoryEntry {
  const kind = memoryEntryKindForInboxKind(input.kind);
  const now = input.now ?? Date.now();
  const contentHash = input.contentHash || hashInboxContent(input.content);
  const id = memoryEntryIdForInbox(input);
  return {
    id,
    schemaVersion: 2,
    status: 'active',
    kind,
    scope: scopeForEntry(kind, input.projectPath, input.sessionId),
    title: compactText(input.title || input.content, 120) || id,
    summary: compactText(input.reason || input.content, 180) || input.title || id,
    content: input.content.trim(),
    source: {
      kind: 'knowledge_inbox',
      sourceOfTruth: 'light_file',
      filePath: memoryEntryFilenameForId(id),
      label: input.source || 'Knowledge Inbox',
    },
    evidence: [{
      candidateId: input.candidateId,
      contentHash,
      sessionId: input.sessionId ?? null,
      source: input.source || null,
    }],
    projectPath: input.projectPath ?? null,
    sessionId: input.sessionId ?? null,
    confidence: 1,
    createdAt: now,
    updatedAt: now,
  };
}

export async function writeActiveEntryToLightMemory(entry: MemoryEntry): Promise<LightMemoryFile> {
  const file = await writeLightMemoryFile({
    filename: entry.source.filePath || memoryEntryFilenameForId(entry.id),
    name: entry.title,
    description: entry.summary,
    type: lightTypeForMemoryEntryKind(entry.kind),
    content: entry.content,
    entryId: entry.id,
    status: entry.status,
    source: entry.source.kind,
    schemaVersion: entry.schemaVersion,
  });
  await rebuildLightMemoryIndex();
  return file;
}

export function createMemoryMirrorRecord(
  db: MemoryEntryDatabase,
  entry: MemoryEntry,
  options: {
    metadata?: Record<string, unknown>;
    category?: string;
  } = {},
): MemoryRecord {
  return db.createMemory({
    type: entry.kind === 'user' ? 'user_preference' : 'project_knowledge',
    category: options.category || categoryForMemoryEntryKind(entry.kind),
    content: entry.content,
    summary: entry.title || entry.summary,
    source: 'user_defined',
    projectPath: entry.projectPath ?? undefined,
    sessionId: entry.sessionId ?? undefined,
    confidence: entry.confidence,
    metadata: {
      ...(options.metadata || {}),
      memoryEntry: {
        schemaVersion: entry.schemaVersion,
        id: entry.id,
        status: entry.status,
        kind: entry.kind,
        scope: entry.scope,
        sourceOfTruth: 'light_file',
        filePath: entry.source.filePath,
        evidence: entry.evidence,
      },
    },
  });
}

export async function listUnifiedMemoryEntries(db?: MemoryEntryDatabase): Promise<MemoryEntryListResult> {
  const lightEntries = (await listMemoryFiles()).map(lightMemoryFileToEntry);
  const dbEntries = db
    ? db.listMemories({ limit: 500, orderBy: 'updated_at', orderDir: 'DESC' }).map(storedMemoryToEntry)
    : [];
  const lightEntryIds = new Set(lightEntries.map((entry) => entry.id));
  const entries = [
    ...lightEntries,
    ...dbEntries.filter((entry) => !(entry.source.sourceOfTruth === 'light_file' && lightEntryIds.has(entry.id))),
  ].sort((a, b) => b.updatedAt - a.updatedAt);

  return {
    entries,
    sourceCounts: entries.reduce<Record<'light_file' | 'db_memory', number>>((acc, entry) => {
      acc[entry.source.sourceOfTruth] = (acc[entry.source.sourceOfTruth] || 0) + 1;
      return acc;
    }, { light_file: 0, db_memory: 0 }),
  };
}

export async function rebuildMemoryMirrorFromLightFiles(db: MemoryEntryDatabase): Promise<MemoryMirrorRebuildResult> {
  const files = await listMemoryFiles();
  const existingMirrors = db.listMemories({ limit: 1000, orderBy: 'updated_at', orderDir: 'DESC' })
    .filter((memory) => memoryEntryMetadata(memory)?.sourceOfTruth === 'light_file');
  const existingByEntryId = new Map<string, MemoryRecord>();
  const existingByFilePath = new Map<string, MemoryRecord>();

  for (const memory of existingMirrors) {
    const meta = memoryEntryMetadata(memory);
    if (typeof meta?.id === 'string') existingByEntryId.set(meta.id, memory);
    if (typeof meta?.filePath === 'string') existingByFilePath.set(meta.filePath, memory);
  }

  let created = 0;
  let updated = 0;
  const skipped: MemoryMirrorRebuildResult['skipped'] = [];

  for (const file of files) {
    try {
      const entry = lightMemoryFileToEntry(file);
      const existing = existingByEntryId.get(entry.id) || existingByFilePath.get(file.filename);
      if (existing) {
        db.updateMemory(existing.id, {
          content: entry.content,
          summary: entry.title || entry.summary,
          category: categoryForMemoryEntryKind(entry.kind),
          confidence: 1,
          metadata: {
            ...existing.metadata,
            memoryEntry: {
              schemaVersion: entry.schemaVersion,
              id: entry.id,
              status: entry.status,
              kind: entry.kind,
              scope: entry.scope,
              sourceOfTruth: 'light_file',
              filePath: file.filename,
              evidence: entry.evidence,
            },
          },
        });
        updated++;
      } else {
        createMemoryMirrorRecord(db, entry, {
          category: categoryForMemoryEntryKind(entry.kind),
        });
        created++;
      }
    } catch (error) {
      skipped.push({
        filename: file.filename,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    totalLightFiles: files.length,
    mirrored: created + updated,
    created,
    updated,
    skipped,
  };
}

export async function packMemoryEntries(
  request: MemoryPackRequest,
  db?: MemoryEntryDatabase,
): Promise<MemoryPackResult> {
  const maxItems = clampNumber(request.maxItems, 8, 1, 30);
  const perItemCharLimit = clampNumber(request.perItemCharLimit, 900, 120, 5_000);
  const totalCharBudget = clampNumber(request.totalCharBudget, 4_000, 500, 30_000);
  const statuses = new Set<MemoryEntryStatus>(request.statuses?.length ? request.statuses : ['active']);
  const kinds = request.kinds?.length ? new Set<MemoryEntryKind>(request.kinds) : null;
  const query = (request.query || '').trim();
  const tokens = tokenizeQuery(query);
  const entries = (await listUnifiedMemoryEntries(db)).entries;

  const candidates = entries
    .filter((entry) => statuses.has(entry.status))
    .filter((entry) => !kinds || kinds.has(entry.kind))
    .filter((entry) => scopeMatches(entry, request))
    .map((entry) => {
      const scored = scoreMemoryEntry(entry, request, tokens);
      return { entry, score: scored.score, reasons: scored.reasons };
    })
    .filter((item) => tokens.length === 0 || item.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.entry.updatedAt - a.entry.updatedAt;
    });

  const selected: PackedMemoryItem[] = [];
  let usedChars = 0;
  for (const candidate of candidates) {
    if (selected.length >= maxItems) break;
    const remainingBudget = totalCharBudget - usedChars;
    if (remainingBudget <= 0) break;
    const cap = Math.min(perItemCharLimit, remainingBudget);
    const safeContent = sanitizePackedMemoryText(candidate.entry.content);
    const packed = truncateForBudget(safeContent, cap);
    const item: PackedMemoryItem = {
      entryId: candidate.entry.id,
      title: candidate.entry.title,
      kind: candidate.entry.kind,
      scope: candidate.entry.scope,
      status: candidate.entry.status,
      score: candidate.score,
      scoreReasons: candidate.reasons,
      source: candidate.entry.source,
      evidence: candidate.entry.evidence,
      content: packed.content,
      originalChars: safeContent.length,
      packedChars: packed.content.length,
      truncated: packed.truncated,
    };
    selected.push(item);
    usedChars += item.packedChars;
  }

  const ordered = antiLostInMiddleOrder(selected);
  return {
    query,
    totalCandidates: candidates.length,
    selectedCount: ordered.length,
    totalChars: ordered.reduce((sum, item) => sum + item.packedChars, 0),
    budget: totalCharBudget,
    items: ordered,
    block: renderPackedMemoryBlock(ordered),
  };
}

export async function exportMemoryBundleV2(db?: MemoryEntryDatabase): Promise<MemoryExportV2Bundle> {
  const listed = await listUnifiedMemoryEntries(db);
  let indexContent: string | null = null;
  const indexPath = getMemoryIndexPath();
  try {
    indexContent = await fs.readFile(indexPath, 'utf-8');
  } catch {
    indexContent = null;
  }

  return {
    schemaVersion: 2,
    exportedAt: Date.now(),
    entries: listed.entries,
    index: {
      path: indexPath,
      content: indexContent,
    },
    evidenceManifest: listed.entries.map((entry) => ({
      entryId: entry.id,
      evidence: entry.evidence,
      source: entry.source,
    })),
    sourceCounts: listed.sourceCounts,
  };
}

export async function dryRunImportMemoryBundleV2(
  bundle: MemoryExportV2Bundle,
  db?: MemoryEntryDatabase,
): Promise<MemoryImportV2DryRunResult> {
  const existing = (await listUnifiedMemoryEntries(db)).entries;
  const existingById = new Map(existing.map((entry) => [entry.id, entry]));
  const seenIncoming = new Set<string>();
  const items: MemoryImportV2DryRunResult['items'] = [];

  for (const incoming of bundle.entries || []) {
    if (incoming.schemaVersion !== 2 || !incoming.id || !incoming.content) {
      items.push({
        entryId: incoming.id || '(missing-id)',
        status: 'skip',
        reason: 'invalid-entry',
        incomingTitle: incoming.title,
      });
      continue;
    }
    if (seenIncoming.has(incoming.id)) {
      items.push({
        entryId: incoming.id,
        status: 'skip',
        reason: 'duplicate-in-bundle',
        incomingTitle: incoming.title,
        sourceOfTruth: incoming.source.sourceOfTruth,
      });
      continue;
    }
    seenIncoming.add(incoming.id);

    const current = existingById.get(incoming.id);
    if (!current) {
      items.push({
        entryId: incoming.id,
        status: 'add',
        reason: 'new-entry',
        incomingTitle: incoming.title,
        sourceOfTruth: incoming.source.sourceOfTruth,
      });
      continue;
    }

    const incomingHash = memoryEntryFingerprint(incoming);
    const currentHash = memoryEntryFingerprint(current);
    if (incomingHash === currentHash) {
      items.push({
        entryId: incoming.id,
        status: 'skip',
        reason: 'same-content',
        incomingTitle: incoming.title,
        existingTitle: current.title,
        sourceOfTruth: incoming.source.sourceOfTruth,
      });
      continue;
    }

    if (current.source.sourceOfTruth === 'light_file' && incoming.source.sourceOfTruth !== 'light_file') {
      items.push({
        entryId: incoming.id,
        status: 'conflict',
        reason: 'incoming-would-replace-light-source',
        incomingTitle: incoming.title,
        existingTitle: current.title,
        sourceOfTruth: incoming.source.sourceOfTruth,
      });
      continue;
    }

    items.push({
      entryId: incoming.id,
      status: 'update',
      reason: 'same-id-different-content',
      incomingTitle: incoming.title,
      existingTitle: current.title,
      sourceOfTruth: incoming.source.sourceOfTruth,
    });
  }

  return {
    schemaVersion: 2,
    incomingCount: bundle.entries?.length ?? 0,
    existingCount: existing.length,
    added: items.filter((item) => item.status === 'add').length,
    updated: items.filter((item) => item.status === 'update').length,
    conflicted: items.filter((item) => item.status === 'conflict').length,
    skipped: items.filter((item) => item.status === 'skip').length,
    items,
  };
}

function metadataForImportedEntry(entry: MemoryEntry, sourceOfTruth = entry.source.sourceOfTruth): Record<string, unknown> {
  return {
    memoryEntry: {
      schemaVersion: entry.schemaVersion,
      id: entry.id,
      status: entry.status,
      kind: entry.kind,
      scope: entry.scope,
      sourceOfTruth,
      filePath: entry.source.filePath ?? null,
      evidence: entry.evidence,
    },
  };
}

function memoryRecordInputForImportedEntry(entry: MemoryEntry): Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'> {
  return {
    type: entry.kind === 'user' ? 'user_preference' : 'project_knowledge',
    category: categoryForMemoryEntryKind(entry.kind),
    content: entry.content,
    summary: entry.title || entry.summary,
    source: 'user_defined',
    projectPath: entry.projectPath ?? undefined,
    sessionId: entry.sessionId ?? undefined,
    confidence: entry.confidence,
    metadata: metadataForImportedEntry(entry, entry.source.sourceOfTruth),
  };
}

function memoryRecordsByEntryId(db: MemoryEntryDatabase): Map<string, MemoryRecord> {
  const records = db.listMemories({ limit: 1000, orderBy: 'updated_at', orderDir: 'DESC' });
  const map = new Map<string, MemoryRecord>();
  for (const record of records) {
    const meta = memoryEntryMetadata(record);
    if (typeof meta?.id === 'string') {
      map.set(meta.id, record);
    }
  }
  return map;
}

function findMemoryRecordForEntry(db: MemoryEntryDatabase, entry: MemoryEntry): MemoryRecord | null {
  const records = db.listMemories({ limit: 1000, orderBy: 'updated_at', orderDir: 'DESC' });
  const memoryId = entry.source.memoryId || (entry.id.startsWith('db:') ? entry.id.slice(3) : null);
  return records.find((record) => memoryEntryMetadata(record)?.id === entry.id)
    || records.find((record) => Boolean(memoryId) && record.id === memoryId)
    || null;
}

function buildUpdatedMemoryEntry(current: MemoryEntry, request: MemoryEntryUpdateRequest): MemoryEntry {
  const title = request.title !== undefined
    ? compactText(request.title, 120) || current.title
    : current.title;
  const content = request.content !== undefined
    ? request.content.trim() || current.content
    : current.content;
  const summary = request.summary !== undefined
    ? compactText(request.summary, 180) || compactText(content, 180)
    : current.summary;
  const kind = normalizeEntryKind(request.kind, current.kind);
  return {
    ...current,
    status: normalizeEntryStatus(request.status, current.status),
    kind,
    scope: normalizeEntryScope(request.scope, current.scope),
    title,
    summary,
    content,
    updatedAt: Date.now(),
  };
}

export async function updateMemoryEntry(
  db: MemoryEntryDatabase,
  request: MemoryEntryUpdateRequest,
): Promise<MemoryEntryUpdateResult> {
  const current = (await listUnifiedMemoryEntries(db)).entries.find((entry) => entry.id === request.entryId);
  if (!current) throw new Error(`Memory entry not found: ${request.entryId}`);

  const next = buildUpdatedMemoryEntry(current, request);
  if (current.source.sourceOfTruth === 'light_file') {
    const file = await writeLightMemoryFile({
      filename: current.source.filePath || memoryEntryFilenameForId(current.id),
      name: next.title,
      description: next.summary,
      type: lightTypeForMemoryEntryKind(next.kind),
      content: next.content,
      entryId: next.id,
      status: next.status,
      source: current.source.kind,
      schemaVersion: next.schemaVersion,
    });
    await rebuildLightMemoryIndex();
    const mirrorRebuild = await rebuildMemoryMirrorFromLightFiles(db);
    return {
      entry: {
        ...lightMemoryFileToEntry(file),
        evidence: current.evidence,
        projectPath: current.projectPath,
        sessionId: current.sessionId,
        confidence: current.confidence,
        createdAt: current.createdAt,
      },
      mirrorRebuild,
    };
  }

  const record = findMemoryRecordForEntry(db, current);
  if (!record) throw new Error(`Memory record not found for entry: ${request.entryId}`);
  const updated = db.updateMemory(record.id, {
    category: categoryForMemoryEntryKind(next.kind),
    content: next.content,
    summary: next.title || next.summary,
    confidence: next.confidence,
    metadata: {
      ...record.metadata,
      ...metadataForImportedEntry({
        ...next,
        source: {
          ...next.source,
          sourceOfTruth: 'db_memory',
          memoryId: record.id,
        },
      }, 'db_memory'),
    },
  });
  if (!updated) throw new Error(`Memory record update failed: ${record.id}`);

  return {
    entry: storedMemoryToEntry(updated),
  };
}

export async function deleteMemoryEntry(
  db: MemoryEntryDatabase,
  request: MemoryEntryDeleteRequest,
): Promise<MemoryEntryDeleteResult> {
  const current = (await listUnifiedMemoryEntries(db)).entries.find((entry) => entry.id === request.entryId);
  if (!current) return { deleted: false };

  if (current.source.sourceOfTruth === 'light_file') {
    const filename = current.source.filePath;
    if (!filename) throw new Error(`Light memory filename missing for entry: ${request.entryId}`);
    const deleted = await deleteMemoryFile(filename);
    const mirrorRecord = findMemoryRecordForEntry(db, current);
    if (mirrorRecord && db.deleteMemory) {
      db.deleteMemory(mirrorRecord.id);
    }
    await rebuildLightMemoryIndex();
    const mirrorRebuild = await rebuildMemoryMirrorFromLightFiles(db);
    return {
      deleted,
      sourceOfTruth: 'light_file',
      mirrorRebuild,
    };
  }

  const record = findMemoryRecordForEntry(db, current);
  if (!record || !db.deleteMemory) {
    return {
      deleted: false,
      sourceOfTruth: 'db_memory',
    };
  }

  return {
    deleted: db.deleteMemory(record.id),
    sourceOfTruth: 'db_memory',
  };
}

async function writeImportedLightEntry(entry: MemoryEntry): Promise<string> {
  const file = await writeLightMemoryFile({
    filename: entry.source.filePath || memoryEntryFilenameForId(entry.id),
    name: entry.title,
    description: entry.summary,
    type: lightTypeForMemoryEntryKind(entry.kind),
    content: entry.content,
    entryId: entry.id,
    status: entry.status,
    source: entry.source.kind,
    schemaVersion: entry.schemaVersion,
  });
  return file.filename;
}

export async function applyImportMemoryBundleV2(
  bundle: MemoryExportV2Bundle,
  db: MemoryEntryDatabase,
  options: { allowConflicts?: boolean } = {},
): Promise<MemoryImportV2ApplyResult> {
  const dryRun = await dryRunImportMemoryBundleV2(bundle, db);
  const incomingById = new Map((bundle.entries || []).map((entry) => [entry.id, entry]));
  const existingRecords = memoryRecordsByEntryId(db);
  const writtenFiles: string[] = [];
  let applied = 0;
  let created = 0;
  let updatedApplied = 0;
  let skippedApply = 0;
  let lightChanged = false;

  for (const diff of dryRun.items) {
    const entry = incomingById.get(diff.entryId);
    const canApply = diff.status === 'add'
      || diff.status === 'update'
      || (diff.status === 'conflict' && options.allowConflicts);
    if (!entry || !canApply) {
      skippedApply++;
      continue;
    }

    if (entry.source.sourceOfTruth === 'light_file') {
      const filename = await writeImportedLightEntry(entry);
      writtenFiles.push(filename);
      lightChanged = true;
    } else {
      const existing = existingRecords.get(entry.id);
      if (existing && diff.status !== 'add') {
        db.updateMemory(existing.id, {
          category: categoryForMemoryEntryKind(entry.kind),
          content: entry.content,
          summary: entry.title || entry.summary,
          confidence: entry.confidence,
          metadata: {
            ...existing.metadata,
            ...metadataForImportedEntry(entry, entry.source.sourceOfTruth),
          },
        });
      } else {
        db.createMemory(memoryRecordInputForImportedEntry(entry));
      }
    }

    applied++;
    if (diff.status === 'add') created++;
    else updatedApplied++;
  }

  const mirrorRebuild = lightChanged
    ? await rebuildMemoryMirrorFromLightFiles(db)
    : undefined;
  if (lightChanged) {
    await rebuildLightMemoryIndex();
  }

  return {
    ...dryRun,
    applied,
    created,
    updatedApplied,
    skippedApply,
    writtenFiles,
    mirrorRebuild,
  };
}
