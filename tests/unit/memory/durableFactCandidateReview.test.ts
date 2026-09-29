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
import { SESSION_JUDGE } from '../../../src/shared/constants';

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

  it('candidate 新条目复核转正后，supersedes 等待的旧条目才被软归档（deprecated_by 指向新条目）', async () => {
    await writeDurableFacts([fact({ filename: 'user-location.md', confidence: 0.9, content: '用户住在城里。' })]);
    const result = await writeDurableFacts([fact({ confidence: 0.65, supersedes: 'user-location.md' })]);
    expect(result.files).toEqual(['user-city.md']);

    // 转正前旧条目保持生效（candidate 阶段只登记待替换链接）
    expect(await readFrontmatter(memoryDir, 'user-location.md')).toMatchObject({ status: 'active' });
    expect(await readFrontmatter(memoryDir, 'user-city.md')).toMatchObject({
      status: 'candidate',
      deprecated_by: 'user-location.md',
    });

    // 复核页把 candidate 转正
    const listed = await listUnifiedMemoryEntries();
    const candidateEntry = listed.entries.find((item) => item.source.filePath === 'user-city.md');
    expect(candidateEntry?.status).toBe('candidate');
    const review = await batchReviewMemoryEntries(fakeDb(), {
      entryIds: [candidateEntry!.id],
      decision: 'approve',
    });
    expect(review.updated[0].status).toBe('active');

    // 转正消费待替换链接：旧条目软归档并指向新条目
    expect(await readFrontmatter(memoryDir, 'user-location.md')).toMatchObject({
      status: 'archived',
      deprecated_by: 'user-city.md',
    });
  });
});

// ============================================================================
// N-MEM-WRITECONF r2：中置信度改写同名 active 条目时，candidate 绝不原地覆盖——
// writeLightMemoryFile 按 filename 原子覆盖，直接写会把已确认记忆降级出 INDEX，
// 复核驳回后原事实彻底丢失。candidate 改落派生文件名并登记待替换链接（deprecated_by），
// 驳回 → 旧条目原封不动；转正 → 旧条目软归档完成替换。
// ============================================================================

describe('durable fact candidate 同名 active 条目防覆盖', () => {
  let tmpDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-fact-collision-'));
    mockConfigDir.dir = tmpDir;
    memoryDir = path.join(tmpDir, 'memory');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function seedActiveCity(): Promise<void> {
    const result = await writeDurableFacts([
      fact({ confidence: 0.9, content: '用户长期居住在上海。' }),
    ]);
    expect(result).toMatchObject({ active: 1 });
  }

  async function readIndex(): Promise<string> {
    return fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
  }

  it.each([
    ['显式中置信度', 0.65],
    ['模型漏给 confidence 的保守缺省', SESSION_JUDGE.DURABLE_FACT_CONFIDENCE_MISSING_DEFAULT],
  ])('中置信度改写同名 active 条目（%s）：旧条目原封不动，candidate 落派生文件名', async (_label, confidence) => {
    // 缺省值必须真落在 candidate 区间，这条参数化才有意义
    expect(confidence).toBeGreaterThanOrEqual(SESSION_JUDGE.DURABLE_FACT_CONFIDENCE_DROP_BELOW);
    expect(confidence).toBeLessThan(SESSION_JUDGE.DURABLE_FACT_CONFIDENCE_ACTIVE_MIN);

    await seedActiveCity();
    const result = await writeDurableFacts([
      fact({ confidence, content: '用户长期居住在北京。' }),
    ]);

    expect(result).toMatchObject({ candidate: 1, active: 0 });
    expect(result.files).toHaveLength(1);
    const candidateFile = result.files[0];
    expect(candidateFile).toMatch(/^user-city\.candidate-[0-9a-f]{8}\.md$/);
    expect(candidateFile).not.toBe('user-city.md');

    // 旧 active 文件原封不动：仍是 active、内容未被覆盖、仍在 INDEX
    const old = await readFrontmatter(memoryDir, 'user-city.md');
    expect(old.status).toBe('active');
    const oldRaw = await fs.readFile(path.join(memoryDir, 'user-city.md'), 'utf-8');
    expect(oldRaw).toContain('用户长期居住在上海。');
    expect(oldRaw).not.toContain('北京');
    const index = await readIndex();
    expect(index).toContain('[user-city.md]');
    expect(index).not.toMatch(/\[user-city\.candidate-/);

    // candidate 是独立文件，带待替换链接，出现在复核页数据源
    expect(await readFrontmatter(memoryDir, candidateFile)).toMatchObject({
      status: 'candidate',
      deprecated_by: 'user-city.md',
    });
    const listed = await listUnifiedMemoryEntries();
    const candidateEntry = listed.entries.find((item) => item.source.filePath === candidateFile);
    expect(candidateEntry?.status).toBe('candidate');
    expect(candidateEntry?.deprecatedBy).toBe('user-city.md');
  });

  it('驳回 candidate：旧条目保持 active、内容与 INDEX 完全不变', async () => {
    await seedActiveCity();
    const indexBefore = await readIndex();
    const result = await writeDurableFacts([
      fact({ confidence: 0.65, content: '用户长期居住在北京。' }),
    ]);
    const candidateFile = result.files[0];

    const listed = await listUnifiedMemoryEntries();
    const candidateEntry = listed.entries.find((item) => item.source.filePath === candidateFile);
    const review = await batchReviewMemoryEntries(fakeDb(), {
      entryIds: [candidateEntry!.id],
      decision: 'reject',
    });
    expect(review.updated[0].status).toBe('rejected');

    // 驳回后旧条目原封不动——已确认事实不因一次低把握改写丢失
    expect(await readFrontmatter(memoryDir, 'user-city.md')).toMatchObject({ status: 'active' });
    const oldRaw = await fs.readFile(path.join(memoryDir, 'user-city.md'), 'utf-8');
    expect(oldRaw).toContain('用户长期居住在上海。');
    expect(await readIndex()).toBe(indexBefore);
  });

  it('转正 candidate：新条目进 INDEX，旧条目按 supersedes 软归档（deprecated_by 指向新条目）', async () => {
    await seedActiveCity();
    const result = await writeDurableFacts([
      fact({ confidence: 0.65, content: '用户长期居住在北京。' }),
    ]);
    const candidateFile = result.files[0];

    const listed = await listUnifiedMemoryEntries();
    const candidateEntry = listed.entries.find((item) => item.source.filePath === candidateFile);
    const review = await batchReviewMemoryEntries(fakeDb(), {
      entryIds: [candidateEntry!.id],
      decision: 'approve',
    });
    expect(review.updated[0].status).toBe('active');

    // 新条目转正进 INDEX；旧条目软归档退 INDEX，deprecated_by 指向顶替者
    expect(await readFrontmatter(memoryDir, candidateFile)).toMatchObject({ status: 'active' });
    const old = await readFrontmatter(memoryDir, 'user-city.md');
    expect(old.status).toBe('archived');
    expect(old.deprecated_by).toBe(candidateFile);
    const index = await readIndex();
    expect(index).toContain(`[${candidateFile}]`);
    expect(index).not.toContain('[user-city.md]');
  });

  it('高置信度改写同名 active 条目：保持既有行为原地覆盖（仍 active）', async () => {
    await seedActiveCity();
    const result = await writeDurableFacts([
      fact({ confidence: 0.9, content: '用户长期居住在北京。' }),
    ]);

    expect(result).toMatchObject({ active: 1, candidate: 0 });
    expect(result.files).toEqual(['user-city.md']);
    const meta = await readFrontmatter(memoryDir, 'user-city.md');
    expect(meta.status).toBe('active');
    const raw = await fs.readFile(path.join(memoryDir, 'user-city.md'), 'utf-8');
    expect(raw).toContain('用户长期居住在北京。');
    expect(await readIndex()).toContain('[user-city.md]');
  });

  it('同一事实同样措辞重复改写落到同一派生文件名，不随会话堆积 candidate 文件', async () => {
    await seedActiveCity();
    const first = await writeDurableFacts([fact({ confidence: 0.65, content: '用户长期居住在北京。' })]);
    const second = await writeDurableFacts([fact({ confidence: 0.65, content: '用户长期居住在北京。' })]);

    expect(second.files).toEqual(first.files);
    const files = (await fs.readdir(memoryDir)).filter((name) => name.startsWith('user-city.'));
    expect(files.sort()).toEqual([first.files[0], 'user-city.md'].sort());
  });
});
