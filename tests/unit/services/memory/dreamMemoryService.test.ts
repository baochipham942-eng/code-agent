import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/shared/contract';
import type { MemoryEntry } from '../../../../src/shared/contract/memory';
import type { MemoryRecord } from '../../../../src/main/services/core/repositories';
import { BUILTIN_SKILLS } from '../../../../src/main/services/skills/builtinSkills';
import { resolveSkillInvocationFromSkills } from '../../../../src/main/services/skills/skillInvocationResolver';
import {
  DREAM_MEMORY_SOURCE,
  runDreamMemoryConsolidation,
  type DreamCandidate,
} from '../../../../src/main/services/memory/dreamMemoryService';

const NOW = Date.UTC(2026, 5, 11, 9, 0, 0);

function message(overrides: Partial<Message>): Message {
  return {
    id: 'msg-default',
    role: 'assistant',
    content: '',
    timestamp: NOW,
    ...overrides,
  } as Message;
}

function memoryEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    id: 'mem-default',
    schemaVersion: 2,
    status: 'active',
    kind: 'project',
    scope: 'project',
    title: 'Default',
    summary: 'Default',
    content: 'Default memory content.',
    source: {
      kind: 'recent_conversation',
      sourceOfTruth: 'light_file',
      filePath: 'default.md',
    },
    evidence: [],
    projectPath: '/repo',
    sessionId: null,
    confidence: 0.9,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeDb() {
  return {
    listSessions: vi.fn(() => [
      {
        id: 'sess-1',
        title: 'Dream source session',
        workingDirectory: '/repo',
        createdAt: NOW - 60_000,
        updatedAt: NOW - 30_000,
      },
    ]),
    getRecentMessages: vi.fn(() => [
      message({ id: 'msg-user', role: 'user', content: '决定：轨迹库为权威，memory 是缓存。' }),
    ]),
    searchTranscriptFts: vi.fn(),
    getTranscriptAround: vi.fn(),
    listMemories: vi.fn(() => [] as MemoryRecord[]),
    createMemory: vi.fn((data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>) => ({
      id: 'mem-created',
      accessCount: 0,
      createdAt: NOW,
      updatedAt: NOW,
      ...data,
    })),
    updateMemory: vi.fn(),
    deleteMemory: vi.fn(),
    searchMemories: vi.fn(() => [] as MemoryRecord[]),
  };
}

function makeMemoryIO(existing: MemoryEntry[] = []) {
  return {
    listEntries: vi.fn(async () => ({
      entries: existing,
      sourceCounts: { light_file: existing.length, db_memory: 0 },
    })),
    writeEntry: vi.fn(async (entry: MemoryEntry) => ({
      filename: `${entry.id}.md`,
      entryId: entry.id,
    })),
    createMirror: vi.fn((db: ReturnType<typeof makeDb>, entry: MemoryEntry) => db.createMemory({
      type: 'project_knowledge',
      category: 'flush_decision',
      content: entry.content,
      summary: entry.title,
      source: 'user_defined',
      projectPath: entry.projectPath ?? undefined,
      sessionId: entry.sessionId ?? undefined,
      confidence: entry.confidence,
      metadata: { memoryEntry: { id: entry.id, evidence: entry.evidence } },
    })),
    updateEntry: vi.fn(),
  };
}

const verifiedCandidate: DreamCandidate = {
  id: 'cand-source-of-truth',
  title: '轨迹库权威原则',
  summary: '轨迹库为权威，memory 是缓存',
  content: '轨迹库为权威，memory 是缓存；dream 候选必须先经 History FTS 验证再写入。',
  kind: 'project',
  queries: ['轨迹库 权威 memory 缓存', 'History FTS 验证'],
};

describe('runDreamMemoryConsolidation', () => {
  it('demonstrates the /dream manual trigger path into a verified memory write', async () => {
    const dream = BUILTIN_SKILLS.find((skill) => skill.name === 'dream');
    const invocation = resolveSkillInvocationFromSkills('/dream', [dream!]);
    expect(invocation?.skill.agent).toBe('dream');

    const db = makeDb();
    db.searchTranscriptFts.mockReturnValue([
      {
        messageId: 'msg-user',
        sessionId: 'sess-1',
        kind: 'user_text',
        toolName: null,
        snippet: '轨迹库为权威，memory 是缓存',
        timestamp: NOW,
      },
    ]);
    db.getTranscriptAround.mockReturnValue({
      sessionId: 'sess-1',
      messages: [
        { matched: true, message: message({ id: 'msg-user', role: 'user', content: '决定：轨迹库为权威，memory 是缓存。候选必须经 History FTS 验证。' }) },
      ],
    });
    const memoryIO = makeMemoryIO();

    const report = await runDreamMemoryConsolidation({
      db,
      projectPath: '/repo',
      now: NOW,
      candidateExtractor: vi.fn(async () => [verifiedCandidate]),
      memoryIO,
    });

    expect(report).toMatchObject({
      sessionsReviewed: 1,
      existingMemoryCount: 0,
    });
    expect(report.verified).toHaveLength(1);
    expect(report.written).toHaveLength(1);
    expect(report.skipped).toEqual([]);
  });

  it('rejects candidates that cannot be verified through History FTS', async () => {
    const db = makeDb();
    db.searchTranscriptFts.mockReturnValue([]);
    const memoryIO = makeMemoryIO();

    const report = await runDreamMemoryConsolidation({
      db,
      projectPath: '/repo',
      now: NOW,
      candidateExtractor: vi.fn(async () => [verifiedCandidate]),
      memoryIO,
    });

    expect(report.phase).toBe('completed');
    expect(report.verified).toHaveLength(0);
    expect(report.written).toHaveLength(0);
    expect(report.skipped).toContainEqual(expect.objectContaining({
      candidateId: 'cand-source-of-truth',
      reason: 'no-fts-evidence',
    }));
    expect(memoryIO.writeEntry).not.toHaveBeenCalled();
  });

  it('writes only candidates supported by FTS search plus around context', async () => {
    const db = makeDb();
    db.searchTranscriptFts.mockReturnValue([
      {
        messageId: 'msg-user',
        sessionId: 'sess-1',
        kind: 'user_text',
        toolName: null,
        snippet: '轨迹库为权威，memory 是缓存',
        timestamp: NOW,
      },
    ]);
    db.getTranscriptAround.mockReturnValue({
      sessionId: 'sess-1',
      messages: [
        { matched: true, message: message({ id: 'msg-user', role: 'user', content: '决定：轨迹库为权威，memory 是缓存。候选必须经 History FTS 验证。' }) },
      ],
    });
    const memoryIO = makeMemoryIO();

    const report = await runDreamMemoryConsolidation({
      db,
      projectPath: '/repo',
      now: NOW,
      candidateExtractor: vi.fn(async () => [verifiedCandidate]),
      memoryIO,
    });

    expect(db.searchTranscriptFts).toHaveBeenCalled();
    expect(db.getTranscriptAround).toHaveBeenCalledWith('msg-user', { before: 3, after: 3 });
    expect(report.verified).toHaveLength(1);
    expect(report.written).toHaveLength(1);
    expect(memoryIO.writeEntry).toHaveBeenCalledWith(expect.objectContaining({
      title: '轨迹库权威原则',
      content: expect.stringContaining('History FTS 验证'),
      evidence: [expect.objectContaining({
        source: DREAM_MEMORY_SOURCE,
        sessionId: 'sess-1',
        messageId: 'msg-user',
        candidateId: 'cand-source-of-truth',
      })],
    }));
    expect(memoryIO.createMirror).toHaveBeenCalled();
  });

  it('deduplicates against existing memory before writing', async () => {
    const db = makeDb();
    db.searchTranscriptFts.mockReturnValue([
      {
        messageId: 'msg-user',
        sessionId: 'sess-1',
        kind: 'user_text',
        toolName: null,
        snippet: verifiedCandidate.summary,
        timestamp: NOW,
      },
    ]);
    db.getTranscriptAround.mockReturnValue({
      sessionId: 'sess-1',
      messages: [
        { matched: true, message: message({ id: 'msg-user', role: 'user', content: verifiedCandidate.content }) },
      ],
    });
    const memoryIO = makeMemoryIO([
      memoryEntry({
        id: 'mem-existing',
        title: verifiedCandidate.title,
        summary: verifiedCandidate.summary,
        content: verifiedCandidate.content,
      }),
    ]);

    const report = await runDreamMemoryConsolidation({
      db,
      projectPath: '/repo',
      now: NOW,
      candidateExtractor: vi.fn(async () => [verifiedCandidate]),
      memoryIO,
    });

    expect(report.written).toHaveLength(0);
    expect(report.skipped).toContainEqual(expect.objectContaining({
      candidateId: 'cand-source-of-truth',
      reason: 'duplicate-memory',
    }));
    expect(memoryIO.writeEntry).not.toHaveBeenCalled();
  });

  it('marks only stale dream-owned memory entries for pruning', async () => {
    const db = makeDb();
    const old = NOW - 91 * 24 * 60 * 60 * 1000;
    const dreamOwned = memoryEntry({
      id: 'dream_old',
      title: 'Old dream memory',
      evidence: [{ source: DREAM_MEMORY_SOURCE, candidateId: 'old' }],
      createdAt: old,
      updatedAt: old,
    });
    const userOwned = memoryEntry({
      id: 'mem_user',
      title: 'User memory',
      evidence: [{ source: 'manual' }],
      createdAt: old,
      updatedAt: old,
    });
    const memoryIO = makeMemoryIO([dreamOwned, userOwned]);

    const report = await runDreamMemoryConsolidation({
      db,
      projectPath: '/repo',
      now: NOW,
      candidateExtractor: vi.fn(async () => []),
      memoryIO,
      pruneOlderThanDays: 30,
    });

    expect(report.pruned).toEqual(['dream_old']);
    expect(memoryIO.updateEntry).toHaveBeenCalledTimes(1);
    expect(memoryIO.updateEntry).toHaveBeenCalledWith(db, {
      entryId: 'dream_old',
      status: 'stale',
    });
  });
});
