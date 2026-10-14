// ============================================================================
// N-DELIVERABLE-WORKDIR-DEFAULT：无文件夹新会话的按会话产出目录
// 验收①：目录落在 getDefaultWorkDirectory() 之下（任务_/Task_ 前缀、MMDD、标题清洗、
// 撞名 -2、无标题回退、只创建不删除）。全程临时 HOME/数据目录，不碰真实主目录。
// ============================================================================
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
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

import { createSessionWorkDirectory } from '../../../../src/host/config/sessionWorkDirectory';
import { getDefaultWorkDirectory } from '../../../../src/host/config/configPaths';

describe('createSessionWorkDirectory', () => {
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

  it('creates 任务_MMDD_<title> under the flat default work directory (zh UI)', async () => {
    const dir = await createSessionWorkDirectory({
      sessionTitle: '年度报告排版',
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(dir).toBe(path.join(root, '任务_1011_年度报告排版'));
    expect((await stat(dir)).isDirectory()).toBe(true);
    expect((await stat(root)).isDirectory()).toBe(true);
  });

  it('uses the Task_ prefix when the UI language is en', async () => {
    const dir = await createSessionWorkDirectory({
      sessionTitle: 'annual report',
      now: fixedNow,
      language: 'en',
      env,
    });
    expect(dir).toBe(path.join(root, 'Task_1011_annual report'));
  });

  it('derives the language from ui.language when not passed explicitly', async () => {
    mockUiLanguage = 'en';
    const dir = await createSessionWorkDirectory({
      sessionTitle: 'annual report',
      now: fixedNow,
      env,
    });
    expect(path.basename(dir)).toBe('Task_1011_annual report');
  });

  it('derives the language from ui.language with zh as the fallback', async () => {
    mockUiLanguage = 'zh';
    const dir = await createSessionWorkDirectory({
      sessionTitle: '年度报告排版',
      now: fixedNow,
      env,
    });
    expect(path.basename(dir)).toBe('任务_1011_年度报告排版');
  });

  it('sanitizes illegal characters, control chars, leading dots and collapses whitespace', async () => {
    const dir = await createSessionWorkDirectory({
      sessionTitle: '  ..a/b\\c:d*e?f"g<h>i|j\u0007k\u007f  双  空白  ',
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(path.basename(dir)).toBe('任务_1011_abcdefghijk 双 空白');
  });

  it('caps the folder title at 40 characters', async () => {
    const dir = await createSessionWorkDirectory({
      sessionTitle: '零'.repeat(60),
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(path.basename(dir)).toBe(`任务_1011_${'零'.repeat(40)}`);
  });

  it('falls back to the first 20 chars of the user message when the title is a placeholder', async () => {
    const userMessage = '帮我整理这份超长的用户需求文档并输出一份可执行的摘要清单';
    for (const placeholder of ['新对话', 'New Chat', 'New Session', '']) {
      const dir = await createSessionWorkDirectory({
        sessionTitle: placeholder,
        userMessage,
        now: fixedNow,
        language: 'zh',
        env,
      });
      expect(path.basename(dir)).toBe(`任务_1011_${Array.from(userMessage).slice(0, 20).join('')}`);
      // 四个占位标题都派生同一个目录名，逐个清掉再验下一个
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('uses untitled when neither title nor user message is usable', async () => {
    const dir = await createSessionWorkDirectory({
      sessionTitle: '新对话',
      userMessage: '   /\\:*?"<>|   ',
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(path.basename(dir)).toBe('任务_1011_untitled');
    const bare = await createSessionWorkDirectory({ now: fixedNow, language: 'en', env });
    expect(path.basename(bare)).toBe('Task_1011_untitled');
  });

  it('appends -2, -3 on name collision', async () => {
    const first = await createSessionWorkDirectory({
      sessionTitle: '重名任务',
      now: fixedNow,
      language: 'zh',
      env,
    });
    const second = await createSessionWorkDirectory({
      sessionTitle: '重名任务',
      now: fixedNow,
      language: 'zh',
      env,
    });
    const third = await createSessionWorkDirectory({
      sessionTitle: '重名任务',
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(path.basename(first)).toBe('任务_1011_重名任务');
    expect(path.basename(second)).toBe('任务_1011_重名任务-2');
    expect(path.basename(third)).toBe('任务_1011_重名任务-3');
  });

  it('never deletes or renames existing content (create-only)', async () => {
    const first = await createSessionWorkDirectory({
      sessionTitle: '只增不删',
      now: fixedNow,
      language: 'zh',
      env,
    });
    await writeFile(path.join(first, 'deliverable.md'), '既有产物', 'utf8');
    const second = await createSessionWorkDirectory({
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
    await createSessionWorkDirectory({ sessionTitle: '新任务', now: fixedNow, language: 'zh', env });
    expect(await readFile(path.join(legacy, 'old.txt'), 'utf8')).toBe('old');
  });
});
