// ============================================================================
// N-DELIVERABLE-WORKDIR-DEFAULT / N-DELIVERABLE-WORKDIR-LAZY：无文件夹新会话的
// 按会话产出目录。验收：目录路径落在 getDefaultWorkDirectory() 之下（任务_/Task_
// 前缀、MMDD、标题清洗、撞名 -2、无标题回退）；懒开——plan 只算路径不落盘，
// materialize 幂等补 mkdir；重规划——智能标题就位且目录未落盘时按标题改名，
// 已落盘/标题不可用/路径不是规划形状时不改。全程临时 HOME/数据目录，不碰真实主目录。
//
// rework r2 撞名占用：懒开后路径先记进会话行、纯问答会话的目录永不落盘，撞名判定
// 必须把「其它会话行已记下的路径（reservedPaths）」与磁盘条目一起当占用——两个
// 同日同题会话不再共享产出目录；已被双方记下且盘上尚无内容的路径在运行前改道
// （maybeDivertCollidingSessionWorkDirectory），盘上已有内容的不动。
//
// rework r3：回写会话行之前占用列表是空的。两个重叠的 plan 会同时看见空盘。
// 磁盘检查返回后同步占名，后到的规划拿到 -2；纯问答仍然一个目录都不建。
// fs/promises 的 stat 包一层钩子，只给重叠用例把两次磁盘检查挡在返回之前。
// ============================================================================
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fsStatGate = vi.hoisted(() => ({
  beforeStat: null as null | ((target: string) => Promise<void>),
  forceMissing: null as null | ((target: string) => boolean),
}));

vi.mock('fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs/promises')>();
  const stat = async (...args: Parameters<typeof actual.stat>) => {
    const target = String(args[0]);
    if (fsStatGate.beforeStat) await fsStatGate.beforeStat(target);
    if (fsStatGate.forceMissing?.(target)) {
      throw Object.assign(new Error(`ENOENT: ${target}`), { code: 'ENOENT' });
    }
    return actual.stat(...args);
  };
  return { ...actual, stat };
});

vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({
    getSettings: () => ({ ui: { language: mockUiLanguage } }),
  }),
}));

// let 而非 vi.hoisted：读取发生在函数调用时，不在模块加载时
let mockUiLanguage = 'zh';

import {
  isPlannedSessionWorkDirectory,
  materializeSessionWorkDirectory,
  maybeDivertCollidingSessionWorkDirectory,
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
      // `?` 既是非法字符也是分句符，先分句会在此处切开；非法字符集的其余成员放在同一分句里洗
      sessionTitle: '  ..a/b\\c:d*ef"g<h>i|j\u0007k\u007f  双  空白  ',
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

  it('cuts a >40-char title at a clause boundary, never mid-clause (N-DELIVERABLE-WORKDIR-LAZY rework r1)', async () => {
    // 整标题 >40，第一个分句 ≤40：目录名必须停在分句符，不能把后半句拦腰截进名字
    const title = '请把本周客户反馈整理成一份完整的季度复盘报告，重点覆盖转化漏斗留存口碑以及下一步行动计划';
    expect(Array.from(title).length).toBeGreaterThan(40);
    const dir = await planSessionWorkDirectory({
      sessionTitle: title,
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(path.basename(dir)).toBe('任务_1011_请把本周客户反馈整理成一份完整的季度复盘报告');
    expect(path.basename(dir)).not.toContain('重点覆盖');
  });

  it('caps a >40-char first clause at the last word boundary rather than mid-word', async () => {
    // 40 字符硬切落在 reviews 的 'r' 上（Write comprehensive quarterly business r）
    const title = 'Write comprehensive quarterly business reviews now please thanks';
    expect(Array.from(title).length).toBeGreaterThan(40);
    const dir = await planSessionWorkDirectory({
      sessionTitle: title,
      now: fixedNow,
      language: 'en',
      env,
    });
    const name = path.basename(dir);
    expect(name.startsWith('Task_1011_')).toBe(true);
    const body = name.slice('Task_1011_'.length);
    expect(Array.from(body).length).toBeLessThanOrEqual(40);
    expect(body).toBe('Write comprehensive quarterly business');
    expect(body.endsWith(' r')).toBe(false);
    expect(body.endsWith('r')).toBe(false);
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

  it('does not re-plan a fallback-style title that is a prefix of the first message (N-DELIVERABLE-WORKDIR-LAZY rework r1)', async () => {
    // 真跑事故：小模型不可用时标题 = 首条消息（或 50 字硬切），重规划把好的分句名
    // 换成拦腰截断的降级标题。分句名已经更好，必须保持。
    const message = '用一句话说明什么是二分查找，直接回答，不要使用任何工具，不要写代码';
    const current = await planSessionWorkDirectory({
      userMessage: message,
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(path.basename(current)).toBe('任务_1011_用一句话说明什么是二分查找');

    const replanned = await maybeReplanSessionWorkDirectory({
      workingDirectory: current,
      sessionTitle: message,
      env,
    });
    if (replanned !== undefined) {
      expect(path.basename(replanned)).toBe('任务_1011_用一句话说明什么是二分查找');
    }
    expect(replanned).toBeUndefined();
  });

  it('does not re-plan a fallback-style title that is a 50-char prefix plus ellipsis', async () => {
    const message = '用一句话说明什么是二分查找，直接回答，不要使用任何工具，不要写代码也不要展开解释并且请保持在三句话以内';
    expect(Array.from(message).length).toBeGreaterThan(50);
    const fallbackTitle = `${Array.from(message).slice(0, 50).join('')}...`;
    const current = await planSessionWorkDirectory({
      userMessage: message,
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(path.basename(current)).toBe('任务_1011_用一句话说明什么是二分查找');

    const replanned = await maybeReplanSessionWorkDirectory({
      workingDirectory: current,
      sessionTitle: fallbackTitle,
      env,
    });
    // 允许 undefined（保持分句名）或分句切名；禁止把 50 字硬切 / 40 字拦腰切写进路径
    if (replanned !== undefined) {
      const name = path.basename(replanned);
      expect(name).toBe('任务_1011_用一句话说明什么是二分查找');
      expect(name).not.toContain('...');
      expect(name).not.toContain('不要写代码');
    }
    expect(replanned).toBeUndefined();
  });

  it('does not re-plan a message-prefix title even when the planned folder name does not share that prefix', async () => {
    const message = '用一句话说明什么是二分查找，直接回答，不要使用任何工具，不要写代码';
    const current = await planSessionWorkDirectory({
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(path.basename(current)).toBe('任务_1011_untitled');
    const replanned = await maybeReplanSessionWorkDirectory({
      workingDirectory: current,
      sessionTitle: message,
      userMessage: message,
      env,
    });
    expect(replanned).toBeUndefined();
  });

  it('still re-plans when the smart title is a real summary, not a message prefix', async () => {
    const current = await planSessionWorkDirectory({
      userMessage: '帮我出一份季度总结，要带图表',
      now: fixedNow,
      language: 'zh',
      env,
    });
    const replanned = await maybeReplanSessionWorkDirectory({
      workingDirectory: current,
      sessionTitle: '季度总结报告',
      userMessage: '帮我出一份季度总结，要带图表',
      env,
    });
    const now = new Date();
    const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    expect(replanned).toBe(path.join(root, `任务_${mmdd}_季度总结报告`));
  });
});

describe('planSessionWorkDirectory collision reservations (rework r2)', () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;
  let root: string;
  // 2026-10-11 20:30 本地时间 → MMDD=1011
  const fixedNow = new Date(2026, 9, 11, 20, 30).getTime();

  beforeEach(async () => {
    mockUiLanguage = 'zh';
    tempHome = await mkdtemp(path.join(tmpdir(), 'session-work-dir-r2-'));
    env = { CODE_AGENT_HOME: tempHome, CODE_AGENT_DATA_DIR: path.join(tempHome, '.code-agent') };
    root = getDefaultWorkDirectory(env);
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it('treats paths recorded by other sessions as occupied even when never materialized on disk', async () => {
    // 会话 A（纯问答）：规划路径记进会话行，盘上永不出现
    const first = await planSessionWorkDirectory({
      sessionTitle: '整理会议纪要',
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(first).toBe(path.join(root, '任务_1011_整理会议纪要'));
    await expect(stat(first)).rejects.toMatchObject({ code: 'ENOENT' });

    // 会话 B（同日同题）：把 A 已记下的路径当占用 → 拿到 -2，而不是同一条路径
    const second = await planSessionWorkDirectory({
      sessionTitle: '整理会议纪要',
      now: fixedNow,
      language: 'zh',
      env,
      reservedPaths: [first],
    });
    expect(second).toBe(path.join(root, '任务_1011_整理会议纪要-2'));
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('counts disk entries and recorded reservations together when suffixing', async () => {
    const first = await planSessionWorkDirectory({
      sessionTitle: '撞名',
      now: fixedNow,
      language: 'zh',
      env,
    });
    // 盘上已有 -2（别的会话已落盘），会话行占用 first → 下一个空闲是 -3
    await mkdir(path.join(root, '任务_1011_撞名-2'), { recursive: true });
    const third = await planSessionWorkDirectory({
      sessionTitle: '撞名',
      now: fixedNow,
      language: 'zh',
      env,
      reservedPaths: [first],
    });
    expect(third).toBe(path.join(root, '任务_1011_撞名-3'));
  });

  it('ignores reserved paths outside the default work root', async () => {
    const dir = await planSessionWorkDirectory({
      sessionTitle: '外部占用',
      now: fixedNow,
      language: 'zh',
      env,
      reservedPaths: [path.join(tempHome, 'elsewhere', '任务_1011_外部占用')],
    });
    expect(dir).toBe(path.join(root, '任务_1011_外部占用'));
  });

  it('re-plan by smart title avoids names already recorded by other sessions', async () => {
    // 另一个会话行已记下 任务_MMDD_季度总结报告（未落盘）：按标题重规划要避开它。
    // 重规划名取实时日期（replan 不接收 now），断言同样按今天算。
    const now = new Date();
    const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const reserved = path.join(root, `任务_${mmdd}_季度总结报告`);
    const current = await planSessionWorkDirectory({
      userMessage: '帮我出一份季度总结，要带图表',
      now: fixedNow,
      language: 'zh',
      env,
    });
    const replanned = await maybeReplanSessionWorkDirectory({
      workingDirectory: current,
      sessionTitle: '季度总结报告',
      userMessage: '帮我出一份季度总结，要带图表',
      env,
      reservedPaths: [reserved],
    });
    expect(replanned).toBe(path.join(root, `任务_${mmdd}_季度总结报告-2`));
  });

  it('re-plan does not treat the session\'s own current path as occupied', async () => {
    const now = new Date();
    const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
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
      reservedPaths: [current],
    });
    expect(replanned).toBe(path.join(root, `任务_${mmdd}_季度总结报告`));
  });
});

describe('maybeDivertCollidingSessionWorkDirectory (pre-run collision divert, rework r2)', () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;
  let root: string;

  beforeEach(async () => {
    mockUiLanguage = 'zh';
    tempHome = await mkdtemp(path.join(tmpdir(), 'session-work-dir-divert-'));
    env = { CODE_AGENT_HOME: tempHome, CODE_AGENT_DATA_DIR: path.join(tempHome, '.code-agent') };
    root = getDefaultWorkDirectory(env);
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it('diverts a foreign-claimed planned path that has no content on disk yet', async () => {
    const current = path.join(root, '任务_1011_整理会议纪要');
    const diverted = await maybeDivertCollidingSessionWorkDirectory({
      workingDirectory: current,
      reservedPaths: [current],
      env,
    });
    expect(diverted).toBe(path.join(root, '任务_1011_整理会议纪要-2'));
    // 改道只是算路径：盘上零改动
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('diverts when the foreign-claimed directory exists but is still empty', async () => {
    const current = path.join(root, '任务_1011_整理会议纪要');
    await mkdir(current, { recursive: true });
    const diverted = await maybeDivertCollidingSessionWorkDirectory({
      workingDirectory: current,
      reservedPaths: [current],
      env,
    });
    expect(diverted).toBe(path.join(root, '任务_1011_整理会议纪要-2'));
  });

  it('keeps a foreign-claimed path that already has content — diverting would orphan files', async () => {
    const current = path.join(root, '任务_1011_整理会议纪要');
    await mkdir(current, { recursive: true });
    await writeFile(path.join(current, '别人的产出.md'), 'x');
    await expect(maybeDivertCollidingSessionWorkDirectory({
      workingDirectory: current,
      reservedPaths: [current],
      env,
    })).resolves.toBeUndefined();
  });

  it('does nothing when no other session claims the path (normal reuse)', async () => {
    const current = path.join(root, '任务_1011_整理会议纪要');
    await expect(maybeDivertCollidingSessionWorkDirectory({
      workingDirectory: current,
      reservedPaths: [],
      env,
    })).resolves.toBeUndefined();
  });

  it('does nothing for paths that are not planned session folders', async () => {
    const userFolder = path.join(root, '我自己的文件夹');
    await expect(maybeDivertCollidingSessionWorkDirectory({
      workingDirectory: userFolder,
      reservedPaths: [userFolder],
      env,
    })).resolves.toBeUndefined();
    await expect(maybeDivertCollidingSessionWorkDirectory({
      workingDirectory: path.join(tempHome, 'elsewhere'),
      reservedPaths: [path.join(tempHome, 'elsewhere')],
      env,
    })).resolves.toBeUndefined();
  });

  it('diverts from an already-suffixed path to the next free suffix of the same base', async () => {
    const current = path.join(root, '任务_1011_整理会议纪要-3');
    const diverted = await maybeDivertCollidingSessionWorkDirectory({
      workingDirectory: current,
      reservedPaths: [current],
      env,
    });
    // 基础名（去掉 -3）空闲时直接回基础名；基础名被占用则顺延
    expect(diverted).toBe(path.join(root, '任务_1011_整理会议纪要'));
    const baseClaimed = path.join(root, '任务_1011_整理会议纪要');
    const divertedNext = await maybeDivertCollidingSessionWorkDirectory({
      workingDirectory: current,
      reservedPaths: [current, baseClaimed],
      env,
    });
    expect(divertedNext).toBe(path.join(root, '任务_1011_整理会议纪要-2'));
  });
});

describe('in-process path claims (rework r3)', () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;
  let root: string;
  const fixedNow = new Date(2026, 9, 11, 20, 30).getTime();

  beforeEach(async () => {
    mockUiLanguage = 'zh';
    fsStatGate.beforeStat = null;
    fsStatGate.forceMissing = null;
    tempHome = await mkdtemp(path.join(tmpdir(), 'session-work-dir-r3-'));
    env = { CODE_AGENT_HOME: tempHome, CODE_AGENT_DATA_DIR: path.join(tempHome, '.code-agent') };
    root = getDefaultWorkDirectory(env);
  });

  afterEach(async () => {
    fsStatGate.beforeStat = null;
    fsStatGate.forceMissing = null;
    await rm(tempHome, { recursive: true, force: true });
  });

  it('overlapping planners that both see an empty disk receive different paths; the second is the -2 suffix', async () => {
    const unsuffixed = path.join(root, '任务_1011_并发规划');
    const resolvedRoot = path.resolve(root);
    let entered = 0;
    let releaseBoth: () => void = () => {};
    const bothEntered = new Promise<void>((resolve) => {
      releaseBoth = resolve;
    });
    const waiters: Array<() => void> = [];
    fsStatGate.beforeStat = async (target) => {
      if (path.resolve(target) !== path.resolve(unsuffixed)) return;
      entered += 1;
      if (entered === 2) releaseBoth();
      await new Promise<void>((resolve) => {
        waiters.push(resolve);
      });
    };
    // 真 stat 走线程池，完成顺序不稳定。这里在闸门打开后同步抛 ENOENT，
    // 让两个规划器按调用顺序恢复，先恢复的占住无后缀名。
    fsStatGate.forceMissing = (target) => {
      const resolved = path.resolve(target);
      return resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`);
    };

    const options = {
      sessionTitle: '并发规划',
      now: fixedNow,
      language: 'zh' as const,
      env,
      reservedPaths: [] as string[],
    };
    let settled = 0;
    const track = (pending: Promise<string>): Promise<string> => pending.then((value) => {
      settled += 1;
      return value;
    });
    const firstPromise = track(planSessionWorkDirectory(options));
    const secondPromise = track(planSessionWorkDirectory(options));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const bothSawDisk = await Promise.race([
        bothEntered.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 1000);
        }),
      ]);
      clearTimeout(timeout);
      expect(bothSawDisk).toBe(true);
      expect(entered).toBe(2);
      expect(settled).toBe(0);
      for (const release of waiters) release();
      const [firstPath, secondPath] = await Promise.all([firstPromise, secondPromise]);
      expect(firstPath).toBe(unsuffixed);
      expect(secondPath).toBe(`${unsuffixed}-2`);
      expect(firstPath).not.toBe(secondPath);
    } finally {
      clearTimeout(timeout);
      fsStatGate.beforeStat = null;
      fsStatGate.forceMissing = null;
      for (const release of waiters) release();
      await Promise.allSettled([firstPromise, secondPromise]);
    }
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('a later plan treats the in-process claim as taken when reservedPaths is empty and nothing is on disk', async () => {
    const first = await planSessionWorkDirectory({
      sessionTitle: '稍后规划',
      now: fixedNow,
      language: 'zh',
      env,
      reservedPaths: [],
    });
    const second = await planSessionWorkDirectory({
      sessionTitle: '稍后规划',
      now: fixedNow,
      language: 'zh',
      env,
      reservedPaths: [],
    });
    expect(first).toBe(path.join(root, '任务_1011_稍后规划'));
    expect(second).toBe(path.join(root, '任务_1011_稍后规划-2'));
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('re-plan treats an in-process claim as taken even when reservedPaths is empty', async () => {
    const now = new Date();
    const mmdd = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const claimed = await planSessionWorkDirectory({
      sessionTitle: '季度总结报告',
      language: 'zh',
      env,
      reservedPaths: [],
    });
    expect(claimed).toBe(path.join(root, `任务_${mmdd}_季度总结报告`));
    const current = path.join(root, '任务_1011_帮我出一份季度总结');
    const replanned = await maybeReplanSessionWorkDirectory({
      workingDirectory: current,
      sessionTitle: '季度总结报告',
      env,
      reservedPaths: [],
    });
    expect(replanned).toBe(path.join(root, `任务_${mmdd}_季度总结报告-2`));
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('divert does not keep a path this process already claimed when another session reserved it', async () => {
    const current = await planSessionWorkDirectory({
      sessionTitle: '改道不豁免',
      now: fixedNow,
      language: 'zh',
      env,
    });
    expect(current).toBe(path.join(root, '任务_1011_改道不豁免'));
    const diverted = await maybeDivertCollidingSessionWorkDirectory({
      workingDirectory: current,
      reservedPaths: [current],
      env,
    });
    expect(diverted).toBe(path.join(root, '任务_1011_改道不豁免-2'));
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('isPlannedSessionWorkDirectory', () => {
  let tempHome: string;
  let env: NodeJS.ProcessEnv;
  let root: string;

  beforeEach(async () => {
    mockUiLanguage = 'zh';
    tempHome = await mkdtemp(path.join(tmpdir(), 'session-work-dir-shape-'));
    env = { CODE_AGENT_HOME: tempHome, CODE_AGENT_DATA_DIR: path.join(tempHome, '.code-agent') };
    root = getDefaultWorkDirectory(env);
  });

  afterEach(async () => {
    await rm(tempHome, { recursive: true, force: true });
  });

  it('accepts planned folder shapes strictly inside the default work root', () => {
    expect(isPlannedSessionWorkDirectory(path.join(root, '任务_1011_标题'), env)).toBe(true);
    expect(isPlannedSessionWorkDirectory(path.join(root, 'Task_1011_title-2'), env)).toBe(true);
    expect(isPlannedSessionWorkDirectory(path.join(root, '任务_1011_标题') + path.sep, env)).toBe(true);
  });

  it('rejects the root itself, paths outside it, and non-planned names', () => {
    expect(isPlannedSessionWorkDirectory(root, env)).toBe(false);
    expect(isPlannedSessionWorkDirectory(path.join(tempHome, 'elsewhere', '任务_1011_标题'), env)).toBe(false);
    expect(isPlannedSessionWorkDirectory(path.join(root, '我自己的文件夹'), env)).toBe(false);
    expect(isPlannedSessionWorkDirectory('', env)).toBe(false);
    expect(isPlannedSessionWorkDirectory('   ', env)).toBe(false);
  });
});
