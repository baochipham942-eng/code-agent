// N-UI-CRON-RUN-RECORD-CLEAR：运行记录气泡只显示任务本身。
// stripCronPromptDecoration 只切 host 注入的机器尾段（时间锚点起头），模型收到的
// prompt 逐字节不变——这里的夹具直接用真 buildCronAgentPrompt 的产出，钉住
// 「新写入的记录」与「已存的旧记录」两种形状。

import { describe, expect, it } from 'vitest';
import { buildCronAgentPrompt } from '../../src/host/cron/cronAgentPrompt';
import { stripCronPromptDecoration } from '../../src/shared/cronRunMessage';

const TASK = '查一下今天的日程，把冲突的会议列出来';

const NOW = new Date('2026-11-04T08:27:33.512Z');

describe('stripCronPromptDecoration', () => {
  it('未开变化追踪的 run：完整 prompt 切回任务原文', () => {
    const fullPrompt = buildCronAgentPrompt(TASK, null, false, NOW);
    expect(fullPrompt).toContain('【当前时间】');
    expect(fullPrompt).toContain('<cron_summary>');
    expect(stripCronPromptDecoration(fullPrompt)).toBe(TASK);
  });

  it('开了变化追踪且有旧快照的 run：快照对比段一并切掉', () => {
    const fullPrompt = buildCronAgentPrompt(
      TASK,
      '昨天有 2 个冲突',
      true,
      NOW,
      '今天需要我处理',
      '有冲突时才打扰我',
    );
    expect(fullPrompt).toContain('<previous_snapshot>');
    expect(fullPrompt).toContain('<cron_snapshot>');
    expect(fullPrompt).toContain('打扰规则（用户设定）');
    expect(stripCronPromptDecoration(fullPrompt)).toBe(TASK);
  });

  it('首次运行（无旧快照）同样切回任务原文', () => {
    const fullPrompt = buildCronAgentPrompt(TASK, null, true, NOW);
    expect(stripCronPromptDecoration(fullPrompt)).toBe(TASK);
  });

  it('事件触发 run 追加的载荷块跟在尾段之后，一起切掉', () => {
    const fullPrompt = `${buildCronAgentPrompt(TASK, null, false, NOW)}\n\n<untrusted_events>\n某事件\n</untrusted_events>`;
    expect(stripCronPromptDecoration(fullPrompt)).toBe(TASK);
  });

  it('旧记录（渲染层兜底）：手工拼出的历史形状同样切回任务', () => {
    // 2026-07 之前的老记录形状与今天一致：任务 + 空行 + 【当前时间】ISO（UTC）。…
    const legacy = `${TASK}\n\n【当前时间】2026-07-24T01:30:00.000Z（UTC）。今天本地日期是 2026-07-24。`;
    expect(stripCronPromptDecoration(legacy)).toBe(TASK);
  });

  it('普通用户消息（没有机器尾段）原样返回', () => {
    const plain = '帮我看看这个报错\n\n第二行';
    expect(stripCronPromptDecoration(plain)).toBe(plain);
    expect(stripCronPromptDecoration('')).toBe('');
  });

  it('任务正文里手打了【当前时间】四个字但不符合锚点结构：不切', () => {
    const tricky = `${TASK}\n\n【当前时间】是几点？`;
    expect(stripCronPromptDecoration(tricky)).toBe(tricky);
  });
});
