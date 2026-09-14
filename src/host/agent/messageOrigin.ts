// ============================================================================
// 消息来源铸造（ADR-067 D1 provenance envelope）+ 结构化 Agent 消息协议
// ----------------------------------------------------------------------------
// 发送者身份由宿主在入队点铸造，发送方不得自报：
// - origin 随消息落队；from 字符串降级为展示用，安全/路由消费方一律读 origin
// - 存量无 origin 的消息（旧队列、旧调用方）从严：视同 peer-agent，不许默认成 user
//
// AgentMessage 协议本体也从 spawnGuard 收进本模块（god file 减肥），spawnGuard
// 原样 re-export，既有 import 路径不变。
// ============================================================================

import type { ToolContext } from '../protocol/tools';

export type MessageSenderKind = 'user' | 'orchestrator' | 'peer-agent' | 'dependency';

export interface AgentMessageOrigin {
  senderKind: MessageSenderKind;
  senderAgentId?: string;
  sessionId?: string;
  runId?: string;
  turnId?: string;
}

export type AgentMessageType =
  | 'text'                    // 普通文本（向后兼容）
  | 'shutdown_request'        // 父请求子关闭
  | 'shutdown_response'       // 子同意/拒绝关闭
  | 'plan_approval_request'   // 子提交计划待审
  | 'plan_approval_response'  // 父审批结果
  | 'status_update';          // 进度汇报

export interface AgentMessage {
  /** Stable delivery identity for durable at-least-once mailboxes. */
  id?: string;
  /** Monotonic sequence within one Agent Team tree. */
  seq?: number;
  type: AgentMessageType;
  /** 展示用路由标签（ADR-067：安全/路由消费方一律读 origin，不许读它）。 */
  from: string;
  payload: string;
  timestamp: number;
  /** 宿主在入队点铸造的来源信封；缺失时消费方从严视同 peer-agent。 */
  origin?: AgentMessageOrigin;
}

/** Create a text message (backward compatible shorthand) */
export function createTextMessage(from: string, text: string, origin?: AgentMessageOrigin): AgentMessage {
  return { type: 'text', from, payload: text, timestamp: Date.now(), ...(origin ? { origin } : {}) };
}

/** Create a structured message */
export function createAgentMessage(
  type: AgentMessageType,
  from: string,
  payload: Record<string, unknown>,
  origin?: AgentMessageOrigin
): AgentMessage {
  return { type, from, payload: JSON.stringify(payload), timestamp: Date.now(), ...(origin ? { origin } : {}) };
}

/** 消费方读取 origin：缺失时从严视同 peer-agent（ADR-067 D1，不许默认成 user）。 */
export function resolveMessageOrigin(origin: AgentMessageOrigin | undefined): AgentMessageOrigin {
  return origin ?? { senderKind: 'peer-agent' };
}

/** from 只是展示标签：有 origin 时按 origin 生成诚实标签。 */
export function displayFromForOrigin(origin: AgentMessageOrigin): string {
  switch (origin.senderKind) {
    case 'user':
      return 'user';
    case 'orchestrator':
      return 'orchestrator';
    case 'dependency':
      return 'dependency';
    case 'peer-agent':
      return origin.senderAgentId ?? 'peer-agent';
  }
}

/** 安全/路由消费方取发送者 id：origin 优先；存量无 origin 消息回落 from 展示串。 */
export function originSenderId(origin: AgentMessageOrigin | undefined, fallbackFrom: string): string {
  if (!origin) return fallbackFrom;
  if (origin.senderKind === 'user') return 'user';
  return origin.senderAgentId ?? fallbackFrom;
}

/**
 * 工具入队点铸造：身份只取宿主持有的 ToolContext（ctx.subagent 仅在工具运行于
 * 子代理内时由宿主设置），发送方参数不得自报来源。
 */
export function mintToolMessageOrigin(
  ctx: Pick<ToolContext, 'agentId' | 'sessionId' | 'runId' | 'turnId' | 'subagent' | 'swarmRunScope'>,
): AgentMessageOrigin {
  const isPeerAgent = Boolean(ctx.subagent);
  return {
    senderKind: isPeerAgent ? 'peer-agent' : 'orchestrator',
    ...(isPeerAgent && ctx.agentId ? { senderAgentId: ctx.agentId } : {}),
    sessionId: ctx.sessionId,
    runId: ctx.swarmRunScope?.runId ?? ctx.runId,
    turnId: ctx.turnId,
  };
}
