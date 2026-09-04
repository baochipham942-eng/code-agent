// N-EVAL-MEMORY：记忆评测的判定与隔离单测。
// 隔离两向（记忆目录跟 CODE_AGENT_DATA_DIR 走 / 关记忆时写入侧不被调用）在
// memoryIsolation.test.ts；本文件只测 memoryEval 模块自己的判定与 seed 落盘。
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { getMemoryDir } from '../../../src/host/lightMemory/indexLoader';
import {
  evaluateMemoryRecalledExpectation,
  evaluateMemoryWrittenExpectation,
  seedCaseMemory,
  snapshotMemoryDir,
  validateCaseMemory,
} from '../../../src/host/testing/memoryEval';
import type { MemoryFileSnapshot, TestCase } from '../../../src/host/testing/types';

function caseWith(memory: TestCase['memory']): TestCase {
  return {
    id: 'memory-case', type: 'task', description: 'd', prompt: 'p',
    expect: {} as TestCase['expect'],
    ...(memory ? { memory } : {}),
  };
}

describe('validateCaseMemory', () => {
  it('未声明 memory 的 case 不受影响', () => {
    expect(validateCaseMemory(caseWith(undefined))).toBeNull();
  });

  it('合法声明通过', () => {
    expect(validateCaseMemory(caseWith({
      enabled: true,
      seed: { files: [{ name: 'mem-a.md', content: '事实一' }] },
    }))).toBeNull();
  });

  it('enabled 不是 true 时报人话', () => {
    const message = validateCaseMemory(caseWith({ enabled: false as unknown as true }));
    expect(message).toContain('memory.enabled');
  });

  it('拒绝带路径的 seed 文件名', () => {
    const message = validateCaseMemory(caseWith({
      enabled: true,
      seed: { files: [{ name: '../escape.md', content: 'x' }] },
    }));
    expect(message).toContain('不合法');
  });

  it('拒绝非 .md 的 seed 文件名', () => {
    const message = validateCaseMemory(caseWith({
      enabled: true,
      seed: { files: [{ name: 'mem-a.txt', content: 'x' }] },
    }));
    expect(message).toContain('不合法');
  });

  it('拒绝空 seed 列表与重名文件', () => {
    expect(validateCaseMemory(caseWith({ enabled: true, seed: { files: [] } }))).toContain('非空数组');
    expect(validateCaseMemory(caseWith({
      enabled: true,
      seed: { files: [{ name: 'mem-a.md', content: 'x' }, { name: 'mem-a.md', content: 'y' }] },
    }))).toContain('出现了两次');
  });
});

describe('seedCaseMemory', () => {
  let dataDir: string;
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-eval-seed-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('seed 落进本题记忆目录并进了索引（模型看得见）', async () => {
    const written = await seedCaseMemory({
      enabled: true,
      seed: { files: [{ name: 'mem-orchid.md', content: '内部项目 Orchid 的主视觉色是 #2F6D4F。' }] },
    });

    expect(written).toEqual(['mem-orchid.md']);
    expect(getMemoryDir()).toBe(path.join(dataDir, 'memory'));
    const body = await fs.readFile(path.join(dataDir, 'memory', 'mem-orchid.md'), 'utf-8');
    expect(body).toContain('#2F6D4F');
    const index = await fs.readFile(path.join(dataDir, 'memory', 'INDEX.md'), 'utf-8');
    expect(index).toContain('mem-orchid.md');
  });

  it('没有隔离数据目录时拒绝落盘（否则写的是用户真实记忆库）', async () => {
    delete process.env.CODE_AGENT_DATA_DIR;
    await expect(seedCaseMemory({
      enabled: true,
      seed: { files: [{ name: 'mem-orchid.md', content: 'x' }] },
    })).rejects.toThrow(/CODE_AGENT_DATA_DIR/);
  });

  it('没有 seed 的记忆题同样受隔离闸约束（写入侧也会往目录写）', async () => {
    delete process.env.CODE_AGENT_DATA_DIR;
    await expect(seedCaseMemory({ enabled: true })).rejects.toThrow(/CODE_AGENT_DATA_DIR/);
  });

  it('seed 自带 frontmatter 时 fail-loud，不静默双重包裹', async () => {
    await expect(seedCaseMemory({
      enabled: true,
      seed: { files: [{ name: 'mem-a.md', content: '---\nname: a\n---\n正文' }] },
    })).rejects.toThrow(/frontmatter/);
  });

  it('snapshotMemoryDir 读出刚落盘的正文', async () => {
    await seedCaseMemory({
      enabled: true,
      seed: { files: [{ name: 'mem-a.md', content: '事实一' }] },
    });
    const snapshot = await snapshotMemoryDir();
    expect(snapshot.map((file) => file.name)).toContain('mem-a.md');
    expect(snapshot.find((file) => file.name === 'mem-a.md')?.content).toContain('事实一');
  });
});

describe('memory_recalled', () => {
  const record = { injections: 2, entries: ['mem-orchid-brand-color.md', 'mem-halberd.md'] };

  it('真阳：声明的条目被注入了', () => {
    const result = evaluateMemoryRecalledExpectation({ entries: ['mem-orchid-brand-color'] }, record);
    expect(result.passed).toBe(true);
    expect(result.details).toContain('记忆注入 2 次');
  });

  it('真阴：声明的条目没被注入', () => {
    const result = evaluateMemoryRecalledExpectation({ entries: ['mem-quartz-budget'] }, record);
    expect(result.passed).toBe(false);
  });

  it("mode=all 要求每条判据都命中", () => {
    expect(evaluateMemoryRecalledExpectation(
      { entries: ['mem-orchid', 'mem-halberd'], mode: 'all' }, record,
    ).passed).toBe(true);
    expect(evaluateMemoryRecalledExpectation(
      { entries: ['mem-orchid', 'mem-missing'], mode: 'all' }, record,
    ).passed).toBe(false);
  });

  it('negate：不该被注入的确实没注入 = 过；注入了 = 红', () => {
    expect(evaluateMemoryRecalledExpectation(
      { entries: ['quartz', '预算'], negate: true }, record,
    ).passed).toBe(true);
    expect(evaluateMemoryRecalledExpectation(
      { entries: ['mem-orchid'], negate: true }, record,
    ).passed).toBe(false);
  });

  it('缺记录来源时 fail-loud，不静默算过（negate 也不许）', () => {
    const positive = evaluateMemoryRecalledExpectation({ entries: ['mem-orchid'] }, undefined);
    expect(positive.passed).toBe(false);
    expect(positive.details).toContain('没有证据源');
    expect(evaluateMemoryRecalledExpectation(
      { entries: ['mem-orchid'], negate: true }, undefined,
    ).passed).toBe(false);
  });

  it('注入了但一条 entries 都没报出来 = 有注入无证据，仍判红', () => {
    const result = evaluateMemoryRecalledExpectation(
      { entries: ['mem-orchid'] }, { injections: 3, entries: [] },
    );
    expect(result.passed).toBe(false);
    expect(result.actual).toBe('no memory entries injected');
  });

  it('非法参数 fail-loud', () => {
    expect(evaluateMemoryRecalledExpectation({}, record).passed).toBe(false);
    expect(evaluateMemoryRecalledExpectation({ entries: ['('] }, record).actual)
      .toContain('invalid regex');
    expect(evaluateMemoryRecalledExpectation({ entries: ['a'], mode: 'every' }, record).actual)
      .toContain("mode must be");
    expect(evaluateMemoryRecalledExpectation({ entries: ['a'], negate: 'yes' }, record).actual)
      .toContain('negate must be a boolean');
  });
});

describe('memory_written', () => {
  const snapshot: MemoryFileSnapshot[] = [
    { name: 'mem-beacon.md', content: '内部项目 Beacon 的周会在每周二上午十点。' },
    { name: 'mem-other.md', content: '内部服务 Cobalt 当前地址是 v3.cobalt.invalid。' },
  ];

  it('contains 真阳 / 真阴', () => {
    expect(evaluateMemoryWrittenExpectation({ contains: ['Beacon'] }, snapshot).passed).toBe(true);
    const miss = evaluateMemoryWrittenExpectation({ contains: ['Sierra'] }, snapshot);
    expect(miss.passed).toBe(false);
    expect(String(miss.actual)).toContain('contains 未命中');
  });

  it('not_contains 真阳 / 真阴', () => {
    expect(evaluateMemoryWrittenExpectation({ not_contains: ['sk-testonly'] }, snapshot).passed).toBe(true);
    const hit = evaluateMemoryWrittenExpectation({ not_contains: ['Cobalt'] }, snapshot);
    expect(hit.passed).toBe(false);
    expect(String(hit.actual)).toContain('not_contains 被命中');
  });

  it('no_duplicates 真阳 / 真阴（同一事实跨文件落两份）', () => {
    expect(evaluateMemoryWrittenExpectation({ no_duplicates: true }, snapshot).passed).toBe(true);
    const duplicated = evaluateMemoryWrittenExpectation({ no_duplicates: true }, [
      ...snapshot,
      { name: 'mem-beacon-copy.md', content: '- 内部项目 Beacon 的周会在每周二上午十点' },
    ]);
    expect(duplicated.passed).toBe(false);
    expect(String(duplicated.actual)).toContain('重复落盘');
  });

  it('no_sensitive 真阳 / 真阴', () => {
    expect(evaluateMemoryWrittenExpectation({ no_sensitive: true }, snapshot).passed).toBe(true);
    const leaked = evaluateMemoryWrittenExpectation({ no_sensitive: true }, [
      { name: 'mem-leak.md', content: 'Sierra 的访问密钥是 sk-testonly-4a7f2c9e1b6d8035，别弄丢。' },
    ]);
    expect(leaked.passed).toBe(false);
    expect(String(leaked.actual)).toContain('未脱敏');
  });

  it('缺快照时 fail-loud（空目录与没人给快照必须分开）', () => {
    const noSource = evaluateMemoryWrittenExpectation({ contains: ['Beacon'] }, undefined);
    expect(noSource.passed).toBe(false);
    expect(noSource.details).toContain('没有证据源');
    // 空目录是有证据的「什么都没写」，判定照常执行
    expect(evaluateMemoryWrittenExpectation({ contains: ['Beacon'] }, []).details)
      .toContain('目录为空');
  });

  it('非法参数 fail-loud', () => {
    expect(evaluateMemoryWrittenExpectation({}, snapshot).actual).toContain('at least one of');
    expect(evaluateMemoryWrittenExpectation({ contains: [] }, snapshot).actual)
      .toContain('non-empty string array');
    expect(evaluateMemoryWrittenExpectation({ no_sensitive: 'yes' }, snapshot).actual)
      .toContain('no_sensitive must be a boolean');
  });
});
