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

type MessageSenderKind = 'user' | 'orchestrator' | 'peer-agent' | 'dependency';

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

/**
 * 不可信度排序（ADR-067 D3「取最不可信者」）：peer-agent 最不可信，user 最可信。
 * 一轮同时 drain 到多种来源时，权限判定按链上最不可信的那条处理。
 */
const UNTRUST_RANK: Record<MessageSenderKind, number> = {
  'peer-agent': 0,
  dependency: 1,
  orchestrator: 2,
  user: 3,
};

/** 从 turn 的 origin 链挑出最不可信者；空链/缺省返回 undefined（不升档，保持现状语义）。 */
export function pickLeastTrustedOrigin(
  origins: readonly AgentMessageOrigin[] | undefined,
): AgentMessageOrigin | undefined {
  if (!origins || origins.length === 0) return undefined;
  return origins.reduce((least, origin) =>
    UNTRUST_RANK[origin.senderKind] < UNTRUST_RANK[least.senderKind] ? origin : least);
}

/**
 * ADR-067 D3：主代理常规用户输入铸 user 起源（维度补齐，行为不变——user 不升档）。
 * cron/heartbeat 等机器唤醒 run 的会话本身已被标无人值守，判定由无人值守闸接管。
 */
export function mintUserTurnOrigin(ids: {
  sessionId?: string;
  runId?: string;
  turnId?: string;
}): AgentMessageOrigin[] {
  return [{ senderKind: 'user', ...ids }];
}

/**
 * 子代理 loop drain 注入时收集本轮 origin 链（ADR-067 D3）。
 * shutdown_request 不注入上下文，不计入；存量无 origin 的消息经 resolveMessageOrigin
 * 从严视同 peer-agent。本轮回空（无注入）返回 undefined，调用方保持上一轮的链
 * （peer 指令的影响跨 iteration 持续，直到下一条新输入到达）。
 */
export function collectTurnOrigins(
  pendingMessages: readonly AgentMessage[],
): AgentMessageOrigin[] | undefined {
  const origins = pendingMessages
    .filter((message) => message.type !== 'shutdown_request')
    .map((message) => resolveMessageOrigin(message.origin));
  return origins.length > 0 ? origins : undefined;
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
 * 工具入队点铸造：身份只取宿主持有的 ToolContext 字段，发送方参数不得自报来源。
 *
 * 判据是 `ctx.spawnDepth`：只有子代理管线（subagentExecutor → toolExecutor options）
 * 才设置它（spawn 链 ≥1），主循环（toolExecutionEngine）从不传。
 * 不能用 `ctx.subagent`——shadowAdapter.buildProtocolContext 对每次工具调用（含主
 * 代理）都构造 subagent 对象（legacyCtx 必填、永远有值），Boolean(ctx.subagent) 恒真；
 * `ctx.subagent?.agentName` 也不行——toolExecutor 构造的 legacy ctx 从不写 agentName，
 * 经 legacy 桥时该字段恒 undefined，会把 peer 误判成 orchestrator（洗白方向）。
 */
export function mintToolMessageOrigin(
  ctx: Pick<ToolContext, 'agentId' | 'sessionId' | 'runId' | 'turnId' | 'spawnDepth' | 'swarmRunScope'>,
): AgentMessageOrigin {
  const isPeerAgent = ctx.spawnDepth !== undefined;
  return {
    senderKind: isPeerAgent ? 'peer-agent' : 'orchestrator',
    ...(isPeerAgent && ctx.agentId ? { senderAgentId: ctx.agentId } : {}),
    sessionId: ctx.sessionId,
    runId: ctx.swarmRunScope?.runId ?? ctx.runId,
    turnId: ctx.turnId,
  };
}
