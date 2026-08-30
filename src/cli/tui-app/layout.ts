// ============================================================================
// P3 钉顶行布局的纯函数（无 Ink 依赖，可单测）
// 全屏动态块（height=终端行高）内，live 消息区的高度预算分配：
// 每条消息的行成本精确可算（markdown 已按宽度 reflow），从最新往最旧分配，
// 最旧一条按剩余预算截尾。保证 live 内容 ≤ 容器高度——
// Ink v7 overflowY:hidden 对负偏移子节点有裁剪缺陷（P1 实测帧重叠），
// 所以靠预算分配杜绝溢出，而不是依赖裁剪。
// ============================================================================

import type { ChatMessage } from './events';
import { markdownLineCount } from './markdown';
import { computeWindow, displayWidth, visualRowCount, type EditorState } from './editorState';

/** 每条消息占用的视觉行数（含 MessageView 的 marginTop 1 行） */
export function messageLineCost(message: ChatMessage, width: number): number {
  switch (message.kind) {
    case 'assistant':
      return markdownLineCount(message.text, width) + 1;
    case 'thinking': {
      // 运行中：标题 1 行 + 尾部 ≤3 行；完成：单行折叠（不会出现在 live 区）
      if (message.endedAt !== undefined) return 2;
      const lines = message.text.split('\n').filter((line) => line.trim().length > 0).length;
      return 1 + Math.min(3, lines) + 1;
    }
    case 'tool_group': {
      // 归组单行；单个调用 1 行（+错误预览 1 行）
      const single = message.calls.length <= 1;
      const hasErrorPreview = single && message.status === 'error' && message.calls[0]?.resultPreview;
      return 1 + (hasErrorPreview ? 1 : 0) + 1;
    }
    case 'system': {
      const w = Math.max(width, 8);
      const lines = Math.max(1, Math.ceil(displayWidth(message.text) / w));
      return lines + 1;
    }
    case 'user': {
      // live 区不出现（提交即 settled），兜底按折行估算
      const w = Math.max(width - 2, 8);
      return Math.max(1, Math.ceil(displayWidth(message.text) / w)) + 1;
    }
    default:
      return 2;
  }
}

/**
 * live 区预算分配：返回 messageId → 允许的最大行数。
 * 从最新往最旧分配；最旧一条只给剩余预算（渲染层截尾）。
 */
export function allocateLiveBudget(
  messages: ChatMessage[],
  width: number,
  budget: number,
): Map<string, number> {
  const allocation = new Map<string, number>();
  let remaining = Math.max(0, budget);
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const message = messages[i];
    const cost = messageLineCost(message, width);
    if (cost <= remaining) {
      allocation.set(message.id, cost);
      remaining -= cost;
    } else {
      allocation.set(message.id, remaining);
      remaining = 0;
    }
  }
  return allocation;
}

/** 编辑器当前实际渲染的视觉行数（与 Editor 组件同一窗口算法） */
export function editorVisualRows(state: EditorState, innerWidth: number, maxRows: number): number {
  const { startRow, endRow } = computeWindow(state.lines, state.cursorRow, innerWidth, maxRows);
  let rows = 0;
  for (let i = startRow; i < endRow; i++) {
    rows += visualRowCount(state.lines[i], innerWidth);
  }
  return Math.max(1, rows);
}
