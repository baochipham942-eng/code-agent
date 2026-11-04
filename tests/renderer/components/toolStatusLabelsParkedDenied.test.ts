import { describe, expect, it } from 'vitest';
import { getToolStatusLabel } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/statusLabels';
import type { ToolCall } from '../../../src/shared/contract';
import { zh } from '../../../src/renderer/i18n/zh';
import { describeParkedApprovalClosure } from '../../../src/host/agent/parkedApprovalSurvival';

// N-FIX-PARKED-APPROVAL-SURVIVE-RESTART-RESUME-FU1-FU1：停车审批被自动拒绝后，台账 denied 结果
// 渲染出的步骤状态不再是「运行中 / running command…」。
describe('停车审批 denied 结果的步骤状态词', () => {
  const reasons = [
    describeParkedApprovalClosure('args_unavailable'),
    describeParkedApprovalClosure('args_unavailable', 'working_directory_unavailable'),
    describeParkedApprovalClosure('expired_after_restart_24h'),
  ];
  it.each(reasons)('%s → 步骤头不读作运行中（读作执行失败）', (reason) => {
    const call: ToolCall = {
      id: 'c1',
      name: 'Bash',
      arguments: { command: 'sleep 30' },
      result: { toolCallId: 'c1', success: false, error: reason, duration: 0 },
    };
    const label = getToolStatusLabel(call, 'error', zh);
    expect(label).toBeTruthy();
    expect(label).not.toMatch(/running|运行中|正在/);
    // 判断记录：头部状态词当前对未识别的失败原因统一显示通用摘要，句子本身在展开详情里；
    // 本单只要求不再是运行中，不改文案管线（范围外）。
    expect(label).toBe('执行失败 · 暂无失败原因摘要，可展开详情查看记录');
  });
});
