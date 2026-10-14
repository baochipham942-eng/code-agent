// ============================================================================
// N-DELIVERABLE-WORKDIR-DEFAULT / N-DELIVERABLE-WORKDIR-LAZY：无文件夹新会话的
// 按会话产出目录。验收：目录路径落在 getDefaultWorkDirectory() 之下（任务_/Task_
// 前缀、MMDD、标题清洗、撞名 -2、无标题回退）；懒开——plan 只算路径不落盘，
// materialize 幂等补 mkdir；重规划——智能标题就位且目录未落盘时按标题改名，
// 已落盘/标题不可用/路径不是规划形状时不改。全程临时 HOME/数据目录，不碰真实主目录。
// ============================================================================
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => ({ ui: { language: mockUiLanguage } }),
  }),
}));

// let 而非 vi.hoisted：读取发生在函数调用时，不在模块加载时
let mockUiLanguage = 'zh';

import {
  materializeSessionWorkDirectory,
  maybeReplanSessionWorkDirectory,
  planSessionWorkDirectory,
} from '../../../../src/host/config/sessionWorkDirectory';
import { getDefaultWorkDirectory } from '../../../../src/host/config/configPaths';

describe('planSessionWorkDirectory (lazy planning)', () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;
  let root: string;
  // 2026-10-11 20:30 本地时间 → MMDD=1011
  const fixedNow = new Date(2026, 9, 11, 20, 30).getTime();

  beforeEach(async () => {
    mockUiLanguage = 'zh';
    tempHome = await mkdtemp(path.join(tmpdir(), 'session-work-dir-'));
    env = { CODE_AGENT_HOME: tempHome, CODE_AGENT_DATA_DIR: path.join(tempHome, '.code-agent') };
    root = getDefaultWorkDirectory(env);
    expect(root).toBe(path.join(tempHome, 'Neo'));
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it('plans 任务_MMDD_<title> under the flat default work directory without touching disk (zh UI)', async () => {
    const dir = await planSessionWorkDirectory({
      sessionTitle: '年度报告排版',
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(dir).toBe(path.join(root, '任务_1011_年度报告排版'));
    // 懒开：纯规划不建任何目录——连默认根都不出现
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the Task_ prefix when the UI language is en', async () => {
    const dir = await planSessionWorkDirectory({
      sessionTitle: 'annual report',
      now: fixedNow,
      language: 'en',
      env,
    });
    expect(dir).toBe(path.join(root, 'Task_1011_annual report'));
  });

  it('derives the language from ui.language when not passed explicitly', async () => {
    mockUiLanguage = 'en';
    const dir = await planSessionWorkDirectory({
      sessionTitle: 'annual report',
      now: fixedNow,
      env,
    });
    expect(path.basename(dir)).toBe('Task_1011_annual report');
  });

  it('derives the language from ui.language with zh as the fallback', async () => {
    mockUiLanguage = 'zh';
    const dir = await planSessionWorkDirectory({
      sessionTitle: '年度报告排版',
      now: fixedNow,
      env,
    });
    expect(path.basename(dir)).toBe('任务_1011_年度报告排版');
  });

  it('sanitizes illegal characters, control chars, leading dots and collapses whitespace', async () => {
    const dir = await planSessionWorkDirectory({
      sessionTitle: '  ..a/b\\c:d*e?f"g<h>i|j\u0007k\u007f  双  空白  ',
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(path.basename(dir)).toBe('任务_1011_abcdefghijk 双 空白');
  });

  it('caps the folder title at 40 characters', async () => {
    const dir = await planSessionWorkDirectory({
      sessionTitle: '零'.repeat(60),
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(path.basename(dir)).toBe(`任务_1011_${'零'.repeat(40)}`);
  });

  it('falls back to the first clause of the user message, not a mid-sentence cut', async () => {
    // 句子在 20 字符之后才出现逗号：旧口径会拦腰截到「…并输出一份」，新口径到分句符为止
    const dir = await planSessionWorkDirectory({
      sessionTitle: '新对话',
      userMessage: '帮我整理这份超长的用户需求文档，并输出一份可执行的摘要清单',
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(path.basename(dir)).toBe('任务_1011_帮我整理这份超长的用户需求文档');
  });

  it('cuts the fallback at the first of the full delimiter set (。！？.!?；;，, newline)', async () => {
    for (const [delimiter, expected] of [
      ['。', '帮我出一份季度总结'],
      ['！', '帮我把笔记变成 Word'],
      ['?', 'translate this'],
      [';', 'setup the env'],
      [',', 'quarterly summary'],
      ['\n', '第一行当目录名'],
    ] as const) {
      const dir = await planSessionWorkDirectory({
        userMessage: `${expected}${delimiter}后面这一截不许进目录名`,
        now: fixedNow,
        language: 'zh',
        env,
      });
      expect(path.basename(dir)).toBe(`任务_1011_${expected}`);
    }
  });

  it('uses untitled when neither title nor user message is usable', async () => {
    const dir = await planSessionWorkDirectory({
      sessionTitle: '新对话',
      userMessage: '   /\\:*?"<>|   ',
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(path.basename(dir)).toBe('任务_1011_untitled');
    const bare = await planSessionWorkDirectory({ now: fixedNow, language: 'en', env });
    expect(path.basename(bare)).toBe('Task_1011_untitled');
  });

  it('appends -2, -3 on collision with existing entries on disk', async () => {
    await mkdir(path.join(root, '任务_1011_重名任务'), { recursive: true });
    await mkdir(path.join(root, '任务_1011_重名任务-2'), { recursive: true });
    const third = await planSessionWorkDirectory({
      sessionTitle: '重名任务',
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(path.basename(third)).toBe('任务_1011_重名任务-3');
  });

  it('never deletes or renames existing content (plan + materialize are create-only)', async () => {
    const first = await planSessionWorkDirectory({
      sessionTitle: '只增不删',
      now: fixedNow,
      language: 'zh',
      env,
    });
    await materializeSessionWorkDirectory(first);
    await writeFile(path.join(first, 'deliverable.md'), '既有产物', 'utf8');
    const second = await planSessionWorkDirectory({
      sessionTitle: '只增不删',
      now: fixedNow,
      language: 'zh',
      env,
    });
    // 撞名不覆盖：既有目录原样，新目录带后缀
    expect(second).not.toBe(first);
    expect(await readFile(path.join(first, 'deliverable.md'), 'utf8')).toBe('既有产物');
  });

  it('does not touch sibling directories under the flat default root', async () => {
    const legacy = path.join(root, '旧产物');
    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, 'old.txt'), 'old', 'utf8');
    await planSessionWorkDirectory({ sessionTitle: '新任务', now: fixedNow, language: 'zh', env });
    expect(await readFile(path.join(legacy, 'old.txt'), 'utf8')).toBe('old');
  });
});

describe('materializeSessionWorkDirectory', () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;
  let root: string;
  const fixedNow = new Date(2026, 9, 11, 20, 30).getTime();

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'session-work-dir-'));
    env = { CODE_AGENT_HOME: tempHome, CODE_AGENT_DATA_DIR: path.join(tempHome, '.code-agent') };
    root = getDefaultWorkDirectory(env);
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it('creates the planned path (and missing parents) exactly as planned', async () => {
    const dir = await planSessionWorkDirectory({ sessionTitle: '落盘', now: fixedNow, language: 'zh', env });
    await materializeSessionWorkDirectory(dir);
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect((await stat(root)).isDirectory()).toBe(true);
    // 规划名原样：落盘不改名、不加后缀
    expect(path.basename(dir)).toBe('任务_1011_落盘');
  });

  it('is idempotent: materializing twice keeps content and does not throw', async () => {
    const dir = await planSessionWorkDirectory({ sessionTitle: '幂等', now: fixedNow, language: 'zh', env });
    await materializeSessionWorkDirectory(dir);
    await writeFile(path.join(dir, 'note.md'), 'keep', 'utf8');
    await expect(materializeSessionWorkDirectory(dir)).resolves.toBeUndefined();
    expect(await readFile(path.join(dir, 'note.md'), 'utf8')).toBe('keep');
  });
});

describe('maybeReplanSessionWorkDirectory (smart-title rename before materialization)', () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;
  let root: string;
  const fixedNow = new Date(2026, 9, 11, 20, 30).getTime();

  beforeEach(async () => {
    tempHome = await mkdtemp(path.join(tmpdir(), 'session-work-dir-'));
    env = { CODE_AGENT_HOME: tempHome, CODE_AGENT_DATA_DIR: path.join(tempHome, '.code-agent') };
    root = getDefaultWorkDirectory(env);
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it('re-plans an unmaterialized planned path with the usable smart title', async () => {
    const current = await planSessionWorkDirectory({
      userMessage: '帮我出一份季度总结，要带图表',
      now: fixedNow,
      language: 'zh',
      env,
    });
    const replanned = await maybeReplanSessionWorkDirectory({
      workingDirectory: current,
      sessionTitle: '季度总结报告',
      env,
    });
    // 重规划按当天 MMDD 取日期（目录从未落盘，日期跟当下走无副作用）
    const now = new Date();
    const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    expect(replanned).toBe(path.join(root, `任务_${mmdd}_季度总结报告`));
    // 盘上零改动：重规划本身不建目录
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('returns undefined once the folder exists on disk (materialized names are final)', async () => {
    const current = await planSessionWorkDirectory({
      userMessage: '帮我出一份季度总结，要带图表',
      now: fixedNow,
      language: 'zh',
      env,
    });
    await materializeSessionWorkDirectory(current);
    await expect(maybeReplanSessionWorkDirectory({
      workingDirectory: current,
      sessionTitle: '季度总结报告',
      env,
    })).resolves.toBeUndefined();
    // 已落盘目录名不被改名
    expect(await readdir(root)).toEqual([path.basename(current)]);
  });

  it('returns undefined when the title is missing or a placeholder', async () => {
    const current = await planSessionWorkDirectory({
      userMessage: '帮我出一份季度总结，要带图表',
      now: fixedNow,
      language: 'zh',
      env,
    });
    for (const title of [undefined, '', '新对话', 'New Chat']) {
      await expect(maybeReplanSessionWorkDirectory({
        workingDirectory: current,
        sessionTitle: title,
        env,
      })).resolves.toBeUndefined();
    }
  });

  it('returns undefined when the path is not a planned per-session folder name', async () => {
    // 用户自绑的目录（哪怕恰好在默认根下且未落盘）不改写
    const bound = path.join(root, 'MyReport');
    await expect(maybeReplanSessionWorkDirectory({
      workingDirectory: bound,
      sessionTitle: '季度总结报告',
      env,
    })).resolves.toBeUndefined();
    // 默认根本身、根之外的路径也不改写
    await expect(maybeReplanSessionWorkDirectory({
      workingDirectory: root,
      sessionTitle: '季度总结报告',
      env,
    })).resolves.toBeUndefined();
    await expect(maybeReplanSessionWorkDirectory({
      workingDirectory: path.join(tempHome, 'elsewhere', '任务_1011_x'),
      sessionTitle: '季度总结报告',
      env,
    })).resolves.toBeUndefined();
  });

  it('returns undefined when re-planning yields the same path', async () => {
    // 不传 now：与 maybeReplan 内部的规划同一时刻，路径必然一致
    const current = await planSessionWorkDirectory({
      sessionTitle: '季度总结报告',
      language: 'zh',
      env,
    });
    await expect(maybeReplanSessionWorkDirectory({
      workingDirectory: current,
      sessionTitle: '季度总结报告',
      env,
    })).resolves.toBeUndefined();
  });
});
