import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../../src/shared/contract';
import type { MemoryEntry } from '../../../../src/shared/contract/memory';
import type { MemoryRecord } from '../../../../src/main/services/core/repositories';
import { BUILTIN_SKILLS } from '../../../../src/main/services/skills/builtinSkills';
import {
  buildSkillInvocationContext,
  resolveSkillInvocationFromSkills,
} from '../../../../src/main/services/skills/skillInvocationResolver';
import { unregisterSkillExecutor } from '../../../../src/main/services/skills/skillExecutorRegistry';
import {
  DREAM_SKILL_NAME,
  registerDreamSkillExecutor,
  type DreamExecutorOverrides,
} from '../../../../src/main/services/memory/dreamExecutor';
import type { DreamCandidate } from '../../../../src/main/services/memory/dreamMemoryService';

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

function dreamInvocation() {
  const dream = BUILTIN_SKILLS.find((skill) => skill.name === DREAM_SKILL_NAME);
  expect(dream, 'dream 内置 skill 应存在').toBeTruthy();
  const invocation = resolveSkillInvocationFromSkills('/dream', [dream!]);
  expect(invocation?.skill.name).toBe(DREAM_SKILL_NAME);
  return invocation!;
}

afterEach(() => {
  unregisterSkillExecutor(DREAM_SKILL_NAME);
});

describe('dreamExecutor', () => {
  it('/dream 通过 executor 桥实跑 runDreamMemoryConsolidation，并在 FTS 有证据时写入', async () => {
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
    const overrides: DreamExecutorOverrides = {
      db,
      now: NOW,
      candidateExtractor: vi.fn(async () => [verifiedCandidate]),
      memoryIO,
    };
    registerDreamSkillExecutor(overrides);

    const context = await buildSkillInvocationContext(dreamInvocation(), '/repo');

    expect(context.block).toContain('<skill-execution-report status="completed">');
    expect(context.block).toContain('Dream executor: runDreamMemoryConsolidation');
    expect(context.block).toContain('Verified: 1/1');
    expect(context.block).toContain('Consolidated: 轨迹库权威原则');
    expect(memoryIO.writeEntry).toHaveBeenCalledOnce();
  });

  it('/dream 通过同一确定性路径拒绝无 FTS 证据候选，不写 memory', async () => {
    const db = makeDb();
    db.searchTranscriptFts.mockReturnValue([]);
    const memoryIO = makeMemoryIO();
    registerDreamSkillExecutor({
      db,
      now: NOW,
      candidateExtractor: vi.fn(async () => [verifiedCandidate]),
      memoryIO,
    });

    const context = await buildSkillInvocationContext(dreamInvocation(), '/repo');

    expect(context.block).toContain('Dream executor: runDreamMemoryConsolidation');
    expect(context.block).toContain('Verified: 0/1');
    expect(context.block).toContain('Skipped: cand-source-of-truth:no-fts-evidence');
    expect(memoryIO.writeEntry).not.toHaveBeenCalled();
  });
});
