// ============================================================================
// Agent Inbox — 统一查询门面（swarm 护栏 P1-2 #4）
// ============================================================================
//
// 背景：子代理的待办消息散落在三套割裂的源里——
//   1. SpawnGuard.messageQueue（单 spawn 路径，AgentMessage）
//   2. ParallelAgentCoordinator.messageQueues（并行路径，AgentMessage）
//   3. TeammateService.inbox（teammate 协作，TeammateMessage，结构不同）
// 子代理拿不到完整待办视图，编排层也难统一处理。
//
// 方案：**桥接而非合并**（合并三套底层存储要改所有写入点 + 类型映射，回归面大）。
// 这里只提供一个只读门面 peekUnifiedInbox：按 agentId 聚合三源、归一化成统一结构、
// 按时间戳排序。各源的写入与 drain 链路完全不动——SpawnGuard.drainMessages /
// Coordinator.drainMessages / TeammateService.markRead 仍是各自的消费入口。
// ============================================================================

import type { AgentMessage } from './spawnGuard';
import { getSpawnGuard } from './spawnGuard';
import type { TeammateMessage } from './teammate/types';
import { getParallelAgentCoordinator } from './parallelAgentCoordinator';
import { getTeammateService } from './teammate/teammateService';

/** 统一 inbox 消息来源标签。 */
export type UnifiedInboxSource = 'spawn-guard' | 'coordinator' | 'teammate';

/** 三源归一化后的统一消息结构。 */
export interface UnifiedInboxMessage {
  source: UnifiedInboxSource;
  /** 消息类型（AgentMessageType 或 TeammateMessageType，原样透传字符串）。 */
  type: string;
  /** 发送方标识。 */
  from: string;
  /** 文本载荷（AgentMessage.payload 或 TeammateMessage.content）。 */
  payload: string;
  /** ms epoch 时间戳。 */
  timestamp: number;
  /** 原始消息，保留各源完整结构供高级消费者使用。 */
  raw: AgentMessage | TeammateMessage;
}

/**
 * 三源的最小只读接口。桥接只依赖非破坏性读方法，不触碰各源的写入 / drain。
 * 全部可选——缺哪个源就跳过哪个（便于测试注入与渐进接入）。
 */
export interface InboxSources {
  spawnGuard?: { peekMessages(id: string): AgentMessage[] };
  coordinator?: { peekMessages(id: string): AgentMessage[] };
  teammateService?: { getInbox(id: string): TeammateMessage[] };
}

function fromAgentMessage(
  source: UnifiedInboxSource,
  m: AgentMessage,
): UnifiedInboxMessage {
  return {
    source,
    type: m.type,
    from: m.from,
    payload: m.payload,
    timestamp: m.timestamp,
    raw: m,
  };
}

function fromTeammateMessage(m: TeammateMessage): UnifiedInboxMessage {
  return {
    source: 'teammate',
    type: m.type,
    from: m.from,
    payload: m.content,
    timestamp: m.timestamp,
    raw: m,
  };
}

/**
 * 非破坏性聚合某 agentId 在三源中的全部待办消息，按时间戳升序返回。
 * 只读——不消费任何源；要真正取走消息仍走各源原有的 drain / markRead。
 */
export function peekUnifiedInbox(
  agentId: string,
  sources: InboxSources,
): UnifiedInboxMessage[] {
  const merged: UnifiedInboxMessage[] = [];

  if (sources.spawnGuard) {
    for (const m of sources.spawnGuard.peekMessages(agentId)) {
      merged.push(fromAgentMessage('spawn-guard', m));
    }
  }
  if (sources.coordinator) {
    for (const m of sources.coordinator.peekMessages(agentId)) {
      merged.push(fromAgentMessage('coordinator', m));
    }
  }
  if (sources.teammateService) {
    for (const m of sources.teammateService.getInbox(agentId)) {
      merged.push(fromTeammateMessage(m));
    }
  }

  return merged.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * 便捷封装：用进程内三个单例（SpawnGuard / ParallelAgentCoordinator / TeammateService）
 * 作为源聚合某 agentId 的统一 inbox。生产消费入口；测试用 peekUnifiedInbox 注入 fake。
 */
export function peekAgentInbox(agentId: string): UnifiedInboxMessage[] {
  return peekUnifiedInbox(agentId, {
    spawnGuard: getSpawnGuard(),
    coordinator: getParallelAgentCoordinator(),
    teammateService: getTeammateService(),
  });
}
