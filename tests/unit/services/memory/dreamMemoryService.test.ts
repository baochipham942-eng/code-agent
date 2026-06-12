import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/shared/contract';
import type { MemoryEntry } from '../../../../src/shared/contract/memory';
import type { MemoryRecord } from '../../../../src/main/services/core/repositories';
import { BUILTIN_SKILLS } from '../../../../src/main/services/skills/builtinSkills';
import { resolveSkillInvocationFromSkills } from '../../../../src/main/services/skills/skillInvocationResolver';
import {
  DREAM_MEMORY_SOURCE,
  runDreamMemoryConsolidation,
  supportsCandidate,
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

describe('supportsCandidate — 防幻觉门强度（audit fix A-H1）', () => {
  const hit = (snippet: string) =>
    ({ sessionId: 'sess-1', messageId: 'msg-1', snippet, timestamp: NOW }) as never;
  const cand = (overrides: Partial<DreamCandidate>): DreamCandidate =>
    ({ id: 'c', title: '', summary: '', content: '', ...overrides }) as DreamCandidate;

  it('单 token 候选不能凭 1 个 token 命中放行（阈值下限 2）', () => {
    const candidate = cand({ title: '决定', content: 'a b c 1 2 3 x!' });
    expect(supportsCandidate(candidate, hit('我们今天决定先去吃饭'), null)).toBe(false);
  });

  it('多 token 候选仅命中 2 个泛词不放行（阈值随 token 数缩放）', () => {
    const candidate = cand({
      title: 'memory consolidation principle',
      content: 'transcript authority verification gateway threshold scaling adversarial fabricated detail',
    });
    expect(supportsCandidate(candidate, hit('we discussed memory consolidation today'), null)).toBe(false);
  });

  it('命中比例足够时仍放行（回归守护）', () => {
    const candidate = cand({
      title: 'history verification gate',
      content: 'history verification gate required before write',
    });
    expect(
      supportsCandidate(candidate, hit('agreed: history verification gate required before write'), null),
    ).toBe(true);
  });

  it('短 title 子串命中不再短路放行（逐字短路最短 12 字符）', () => {
    const candidate = cand({
      title: '记住这个修复原因',
      content: 'fabricated payload tokens nowhere appearing matched anywhere transcript',
    });
    expect(supportsCandidate(candidate, hit('上次说过记住这个修复原因'), null)).toBe(false);
  });

  it('长 summary 逐字命中仍放行（≥12 字符的逐字证据有效）', () => {
    const candidate = cand({
      title: '原则',
      summary: '轨迹库为权威而长期记忆只是缓存层',
      content: '轨迹库为权威而长期记忆只是缓存层。',
    });
    expect(
      supportsCandidate(candidate, hit('结论：轨迹库为权威而长期记忆只是缓存层，没有异议'), null),
    ).toBe(true);
  });
});

describe('runDreamMemoryConsolidation — audit fixes A-M2/A-L1', () => {
  it('窗口内无会话时不降级全历史，直接报告无可整理（A-M2）', async () => {
    const db = makeDb();
    // 唯一会话是 30 天前的——超出默认 7 天窗口
    db.listSessions.mockReturnValue([
      {
        id: 'sess-old',
        title: 'Stale session',
        workingDirectory: '/repo',
        createdAt: NOW - 30 * 24 * 60 * 60 * 1000,
        updatedAt: NOW - 30 * 24 * 60 * 60 * 1000,
      },
    ]);
    const memoryIO = makeMemoryIO();

    await runDreamMemoryConsolidation({
      db: db as never,
      projectPath: '/repo',
      now: NOW,
      memoryIO: memoryIO as never,
    });

    expect(memoryIO.writeEntry).not.toHaveBeenCalled();
    expect(db.searchTranscriptFts).not.toHaveBeenCalled();
  });

  it('候选 confidence 越界时 clamp 到 [0,1]（A-L1）', async () => {
    const db = makeDb();
    db.searchTranscriptFts.mockReturnValue([
      { sessionId: 'sess-1', messageId: 'msg-user', snippet: '决定：轨迹库为权威，memory 是缓存。', timestamp: NOW },
    ]);
    db.getTranscriptAround.mockReturnValue({ messages: [] });
    const memoryIO = makeMemoryIO();

    await runDreamMemoryConsolidation({
      db: db as never,
      projectPath: '/repo',
      now: NOW,
      memoryIO: memoryIO as never,
      candidateExtractor: async () => [{
        ...verifiedCandidate,
        confidence: 9999,
      }],
    });

    expect(memoryIO.writeEntry).toHaveBeenCalledTimes(1);
    const written = memoryIO.writeEntry.mock.calls[0][1] ?? memoryIO.writeEntry.mock.calls[0][0];
    const entry = (written && typeof written === 'object' && 'confidence' in (written as object))
      ? written as { confidence: number }
      : memoryIO.writeEntry.mock.calls[0].find(
          (arg: unknown) => arg && typeof arg === 'object' && 'confidence' in (arg as object),
        ) as { confidence: number };
    expect(entry.confidence).toBeLessThanOrEqual(1);
    expect(entry.confidence).toBeGreaterThanOrEqual(0);
  });
});

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
