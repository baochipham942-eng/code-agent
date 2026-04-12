// ============================================================================
// Protocol — Event Bus 事件分类层
// 参考 Claude Code Agent SDK ccVersion 2.1.63 的 16 种 hook event 命名 +
// Codex codex-protocol EventMsg enum 的 SQE/EQE 模式
// ============================================================================
//
// 设计动机：
// - AgentEvent discriminated union 定义在 src/shared/contract/agent.ts（跨进程契约）
// - 但"哪些事件可批、哪些必须立即派发、哪些是生命周期拐点"属于 main 内部策略
// - 这类分类信息之前散落在 agent/eventBatcher.ts，现统一到 protocol 层
// - 这样 main 内部任何模块想订阅事件、过滤事件、做指标统计，都从 protocol 里拿分类
//
// 下一阶段（P0-5）：把 hook event 生命周期（Pre/Post/SubagentStart/PreCompact 等）
// 和 AgentEvent 的运行时流式事件统一到同一个发布订阅 bus，彻底替换 eventBatcher。
// ============================================================================

import type { AgentEvent } from '@shared/contract';

export type { AgentEvent };

// ----------------------------------------------------------------------------
// Hook Event 名称 — 参考 Claude Code ccVersion 2.1.63 的 16 种事件
// 作为未来 hook 系统的事件字典，当前仅作为命名字典和占位
// ----------------------------------------------------------------------------

export const HOOK_EVENTS = {
  // 工具生命周期
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',

  // 用户交互
  UserPromptSubmit: 'UserPromptSubmit',
  Notification: 'Notification',

  // 会话生命周期
  SessionStart: 'SessionStart',
  SessionEnd: 'SessionEnd',
  Stop: 'Stop',

  // Subagent 生命周期
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',

  // 上下文压缩
  PreCompact: 'PreCompact',

  // 权限
  PermissionRequest: 'PermissionRequest',

  // 配置 / 初始化
  Setup: 'Setup',
  ConfigChange: 'ConfigChange',

  // 多 Agent 协作
  TeammateIdle: 'TeammateIdle',
  TaskCompleted: 'TaskCompleted',
} as const;

export type HookEventName = (typeof HOOK_EVENTS)[keyof typeof HOOK_EVENTS];

// ----------------------------------------------------------------------------
// AgentEvent 类型白名单 — 从 shared/contract/agent.ts 的 discriminated union
// 提炼出的事件 type 字符串集合，供 eventBatcher / 订阅过滤器使用
// ----------------------------------------------------------------------------

export type AgentEventType = AgentEvent['type'];

/**
 * 高频流式事件：可合并、可延迟 16ms 批量发送
 * 对应 CC 的 "中间产物" 语义（stream chunk / reasoning delta）
 */
export const BATCHABLE_EVENT_TYPES = new Set<AgentEventType>([
  'stream_chunk',
  'stream_tool_call_delta',
]);

/**
 * 立即派发事件：关键生命周期拐点，不得延迟
 * 对应 CC 的 hook event 语义（每个 tool use 前后、turn 开始结束）
 */
export const IMMEDIATE_EVENT_TYPES = new Set<AgentEventType>([
  'message',
  'error',
  'permission_request',
  'agent_complete',
  'turn_start',
  'turn_end',
  'tool_call_start',
  'tool_call_end',
  'budget_exceeded',
]);

// ----------------------------------------------------------------------------
// 事件分类谓词
// ----------------------------------------------------------------------------

/** 是否为流式中间产物（UI 可选择节流渲染） */
export function isStreamingEvent(type: AgentEventType): boolean {
  return (
    type === 'stream_chunk' ||
    type === 'stream_reasoning' ||
    type === 'stream_tool_call_start' ||
    type === 'stream_tool_call_delta' ||
    type === 'stream_usage' ||
    type === 'stream_token_estimate'
  );
}

/** 是否为工具执行相关事件 */
export function isToolEvent(type: AgentEventType): boolean {
  return (
    type === 'tool_call_start' ||
    type === 'tool_call_end' ||
    type === 'tool_progress' ||
    type === 'tool_timeout' ||
    type === 'tool_call_local'
  );
}

/** 是否为上下文压缩相关事件 */
export function isCompactionEvent(type: AgentEventType): boolean {
  return (
    type === 'context_compressed' ||
    type === 'context_compacting' ||
    type === 'context_compacted'
  );
}

/** 是否为 Turn 生命周期事件 */
export function isTurnLifecycleEvent(type: AgentEventType): boolean {
  return type === 'turn_start' || type === 'turn_end' || type === 'agent_complete';
}

/** 是否为中断相关事件（Claude Code interrupt 语义） */
export function isInterruptEvent(type: AgentEventType): boolean {
  return (
    type === 'interrupt_start' ||
    type === 'interrupt_acknowledged' ||
    type === 'interrupt_complete'
  );
}
