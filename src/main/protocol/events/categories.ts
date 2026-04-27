// ============================================================================
// Protocol — AgentEvent 分类层
// 参考 Codex codex-protocol EventMsg enum 的 SQE/EQE 模式
// ============================================================================
//
// 设计动机：
// - AgentEvent discriminated union 定义在 src/shared/contract/agent.ts（跨进程契约）
// - 但"哪些事件可批、哪些必须立即派发、哪些是生命周期拐点"属于 main 内部策略
// - 这类分类信息统一到 protocol 层，与 EventBus runtime 同包
// - main 内部任何模块想订阅事件、过滤事件、做指标统计，都从 protocol 里拿分类
//
// Hook event 命名字典（HookEvent 类型）见同目录 hookTypes.ts。
// 原 protocol/events.ts 的 HOOK_EVENTS 常量与 hooks/events.ts 重复，
// 已在 P0-5 阶段 +1 统一收敛到 hookTypes.ts。
// ============================================================================

import type { AgentEvent } from '@shared/contract';
import type { SwarmEventType } from '@shared/contract/swarm';

export type { AgentEvent };

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
  'agent_cancelled',
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
  return type === 'turn_start' || type === 'turn_end' || type === 'agent_complete' || type === 'agent_cancelled';
}

/** 是否为中断相关事件（Claude Code interrupt 语义） */
export function isInterruptEvent(type: AgentEventType): boolean {
  return (
    type === 'interrupt_start' ||
    type === 'interrupt_acknowledged' ||
    type === 'interrupt_complete'
  );
}

// ----------------------------------------------------------------------------
// Swarm 事件分类（ADR-008 Phase 1）
// ----------------------------------------------------------------------------
// Swarm 事件类型复用 shared/contract/swarm.ts 的 SwarmEventType，
// EventBus 以 domain='swarm' 发布；type 为去掉 'swarm:' 前缀后的短名称
// （避免 channel 变成 'swarm:swarm:launch:requested'）。
// Phase 1 仅提供分类守卫，Phase 2/3 的 Actor 订阅方使用这些守卫做路由。
// ----------------------------------------------------------------------------

export type { SwarmEventType };

/** 是否为 swarm launch 审批相关事件（Cycle 4 订阅点） */
export function isSwarmLaunchEvent(type: SwarmEventType): boolean {
  return (
    type === 'swarm:launch:requested' ||
    type === 'swarm:launch:approved' ||
    type === 'swarm:launch:rejected'
  );
}

/** 是否为 plan 审批相关事件（Cycle 2 订阅点） */
export function isSwarmPlanEvent(type: SwarmEventType): boolean {
  return (
    type === 'swarm:agent:plan_review' ||
    type === 'swarm:agent:plan_approved' ||
    type === 'swarm:agent:plan_rejected'
  );
}

/** 是否为 swarm agent 生命周期事件（Cycle 1 订阅点） */
export function isSwarmAgentLifecycleEvent(type: SwarmEventType): boolean {
  return (
    type === 'swarm:started' ||
    type === 'swarm:agent:added' ||
    type === 'swarm:agent:updated' ||
    type === 'swarm:agent:completed' ||
    type === 'swarm:agent:failed' ||
    type === 'swarm:completed' ||
    type === 'swarm:cancelled'
  );
}
