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
import {
  rebuildLightMemoryIndex,
  writeLightMemoryFile,
} from '../../../src/host/lightMemory/lightMemoryIpc';
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

  it('r4：candidate 复核转正后不再归档被链接的旧条目（supersedes 只记录，approve 不消费）', async () => {
    await writeDurableFacts([fact({ filename: 'user-location.md', confidence: 0.9, content: '用户住在城里。' })]);
    const result = await writeDurableFacts([fact({ confidence: 0.65, supersedes: 'user-location.md' })]);
    expect(result.files).toEqual(['user-city.md']);

    // candidate 阶段：旧条目保持生效，链接只记在新条目 frontmatter 上
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

    // r4 scope cut：转正不归档旧条目——两条都 active、都在 INDEX，是否替换由后续工单/用户决定
    expect(await readFrontmatter(memoryDir, 'user-location.md')).toMatchObject({ status: 'active' });
    const index = await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
    expect(index).toContain('[user-city.md]');
    expect(index).toContain('[user-location.md]');
  });
});

// ============================================================================
// N-MEM-WRITECONF r2→r4：中置信度改写同名条目时，candidate 绝不原地覆盖——
// writeLightMemoryFile 按 filename 原子覆盖，直接写会把已确认记忆降级出 INDEX，
// 复核驳回后原事实彻底丢失。r4 收口：同名分流只看文件存在性（任意 status 或
// 没有 status 行的存量文件都算），candidate 改落派生文件名并记录取代链接
// （deprecated_by，本单不消费）；驳回/转正都不动旧条目。
// ============================================================================

describe('durable fact candidate 同名条目防覆盖', () => {
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

  /**
   * 按 r4 复审点名的三种形状种一条同名 user-city.md，返回种子文件的原始字节：
   * - legacy：手工写盘、frontmatter 无 status 行——本 PR 之前 writeDurableFacts 不写
   *   status，存量记忆都是这个形状，INDEX 与 lightMemoryFileToEntry 都按缺省 active 处理；
   * - active / candidate：writeLightMemoryFile 显式写 status。
   */
  async function seedSameNameFile(mode: 'legacy' | 'active' | 'candidate'): Promise<string> {
    if (mode === 'legacy') {
      await fs.mkdir(memoryDir, { recursive: true });
      await fs.writeFile(path.join(memoryDir, 'user-city.md'), [
        '---',
        'name: 用户城市',
        'description: 用户长期居住的城市',
        'type: user',
        '---',
        '',
        '用户长期居住在上海。',
        '',
      ].join('\n'), 'utf-8');
    } else {
      await writeLightMemoryFile({
        filename: 'user-city.md',
        name: '用户城市',
        description: '用户长期居住的城市',
        type: 'user',
        content: '用户长期居住在上海。',
        status: mode,
      });
    }
    await rebuildLightMemoryIndex();
    return fs.readFile(path.join(memoryDir, 'user-city.md'), 'utf-8');
  }

  async function readIndex(): Promise<string> {
    return fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8');
  }

  it.each(['legacy', 'active', 'candidate'] as const)(
    'r4：同名文件无论 status 形状（%s），candidate 一律落派生文件名、原文件逐字节不变',
    async (mode) => {
      const rawBefore = await seedSameNameFile(mode);
      // legacy 无 status 行与显式 active 都按缺省 active 收进 INDEX；candidate 不进
      const indexBefore = await readIndex();
      if (mode === 'candidate') expect(indexBefore).not.toContain('[user-city.md]');
      else expect(indexBefore).toContain('[user-city.md]');

      const result = await writeDurableFacts([
        fact({ confidence: 0.65, content: '用户长期居住在北京。' }),
      ]);

      expect(result).toMatchObject({ candidate: 1, active: 0 });
      const candidateFile = result.files[0];
      expect(candidateFile).toMatch(/^user-city\.candidate-[0-9a-f]{8}\.md$/);
      expect(candidateFile).not.toBe('user-city.md');

      // 原文件逐字节不变（不看 status 的纯存在性分流，存量无 status 文件同样受保护）
      expect(await fs.readFile(path.join(memoryDir, 'user-city.md'), 'utf-8')).toBe(rawBefore);

      // candidate 是独立文件：status=candidate、取代链接指向原文件、不进 INDEX
      expect(await readFrontmatter(memoryDir, candidateFile)).toMatchObject({
        status: 'candidate',
        deprecated_by: 'user-city.md',
      });
      const indexAfter = await readIndex();
      if (mode === 'candidate') expect(indexAfter).not.toContain('[user-city.md]');
      else expect(indexAfter).toContain('[user-city.md]');
      expect(indexAfter).not.toMatch(/\[user-city\.candidate-/);
    },
  );

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

    // candidate 是独立文件，带取代链接（只记录，r4 不消费），出现在复核页数据源
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

  it('r4：转正 candidate：新条目进 INDEX，旧条目保持 active 也在 INDEX（不再自动归档）', async () => {
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

    // 新条目转正进 INDEX；旧条目不动（r4 scope cut：approve 不消费取代链接）
    expect(await readFrontmatter(memoryDir, candidateFile)).toMatchObject({ status: 'active' });
    expect(await readFrontmatter(memoryDir, 'user-city.md')).toMatchObject({ status: 'active' });
    const index = await readIndex();
    expect(index).toContain(`[${candidateFile}]`);
    expect(index).toContain('[user-city.md]');
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

// ============================================================================
// N-MEM-WRITECONF r3→r4：directive 经交互确认门建立、只能由用户移除。r4 收口后
// 本 PR 没有任何「判断器输出 → 归档旧条目」的路径：candidate 撞上同名 directive
// 仍改落派生文件名（纯存在性分流，链接只是记录），复核 approve 也不消费链接——
// directive 在任何阶段都保持 active、逐字节不变。
// ============================================================================

describe('durable fact candidate 不得顶替 directive', () => {
  let tmpDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-fact-directive-'));
    mockConfigDir.dir = tmpDir;
    memoryDir = path.join(tmpDir, 'memory');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** 按交互确认门的产物形状种一条 directive（生产路径只有那里能传确认旗标）。 */
  async function seedDirective(filename: string): Promise<string> {
    await writeLightMemoryFile({
      filename,
      name: '操作指令',
      description: '经用户交互确认的操作指令',
      type: 'directive',
      content: '涉及城市的问题必须先向用户确认再执行。',
      status: 'active',
      directiveConfirmedByUser: true,
    });
    await rebuildLightMemoryIndex();
    const raw = await fs.readFile(path.join(memoryDir, filename), 'utf-8');
    expect(await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8')).toContain(`[${filename}]`);
    return raw;
  }

  it('candidate 撞上同名 directive：落派生文件名，approve 转正后 directive 仍逐字节原样', async () => {
    const rawBefore = await seedDirective('user-city.md');

    const result = await writeDurableFacts([fact({ confidence: 0.65, content: '用户长期居住在北京。' })]);

    const candidateFile = result.files[0];
    expect(candidateFile).toMatch(/^user-city\.candidate-[0-9a-f]{8}\.md$/);
    const candidateMeta = await readFrontmatter(memoryDir, candidateFile);
    expect(candidateMeta.status).toBe('candidate');
    // r4：链接只做记录（指向同名 directive 文件），没有任何路径消费它
    expect(candidateMeta.deprecated_by).toBe('user-city.md');

    // directive 逐字节不变、仍在 INDEX
    expect(await fs.readFile(path.join(memoryDir, 'user-city.md'), 'utf-8')).toBe(rawBefore);
    expect(await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8')).toContain('[user-city.md]');

    // 复核页 approve 转正 candidate：directive 也不因此被动
    const listed = await listUnifiedMemoryEntries();
    const candidateEntry = listed.entries.find((item) => item.source.filePath === candidateFile);
    expect(candidateEntry?.status).toBe('candidate');
    const review = await batchReviewMemoryEntries(fakeDb(), {
      entryIds: [candidateEntry!.id],
      decision: 'approve',
    });
    expect(review.updated[0].status).toBe('active');
    expect(await fs.readFile(path.join(memoryDir, 'user-city.md'), 'utf-8')).toBe(rawBefore);
    expect(await readFrontmatter(memoryDir, 'user-city.md')).toMatchObject({
      status: 'active',
      type: 'directive',
    });
    expect(await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8')).toContain('[user-city.md]');
  });

  it('candidate 的 supersedes 指向 directive：只记录链接，转正后 directive 仍不被归档', async () => {
    const rawBefore = await seedDirective('confirm-city-first.md');

    const result = await writeDurableFacts([
      fact({
        filename: 'city-feedback.md',
        type: 'feedback',
        confidence: 0.65,
        supersedes: 'confirm-city-first.md',
        content: '用户暗示城市问题可以直接执行。',
      }),
    ]);

    expect(result.files).toEqual(['city-feedback.md']);
    const candidateMeta = await readFrontmatter(memoryDir, 'city-feedback.md');
    expect(candidateMeta.status).toBe('candidate');
    expect(candidateMeta.deprecated_by).toBe('confirm-city-first.md');

    const listed = await listUnifiedMemoryEntries();
    const candidateEntry = listed.entries.find((item) => item.source.filePath === 'city-feedback.md');
    const review = await batchReviewMemoryEntries(fakeDb(), {
      entryIds: [candidateEntry!.id],
      decision: 'approve',
    });
    expect(review.updated[0].status).toBe('active');

    // directive 保持 active、逐字节不变、仍在 INDEX
    expect(await fs.readFile(path.join(memoryDir, 'confirm-city-first.md'), 'utf-8')).toBe(rawBefore);
    expect(await readFrontmatter(memoryDir, 'confirm-city-first.md')).toMatchObject({
      status: 'active',
      type: 'directive',
    });
    expect(await fs.readFile(path.join(memoryDir, 'INDEX.md'), 'utf-8')).toContain('[confirm-city-first.md]');
  });
});
