// ============================================================================
// N-MEM-WRITECONF：中置信度 durable fact 写 candidate 后，必须能走完既有人工复核闭环
// listUnifiedMemoryEntries（设置页 MemoryEntriesManager 的数据源）→ batchReviewMemoryEntries
// approve → 轻文件 frontmatter 转正 active → rebuildLightMemoryIndex 进 active INDEX。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { MemoryRecord } from '../../../src/host/services/core/repositories';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import type { DurableFact } from '../../../src/host/lightMemory/conversationJudge';
import { writeDurableFacts } from '../../../src/host/lightMemory/durableFactWriter';
import { listUnifiedMemoryEntries } from '../../../src/host/memory/memoryEntryRuntime';
import { batchReviewMemoryEntries } from '../../../src/host/memory/memoryEntryReview';
import type { MemoryEntryDatabase } from '../../../src/host/memory/memoryEntryRuntime';

function fact(overrides: Partial<DurableFact> = {}): DurableFact {
  return {
    filename: 'user-city.md',
    name: '用户城市',
    description: '用户长期居住的城市',
    type: 'user',
    content: '用户长期居住在上海。',
    confidence: 0.65,
    ...overrides,
  };
}

function record(overrides: Partial<MemoryRecord>): MemoryRecord {
  return {
    id: 'mem-mirror',
    type: 'user_preference',
    category: 'user_profile',
    content: 'mirror',
    summary: 'mirror',
    source: 'user_defined',
    projectPath: undefined,
    sessionId: undefined,
    confidence: 1,
    metadata: {},
    accessCount: 0,
    createdAt: 1778664000000,
    updatedAt: 1778664000000,
    ...overrides,
  };
}

function fakeDb(): MemoryEntryDatabase {
  const created: MemoryRecord[] = [];
  return {
    listMemories: vi.fn(() => created as MemoryRecord[]),
    createMemory: vi.fn((data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>) => {
      const next = record({
        id: `mem-created-${created.length + 1}`,
        ...data,
        accessCount: 0,
        createdAt: 1778666100000,
        updatedAt: 1778666100000,
      });
      created.push(next);
      return next;
    }),
    updateMemory: vi.fn((id: string, updates: Partial<MemoryRecord>) => {
      const existing = created.find((item) => item.id === id);
      if (existing) Object.assign(existing, updates);
      return existing ?? record({ id, ...updates });
    }),
  } as unknown as MemoryEntryDatabase;
}

async function readFrontmatter(memoryDir: string, filename: string): Promise<Record<string, string>> {
  const raw = await fs.readFile(path.join(memoryDir, filename), 'utf-8');
  const match = raw.match(/^---\n([\s\S]*?)\n---/);
  expect(match).toBeTruthy();
  const meta: Record<string, string> = {};
  for (const line of (match as RegExpMatchArray)[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return meta;
}

describe('durable fact candidate → 人工复核闭环', () => {
  let tmpDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-fact-review-'));
    mockConfigDir.dir = tmpDir;
    memoryDir = path.join(tmpDir, 'memory');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('中置信度 candidate 出现在复核页数据源（listUnifiedMemoryEntries），approve 后转正 active 并进 INDEX', async () => {
    const writeResult = await writeDurableFacts([fact()]);
    expect(writeResult).toMatchObject({ candidate: 1, active: 0 });
    expect(await readFrontmatter(memoryDir, 'user-city.md')).toMatchObject({ status: 'candidate' });

    // 设置页 MemoryEntriesManager 的数据源就是 listUnifiedMemoryEntries（memory.ipc.ts handleListMemoryEntries）。
    const listed = await listUnifiedMemoryEntries();
    const entry = listed.entries.find((item) => item.source.filePath === 'user-city.md');
    expect(entry).toBeDefined();
    expect(entry?.status).toBe('candidate');
    expect(entry?.id).toBe('light:user-city.md');

    // candidate 不进 active INDEX：确认未被注入
    const indexBefore = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    expect(indexBefore).not.toContain('[user-city.md]');

    const review = await batchReviewMemoryEntries(fakeDb(), {
      entryIds: [entry!.id],
      decision: 'approve',
    });
    expect(review.updated).toHaveLength(1);
    expect(review.updated[0].status).toBe('active');
    expect(review.skipped).toEqual([]);

    // 读回文件 frontmatter：candidate 已转正
    expect(await readFrontmatter(memoryDir, 'user-city.md')).toMatchObject({ status: 'active' });

    // 转正后 rebuild 索引进入 active INDEX（updateMemoryEntry 内部已触发 rebuild）
    const indexAfter = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    expect(indexAfter).toContain('[user-city.md]');
  });

  it('candidate 新条目复核转正后，supersedes 等待的旧条目仍未被归档（归档只在写入 active 时发生）', async () => {
    await writeDurableFacts([fact({ filename: 'user-location.md', confidence: 0.9, content: '用户住在城里。' })]);
    await writeDurableFacts([fact({ confidence: 0.65, supersedes: 'user-location.md' })]);

    // 复核页把 candidate 转正
    const listed = await listUnifiedMemoryEntries();
    const candidateEntry = listed.entries.find((item) => item.source.filePath === 'user-city.md');
    expect(candidateEntry?.status).toBe('candidate');
    const review = await batchReviewMemoryEntries(fakeDb(), {
      entryIds: [candidateEntry!.id],
      decision: 'approve',
    });
    expect(review.updated[0].status).toBe('active');

    // 旧条目保持 active：candidate 写入时不归档，转正也不追溯归档（留给 consolidation/人工）
    expect(await readFrontmatter(memoryDir, 'user-location.md')).toMatchObject({ status: 'active' });
  });
});
