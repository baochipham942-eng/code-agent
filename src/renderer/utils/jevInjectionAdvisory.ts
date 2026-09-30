// ============================================================================
// jevInjectionAdvisory - 决策槽 advisory 纯函数（N-JEV-INJECT-LAYER-MOCK 验收①）
// ============================================================================
// 当前轮有工具结果带 metadata.jevInjectionScan.flagged=true 时，权限卡上方加一行
// 「远端内容疑似注入」提示。语义对齐 CLI 侧（src/cli/tui-app/events.ts 的
// jevInjectionAdvisory）：只提示，绝不参与放行/拒绝判定。
// 「当前轮」= 最后一条非 runtimeSteer 用户消息之后的尾随段；runtimeSteer 用户消息
// 按 contract 约定不开新一轮（MessageMetadata.runtimeSteer），不算轮边界。
// ============================================================================

import type { Message, ToolResult } from '@shared/contract';

function isJevFlagged(result: ToolResult): boolean {
  const scan = result.metadata?.jevInjectionScan;
  if (!scan || typeof scan !== 'object') return false;
  return (scan as { flagged?: unknown }).flagged === true;
}

export function hasCurrentTurnJevInjectionFlag(messages: readonly Message[]): boolean {
  let turnStart = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role === 'user' && message.metadata?.runtimeSteer !== true) {
      turnStart = i + 1;
      break;
    }
  }
  for (let i = turnStart; i < messages.length; i++) {
    if (messages[i].toolResults?.some(isJevFlagged)) return true;
  }
  return false;
}
