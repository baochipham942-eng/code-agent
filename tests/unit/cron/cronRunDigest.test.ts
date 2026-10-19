import { describe, expect, it, vi, afterEach } from 'vitest';
import { buildCronAgentPrompt } from '../../../src/host/cron/cronAgentPrompt';
import { countPendingReviewByTask, extractCronAlertText, groupRunsByTask, parseCronRunDigest } from '../../../src/shared/cronRunDigest';

describe('parseCronRunDigest', () => {
  it('extracts the summary and multiple artifact links from the first block', () => {
    expect(parseCronRunDigest(
      'ignored <cron_summary>\n完成日报\nartifact: /tmp/report.md\nARTIFACT: https://example.com/report\n</cron_summary> ignored',
    )).toEqual({
      summary: '完成日报',
      artifacts: ['/tmp/report.md', 'https://example.com/report'],
    });
  });

  it('returns an empty artifact list when there is no complete block', () => {
    expect(parseCronRunDigest('没有摘要')).toEqual({ artifacts: [] });
    expect(() => parseCronRunDigest('<cron_summary>未闭合')).not.toThrow();
    expect(parseCronRunDigest('<cron_summary>未闭合')).toEqual({ artifacts: [] });
  });

  it('caps an over-long summary at 1000 characters and ignores content outside the block', () => {
    const summary = 'a'.repeat(1001);
    expect(parseCronRunDigest(`外部文字<cron_summary>${summary}</cron_summary>外部文字`)).toEqual({
      summary: 'a'.repeat(1000),
      artifacts: [],
    });
  });

  it('limits extracted artifacts to ten lines', () => {
    const body = Array.from({ length: 12 }, (_, index) => `artifact: /tmp/${index}`).join('\n');
    expect(parseCronRunDigest(`<CRON_SUMMARY>${body}</CRON_SUMMARY>`).artifacts).toEqual(
      Array.from({ length: 10 }, (_, index) => `/tmp/${index}`),
    );
  });

  it('keeps the first block and ignores artifact lines outside it', () => {
    expect(parseCronRunDigest(
      'artifact: /outside\n<cron_summary>first\nartifact: /a</cron_summary><cron_summary>second\nartifact: /b</cron_summary>',
    )).toEqual({ summary: 'first', artifacts: ['/a'] });
    expect(parseCronRunDigest(null)).toEqual({ artifacts: [] });
    expect(parseCronRunDigest(undefined)).toEqual({ artifacts: [] });
  });
});

describe('buildCronAgentPrompt delivery digest instruction', () => {
  it('includes the digest instruction in both modes and keeps snapshot guidance enabled', () => {
    const enabled = buildCronAgentPrompt('检查', null, true, new Date('2026-09-30T00:00:00.000Z'));
    const disabled = buildCronAgentPrompt('检查', null, false, new Date('2026-09-30T00:00:00.000Z'));

    expect(enabled).toContain('<cron_summary>...</cron_summary>');
    expect(enabled).toContain('artifact: <path>');
    expect(enabled).toContain('<cron_snapshot>...</cron_snapshot>');
    expect(disabled).toContain('<cron_summary>...</cron_summary>');
    expect(disabled).toContain('artifact: <path>');
    expect(disabled).not.toContain('<cron_snapshot>');
  });

  it('lets the model mark urgency as the first line of the summary (N-CRON-INBOX-URGENCY-TIER)', () => {
    const enabled = buildCronAgentPrompt('检查', null, true, new Date('2026-09-30T00:00:00.000Z'));
    const disabled = buildCronAgentPrompt('检查', null, false, new Date('2026-09-30T00:00:00.000Z'));

    for (const prompt of [enabled, disabled]) {
      expect(prompt).toContain('urgency: must_today|can_wait|fyi');
    }
  });
});

describe('buildCronAgentPrompt urgencyCriteria（N-CRON-MORNING-TRIAGE-URGENCY-RULE）', () => {
  // 冻结时间锚点（mock formatTodayAnchor，与 todayAnchorConsumers 同口径）后整段输出确定。
  // 期望串的固定段逐字节取自改动前的源码字面量；两个 epoch 数按锚点日期的本地 00:00
  // 算出（构造式与被测代码同一条 documented 公式，时区无关地跟随运行机）。
  const ANCHOR = {
    prompt: "Today's date: 2099-12-31 (Thursday).",
    isoDate: '2099-12-31',
    year: 2099,
    month: 12,
    day: 31,
  };
  const NOW = new Date('2026-09-30T00:00:00.000Z');
  const todayEpoch = Math.floor(new Date(ANCHOR.year, ANCHOR.month - 1, ANCHOR.day, 0, 0, 0, 0).getTime() / 1000);
  const tomorrowEpoch = todayEpoch + 86400;
  const timeAnchor =
    `【当前时间】2026-09-30T00:00:00.000Z（UTC）。今天本地日期是 2099-12-31。`
    + `若要按「今天/本地当天」查询时间戳，直接用这两个算好的值，不要自己换算年份：`
    + `今天本地 00:00 = ${todayEpoch}（Unix 秒），次日本地 00:00 = ${tomorrowEpoch}（Unix 秒）。`
    + '其他相对时间以【当前时间】为基准，不要用你训练时的日期。';
  // 改动前的 deliveryDigestInstruction 原文（缺省判据路径必须逐字节复现）。
  const deliveryDigest =
    '最后请在回复末尾追加简短的 <cron_summary>...</cron_summary> 块：先写结果摘要；每个生成的文件或可访问产物另起一行，格式为 artifact: <path>。'
    + '摘要的第一行可以标注紧急程度，格式为 urgency: must_today|can_wait|fyi（must_today = 今天需要用户处理，can_wait = 可以稍后处理，fyi = 仅供参考）。';
  const snapshotGuidance = '回复末尾请用 <cron_snapshot>...</cron_snapshot> 包住本次需要记住的简短快照，供下次对比。';
  const expectedEnabled = ['检查', '', timeAnchor, '', snapshotGuidance, '', deliveryDigest].join('\n');
  const expectedDisabled = ['检查', '', timeAnchor, '', deliveryDigest].join('\n');

  afterEach(() => {
    vi.doUnmock('../../../src/shared/todayAnchor');
    vi.resetModules();
  });

  async function buildWithFrozenAnchor(...args: Parameters<typeof buildCronAgentPrompt>) {
    // 顶部静态 import 已把 cronAgentPrompt 连同真 todayAnchor 载入缓存；先 resetModules
    // 再 doMock，动态 import 才会吃到锚点 mock（本文件其余 describe 用的是静态绑定，不受影响）。
    vi.resetModules();
    vi.doMock('../../../src/shared/todayAnchor', () => ({ formatTodayAnchor: () => ANCHOR }));
    const { buildCronAgentPrompt: build } = await import('../../../src/host/cron/cronAgentPrompt');
    return build(...args);
  }

  it('缺省 urgencyCriteria 时两种模式的产出与改动前逐字节相同', async () => {
    expect(await buildWithFrozenAnchor('检查', null, true, NOW)).toBe(expectedEnabled);
    expect(await buildWithFrozenAnchor('检查', null, false, NOW)).toBe(expectedDisabled);
  });

  it('带上旧快照时缺省判据的产出同样逐字节相同', async () => {
    const withSnapshot = await buildWithFrozenAnchor('检查', '旧快照内容', true, NOW);
    expect(withSnapshot).toBe(
      ['检查', '', timeAnchor, '', '上次运行看到的快照：', '<previous_snapshot>', '旧快照内容', '</previous_snapshot>', '',
        '请把上面的快照和本次看到的内容对比，这次只需要说明变化。', '', snapshotGuidance, '', deliveryDigest].join('\n'),
    );
  });

  it('自定义判据只替换 must_today 的定义，头格式与其他档位不动', async () => {
    const enabled = await buildWithFrozenAnchor('检查', null, true, NOW, '只有老板发来的邮件算紧急');
    const disabled = await buildWithFrozenAnchor('检查', null, false, NOW, '只有老板发来的邮件算紧急');

    for (const prompt of [enabled, disabled]) {
      expect(prompt).toContain(
        'urgency: must_today|can_wait|fyi（must_today = 只有老板发来的邮件算紧急，can_wait = 可以稍后处理，fyi = 仅供参考）',
      );
      expect(prompt).not.toContain('今天需要用户处理');
      expect(prompt).toContain('<cron_summary>');
    }
    expect(enabled).toContain('<cron_snapshot>');
  });

  it('空白判据回落缺省定义（逐字节）', async () => {
    expect(await buildWithFrozenAnchor('检查', null, true, NOW, '   ')).toBe(expectedEnabled);
    expect(await buildWithFrozenAnchor('检查', null, false, NOW, '')).toBe(expectedDisabled);
  });
});

describe('buildCronAgentPrompt notifyWhen（N-CRON-RESTATE-HUMAN-WHEN）', () => {
  // 与 urgencyCriteria 同一条冻结锚点 harness：期望串的固定段逐字节取自
  // 改动前（notifyWhen 缺席时）的源码字面量——无判据任务 prompt 字节不变是本单的硬约束。
  const ANCHOR = {
    isoDate: '2099-12-31',
    year: 2099,
    month: 12,
    day: 31,
  };
  const NOW = new Date('2026-09-30T00:00:00.000Z');
  const todayEpoch = Math.floor(new Date(ANCHOR.year, ANCHOR.month - 1, ANCHOR.day, 0, 0, 0, 0).getTime() / 1000);
  const tomorrowEpoch = todayEpoch + 86400;
  const timeAnchor =
    `【当前时间】2026-09-30T00:00:00.000Z（UTC）。今天本地日期是 2099-12-31。`
    + `若要按「今天/本地当天」查询时间戳，直接用这两个算好的值，不要自己换算年份：`
    + `今天本地 00:00 = ${todayEpoch}（Unix 秒），次日本地 00:00 = ${tomorrowEpoch}（Unix 秒）。`
    + '其他相对时间以【当前时间】为基准，不要用你训练时的日期。';
  const deliveryDigest =
    '最后请在回复末尾追加简短的 <cron_summary>...</cron_summary> 块：先写结果摘要；每个生成的文件或可访问产物另起一行，格式为 artifact: <path>。'
    + '摘要的第一行可以标注紧急程度，格式为 urgency: must_today|can_wait|fyi（must_today = 今天需要用户处理，can_wait = 可以稍后处理，fyi = 仅供参考）。';
  const snapshotGuidance = '回复末尾请用 <cron_snapshot>...</cron_snapshot> 包住本次需要记住的简短快照，供下次对比。';
  const expectedEnabled = ['检查', '', timeAnchor, '', snapshotGuidance, '', deliveryDigest].join('\n');
  const expectedDisabled = ['检查', '', timeAnchor, '', deliveryDigest].join('\n');
  const RULE = '只有需要今天处理的紧急事项';

  afterEach(() => {
    vi.doUnmock('../../../src/shared/todayAnchor');
    vi.resetModules();
  });

  async function buildWithFrozenAnchor(...args: Parameters<typeof buildCronAgentPrompt>) {
    vi.resetModules();
    vi.doMock('../../../src/shared/todayAnchor', () => ({ formatTodayAnchor: () => ANCHOR }));
    const { buildCronAgentPrompt: build } = await import('../../../src/host/cron/cronAgentPrompt');
    return build(...args);
  }

  it('无 notifyWhen 时两种模式（含快照路径）的产出与改动前逐字节相同', async () => {
    expect(await buildWithFrozenAnchor('检查', null, true, NOW, undefined, undefined)).toBe(expectedEnabled);
    expect(await buildWithFrozenAnchor('检查', null, false, NOW, undefined, undefined)).toBe(expectedDisabled);
  });

  it('空白 notifyWhen 与缺省逐字节相同（空判据 = 每次都通知的旧行为）', async () => {
    expect(await buildWithFrozenAnchor('检查', null, true, NOW, undefined, '   ')).toBe(expectedEnabled);
    expect(await buildWithFrozenAnchor('检查', null, false, NOW, undefined, '')).toBe(expectedDisabled);
  });

  it('设置判据时两种模式都在末尾追加 <cron_alert> 打扰指令，判据原文入 prompt', async () => {
    const enabled = await buildWithFrozenAnchor('检查', null, true, NOW, undefined, RULE);
    const disabled = await buildWithFrozenAnchor('检查', null, false, NOW, undefined, RULE);
    const instruction =
      `打扰规则（用户设定）：本次运行只有当结果满足「${RULE}」时，才在回复末尾追加一行 <cron_alert>用一句话说明满足了什么</cron_alert>；不满足时不要输出 <cron_alert> 标记（该轮将不打扰用户）。`;

    for (const prompt of [enabled, disabled]) {
      expect(prompt.endsWith(instruction)).toBe(true);
      expect(prompt).toContain(deliveryDigest);
    }
    expect(enabled).toContain('<cron_snapshot>');
    expect(disabled).not.toContain('<cron_snapshot>');
  });
});

describe('groupRunsByTask', () => {
  it('groups cron and heartbeat runs by origin id, newest first', () => {
    const old = { id: 's-old', updatedAt: 10, origin: { kind: 'cron' as const, id: 'job-a' } };
    const newest = { id: 's-new', updatedAt: 30, origin: { kind: 'heartbeat' as const, id: 'job-a' } };
    const other = { id: 's-other', updatedAt: 20, origin: { kind: 'cron' as const, id: 'job-b' } };
    const result = groupRunsByTask([old, newest, other]);

    expect(result.groups['job-a']).toMatchObject({
      runCount: 2,
      latestSessionId: 's-new',
      runs: [newest, old],
    });
    expect(result.groups['job-b']).toMatchObject({ runCount: 1, latestSessionId: 's-other' });
  });

  it('passes non-cron sessions through in their original order', () => {
    const manual = { id: 'manual', updatedAt: 30, origin: { kind: 'manual' as const } };
    const noOrigin = { id: 'plain', updatedAt: 20 };
    const cron = { id: 'cron', updatedAt: 10, origin: { kind: 'cron' as const, id: 'job-a' } };

    expect(groupRunsByTask([manual, noOrigin, cron]).ungrouped).toEqual([manual, noOrigin]);
  });

  it('passes sessions without a cron or heartbeat task id through in original order', () => {
    const first = { id: 'manual-1', updatedAt: 1, origin: { kind: 'manual' as const } };
    const cron = { id: 'cron', updatedAt: 2, origin: { kind: 'cron' as const, id: '   ' } };
    const second = { id: 'manual-2', updatedAt: 3 };
    expect(groupRunsByTask([first, cron, second]).ungrouped).toEqual([first, cron, second]);
  });
});

describe('countPendingReviewByTask', () => {
  const session = (id: string, kind: string, taskId?: string) => ({
    id,
    updatedAt: 1,
    origin: { kind, ...(taskId ? { id: taskId } : {}) },
  });

  it('folds records that share a cron or heartbeat task and leaves the rest', () => {
    const records = [
      { resultSessionId: 'run-1' },
      { resultSessionId: 'run-2' },
      { config: { pendingReview: { resultSessionId: 'run-3' } } },
      { resultSessionId: 'missing' },
      { resultSessionId: 'chat-1' },
    ];
    const sessionsById = {
      'run-1': session('run-1', 'cron', 'job-a'),
      'run-2': session('run-2', 'heartbeat', 'job-a'),
      'run-3': session('run-3', 'cron', 'job-b'),
      'chat-1': session('chat-1', 'manual', 'job-a'),
    };

    expect(countPendingReviewByTask(records, sessionsById)).toBe(4);
  });

  it('prefers resultSessionId over the pending-review session when both are set', () => {
    const records = [{
      resultSessionId: 'run-new',
      config: { pendingReview: { resultSessionId: 'run-old' } },
    }];
    const sessionsById = {
      'run-new': session('run-new', 'cron', 'job-new'),
      'run-old': session('run-old', 'cron', 'job-old'),
    };
    expect(countPendingReviewByTask(records, sessionsById)).toBe(1);
    expect(countPendingReviewByTask([
      { resultSessionId: 'run-new' },
      { resultSessionId: 'run-old' },
    ], sessionsById)).toBe(2);
  });
});

// N-CRON-RESTATE-HUMAN-WHEN-FU1: <cron_alert> 提取单一出口——完成系统通知与推送清洗
// 共用。这里钉它的提取规则；「推送正文等于它」的对接钉在 cronResultDelivery.test.ts。
describe('extractCronAlertText', () => {
  it('returns the trimmed inner text of a single alert, tags stripped', () => {
    expect(extractCronAlertText('巡检完成。<cron_alert>\n  生产服务器宕机  </cron_alert>'))
      .toBe('生产服务器宕机');
  });

  it('joins multiple alert blocks with newlines and drops blank ones', () => {
    expect(extractCronAlertText(
      '<cron_alert>冲突 A</cron_alert> 说明 <cron_alert> </cron_alert> 尾注 <cron_alert>冲突 B</cron_alert>',
    )).toBe('冲突 A\n冲突 B');
  });

  it('strips <cron_snapshot> blocks before matching: alerts inside a snapshot do not count', () => {
    expect(extractCronAlertText(
      '<cron_snapshot>state <cron_alert>快照里的不算</cron_alert></cron_snapshot><cron_alert>真告警</cron_alert>',
    )).toBe('真告警');
  });

  it('returns an empty string when there is no alert or the tag is empty', () => {
    expect(extractCronAlertText('普通正文，没有标记')).toBe('');
    expect(extractCronAlertText('<cron_snapshot>only-state</cron_snapshot>')).toBe('');
    expect(extractCronAlertText('<cron_alert></cron_alert>')).toBe('');
    expect(extractCronAlertText('<cron_alert>   </cron_alert>')).toBe('');
  });
});
