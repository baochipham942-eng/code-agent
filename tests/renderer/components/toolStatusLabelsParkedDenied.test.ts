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

// 停车审批被自动收口后，台账 denied 结果的步骤头读作「未执行 · 原因」，不是「执行失败」。
describe('停车审批 denied 结果的步骤状态词', () => {
  const reasons = [
    describeParkedApprovalClosure('args_unavailable'),
    describeParkedApprovalClosure('args_unavailable', 'working_directory_unavailable'),
    describeParkedApprovalClosure('expired_after_restart_24h'),
  ];
  it.each(reasons)('%s → 未执行 · 原因', (reason) => {
    expect(getToolStatusLabel(denied(reason), 'error', zh)).toBe(`未执行 · ${reason}`);
    expect(getToolStatusLabel(denied(reason), 'error', en)).toBe(`Not run · ${reason}`);
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
  it('与收口句只差一个字的错误不被误认', () => {
    expect(getToolStatusLabel(denied('这一步等你确认超过 24 小时，已自动作废，没有执行'), 'error', zh)).toBe('执行失败 · 暂无失败原因摘要，可展开详情查看记录');
  });
});
