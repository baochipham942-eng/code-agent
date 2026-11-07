import { describe, expect, it } from 'vitest';
import { getToolStatusLabel } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/statusLabels';
import type { ToolCall } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import { en } from '../../../src/renderer/i18n/en';
import { describeParkedApprovalClosure } from '../../../src/host/agent/parkedApprovalSurvival';

function denied(error: string, metadata?: Record<string, unknown>): ToolCall {
  return {
    id: 'c1',
    name: 'Bash',
    arguments: { command: 'sleep 30' },
    result: { toolCallId: 'c1', success: false, error, duration: 0, ...(metadata ? { metadata } : {}) },
  };
}

// 台账里持久化的是中文原句；英文 UI 按原句精确查表翻成英文（键 = 收口句名）。
const EN_CLOSURE_SENTENCES = {
  expiredAfterRestart24h: 'This step waited for your confirmation for over 24 hours, so it was voided automatically and did not run.',
  workingDirectoryUnavailable: "This conversation has no working directory, so it can't be run safely after a restart. It did not run.",
  runEndedAfterRestart: 'The run this step belonged to has already ended, so it did not run; you will be asked again the next time it triggers.',
  argsUnavailable: 'After the app restarted, the full details of this step could not be found, so it was not run for safety.',
} as const;

// 老行字面量（不经任何代码产出，模拟重启前落库的历史数据）：英文 UI 也要翻出来。
const LEGACY_ZH_SENTENCES = {
  expiredAfterRestart24h: '这一步等你确认超过 24 小时，已自动作废，没有执行。',
  workingDirectoryUnavailable: '这次对话没有工作目录，重启后无法安全执行，没有执行。',
  runEndedAfterRestart: '所属运行已结束，没有执行；下次触发会重新询问你。',
  argsUnavailable: '应用重启后找不到这一步的完整信息，为安全起见没有执行。',
} as const;

type ClosureKey = keyof typeof LEGACY_ZH_SENTENCES;

// 停车审批被自动收口后，台账 denied 结果的步骤头读作「未执行 · 原因」，不是「执行失败」。
// 两种语言都要：zh 输出与原句字节一致；en 输出英文句（原句仍是中文）。
describe('停车审批 denied 结果的步骤状态词', () => {
  describe.each([
    ['host 现写的收口句', (key: ClosureKey) => {
      if (key === 'expiredAfterRestart24h') return describeParkedApprovalClosure('expired_after_restart_24h');
      if (key === 'workingDirectoryUnavailable') return describeParkedApprovalClosure('args_unavailable', 'working_directory_unavailable');
      if (key === 'runEndedAfterRestart') return describeParkedApprovalClosure('run_ended_after_restart');
      return describeParkedApprovalClosure('args_unavailable');
    }],
    ['老行持久化的中文原句', (key: ClosureKey) => LEGACY_ZH_SENTENCES[key]],
  ] as const)('%s', (_label, sentence) => {
    it.each(Object.keys(LEGACY_ZH_SENTENCES) as ClosureKey[])('%s → zh 原句 / en 译文', (key) => {
      expect(getToolStatusLabel(denied(sentence(key)), 'error', zh)).toBe(`未执行 · ${LEGACY_ZH_SENTENCES[key]}`);
      expect(getToolStatusLabel(denied(sentence(key)), 'error', en)).toBe(`Not run · ${EN_CLOSURE_SENTENCES[key]}`);
    });
  });
});

describe('其他失败的步骤头文案保持不变', () => {
  it('超时', () => {
    expect(getToolStatusLabel(denied('timed out', { failureCode: 'timeout' }), 'error', zh)).toBe('已中断 · 等待回答或权限确认超时');
  });
  it('审批被拒', () => {
    expect(getToolStatusLabel(denied('审批失败', { code: 'PERMISSION_DENIED' }), 'error', zh)).toBe('未获批准 · 审批被拒绝');
  });
  it('普通 success:false', () => {
    expect(getToolStatusLabel(denied('boom'), 'error', zh)).toBe('执行失败 · 暂无失败原因摘要，可展开详情查看记录');
  });
  it('与收口句只差一个字的错误不被误认（zh）', () => {
    expect(getToolStatusLabel(denied('这一步等你确认超过 24 小时，已自动作废，没有执行'), 'error', zh)).toBe('执行失败 · 暂无失败原因摘要，可展开详情查看记录');
  });
  it('与收口句只差一个字的错误不被误认（en，仍读原文）', () => {
    const nearMiss = '这一步等你确认超过 24 小时，已自动作废，没有执行';
    expect(getToolStatusLabel(denied(nearMiss), 'error', en)).toBe('Execution failed · No failure summary is available; expand the details to inspect the record');
  });
});
