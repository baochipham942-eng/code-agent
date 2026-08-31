// ============================================================================
// P3 钉顶行布局的纯函数（无 Ink 依赖，可单测）
// 全屏动态块（height=终端行高）内，live 消息区的高度预算分配：
// 每条消息的行成本精确可算（markdown 已按宽度 reflow），从最新往最旧分配，
// 最旧一条按剩余预算截尾。保证 live 内容 ≤ 容器高度——
// Ink v7 overflowY:hidden 对负偏移子节点有裁剪缺陷（P1 实测帧重叠），
// 所以靠预算分配杜绝溢出，而不是依赖裁剪。
// ============================================================================

import { isSettledMessage, type ChatMessage } from './events';
import { markdownLineCount } from './markdown';
import { computeWindow, displayWidth, visualRowCount, type EditorState } from './editorState';

/** 每条消息占用的视觉行数（含 MessageView 的 marginTop 2 行；user/assistant 另 + paddingBottom 1） */
export function messageLineCost(message: ChatMessage, width: number): number {
  switch (message.kind) {
    case 'assistant':
      return markdownLineCount(message.text, width) + 3;
    case 'thinking': {
      // 运行中：标题 1 行 + 尾部 ≤3 行；完成：单行折叠
      if (message.endedAt !== undefined) return 3;
      const lines = message.text.split('\n').filter((line) => line.trim().length > 0).length;
      return 1 + Math.min(3, lines) + 2;
    }
    case 'tool_group': {
      // 归组单行；单个调用 1 行（+错误预览 1 行）
      const single = message.calls.length <= 1;
      const hasErrorPreview = single && message.status === 'error' && message.calls[0]?.resultPreview;
      return 1 + (hasErrorPreview ? 1 : 0) + 2;
    }
    case 'system': {
      const w = Math.max(width, 8);
      const lines = Math.max(1, Math.ceil(displayWidth(message.text) / w));
      return lines + 2;
    }
    case 'user': {
      const w = Math.max(width - 2, 8);
      return Math.max(1, Math.ceil(displayWidth(message.text) / w)) + 3;
    }
    default:
      return 3;
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
// 全屏钉底布局（2026-08-31 用户实测决策：对标 Grok 全屏零噪音首屏——
// 输入区钉在屏幕底部，留白在内容之上；取代 2026-08-30 的紧凑流式，
// 紧凑把留白留在输入框之下，首屏上半截拥挤下半截空，利用率低）。
// 动态块恒等于终端行高；live 消息预算分配（最新优先、最旧截尾）杜绝溢出，
// 不依赖 Ink v7 裁剪（overflowY:hidden 负偏移子节点裁剪缺陷的护栏保留）。
// ---------------------------------------------------------------------------

export interface DynamicLayoutPlan {
  /** 动态块高度（行）：恒等于终端行高 */
  height: number;
  /** messageId → 行预算（从最新往最旧分配，最旧一条截尾） */
  allocation: Map<string, number>;
}

export function planDynamicLayout(
  messages: ChatMessage[],
  width: number,
  rows: number,
  chromeRows: number,
): DynamicLayoutPlan {
  const liveBudget = Math.max(0, rows - chromeRows);
  return { height: rows, allocation: allocateLiveBudget(messages, width, liveBudget) };
}

/**
 * Static 与 live 互斥：还在视口预算里的消息只渲染一次（live）。
 * 被预算挤出的已封口消息才进 Static scrollback。
 * 先前「封口前缀全进 Static + live 再画一遍」会在中间撑出一块空，上下各一份正文。
 */
export function partitionScrollback(
  messages: ChatMessage[],
  allocation: Map<string, number>,
): { scrollback: ChatMessage[]; live: ChatMessage[] } {
  const live = messages.filter((message) => allocation.has(message.id));
  const liveIds = new Set(live.map((message) => message.id));
  const scrollback = messages.filter((message) => isSettledMessage(message) && !liveIds.has(message.id));
  return { scrollback, live };
}
