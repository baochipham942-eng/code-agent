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
 * 模块内私有（生产只经 planDynamicLayout 消费），语义由 layout.test.ts 经
 * planDynamicLayout 钉顶分支覆盖。
 */
function allocateLiveBudget(
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

// ---------------------------------------------------------------------------
// 紧凑流式布局（2026-08-30 用户实测决策：消灭空会话整屏留白）
// 动态块不再恒等于终端行高：内容自然高 ≤ 可用预算时按实际高度（紧凑），
// 超出时回退钉顶满高 + 预算截尾（保留 Ink v7 裁剪缺陷的护栏）。
// ---------------------------------------------------------------------------

export interface DynamicLayoutPlan {
  /** 动态块高度（行）：紧凑 = 内容自然高，钉顶 = rows */
  height: number;
  /** true = 紧凑流式（无截断）；false = 钉顶满高（尾部预算分配） */
  compact: boolean;
  /** messageId → 行预算（紧凑时每条都是全量成本） */
  allocation: Map<string, number>;
}

export function planDynamicLayout(
  messages: ChatMessage[],
  width: number,
  rows: number,
  chromeRows: number,
): DynamicLayoutPlan {
  const full = allocateLiveBudget(messages, width, Number.MAX_SAFE_INTEGER);
  let natural = 0;
  for (const cost of full.values()) natural += cost;
  const liveBudget = Math.max(0, rows - chromeRows);
  if (natural <= liveBudget) {
    return { height: natural + chromeRows, compact: true, allocation: full };
  }
  return { height: rows, compact: false, allocation: allocateLiveBudget(messages, width, liveBudget) };
}
