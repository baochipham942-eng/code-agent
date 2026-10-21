// ============================================================================
// taskManagerEventPersistence - agent 事件落库聚合（自 TaskManager.ts 拆出）
// ============================================================================

import type { AgentEvent, Message, MessageSnapshotData, ToolCall } from '../../shared/contract';
import { MessageDeltaAccumulator } from '../protocol/messageDeltaAccumulator';
import { createLogger } from '../services/infra/logger';
import {
  closeBackgroundRunAtTerminal,
  settleBackgroundOnTaskComplete,
  trackBackgroundRunTerminalError,
  type BackgroundRunErrorRecord,
} from './backgroundTaskTerminal';

const logger = createLogger('TaskManager');
const CONTEXT_ASSEMBLY_PERSISTED_MESSAGE = Symbol.for('code-agent.contextAssembly.persistedMessage');

function wasMessagePersistedByContextAssembly(message: Message): boolean {
  // marker 标记（同 systemContextStack.ts）：以 symbol 键读取，显式收窄到 symbol 索引类型而非 any
  return Boolean((message as unknown as Record<symbol, unknown>)[CONTEXT_ASSEMBLY_PERSISTED_MESSAGE]);
}

export interface TurnState {
  messageId: string;
  turnId?: string;
  toolCalls: ToolCall[];
  content: string;
  reasoning?: string;
}

export interface TaskManagerEventPersistenceDeps {
  turnStateBySession: Map<string, TurnState>;
  backgroundPermissionOwners: Map<string, string>;
  backgroundRunTerminalErrors: Map<string, BackgroundRunErrorRecord>;
  messageDeltaAccumulator: MessageDeltaAccumulator;
}

/**
 * Persist agent events to session storage (moved from createAgentRuntime.ts, then TaskManager.ts)
 * Handles message aggregation, tool call results, and desktop notifications.
 */
export async function persistTaskManagerEvent(
  deps: TaskManagerEventPersistenceDeps,
  sessionId: string,
  event: AgentEvent,
  snapshot?: MessageSnapshotData | null,
  eventKey = sessionId,
): Promise<void> {
  try {
    const { getSessionManager, notificationService } = await import('../services');

    const sessionManager = getSessionManager();

    if (event.type === 'turn_start') {
      deps.turnStateBySession.set(eventKey, {
        messageId: '',
        turnId: event.data.turnId,
        toolCalls: [],
        content: '',
      });
    }

    if (event.type === 'message_delta' && event.data.role === 'assistant') {
      let turnState = deps.turnStateBySession.get(eventKey);
      if (!turnState) {
        turnState = {
          messageId: '',
          turnId: event.data.turnId,
          toolCalls: [],
          content: '',
        };
        deps.turnStateBySession.set(eventKey, turnState);
      }
      if (event.data.turnId && !turnState.turnId) turnState.turnId = event.data.turnId;
      if (event.data.path === 'reasoning') {
        turnState.reasoning = event.data.op === 'replace'
          ? event.data.text
          : (turnState.reasoning || '') + event.data.text;
      } else {
        turnState.content = event.data.op === 'replace'
          ? event.data.text
          : turnState.content + event.data.text;
      }
    }

    // Aggregate assistant messages within a single turn
    if (event.type === 'message' && event.data?.role === 'assistant') {
      const message = event.data;

      let turnState = deps.turnStateBySession.get(eventKey);
      if (!turnState) {
        turnState = { messageId: '', toolCalls: [], content: '' };
        deps.turnStateBySession.set(eventKey, turnState);
      }

      if (message.toolCalls && message.toolCalls.length > 0) {
        turnState.toolCalls.push(...message.toolCalls);
      }

      turnState.content = message.content || snapshot?.content || turnState.content;
      turnState.reasoning = message.reasoning || snapshot?.reasoning || turnState.reasoning;

      if (!turnState.messageId) {
        turnState.messageId = message.id;
        if (!wasMessagePersistedByContextAssembly(message)) {
          await sessionManager.addMessageToSession(sessionId, {
            ...message,
            toolCalls: turnState.toolCalls.length > 0 ? [...turnState.toolCalls] : undefined,
            content: turnState.content,
            reasoning: turnState.reasoning,
          });
        }
      } else {
        await sessionManager.updateMessage(turnState.messageId, {
          toolCalls: turnState.toolCalls.length > 0 ? [...turnState.toolCalls] : undefined,
          content: turnState.content,
          reasoning: turnState.reasoning,
        });
      }
    }

    // Update tool call results
    if (event.type === 'tool_call_end' && event.data) {
      const turnState = deps.turnStateBySession.get(eventKey);
      const toolCallId = event.data.toolCallId;

      if (turnState?.messageId) {
        const idx = turnState.toolCalls.findIndex((tc) => tc.id === toolCallId);
        if (idx !== -1) {
          turnState.toolCalls[idx] = { ...turnState.toolCalls[idx], result: event.data };
        }
        await sessionManager.updateMessage(turnState.messageId, {
          toolCalls: [...turnState.toolCalls],
        });
      }
    }

    // Reset turn state when turn ends or agent completes
    if (event.type === 'turn_end' || event.type === 'agent_complete' || event.type === 'agent_cancelled') {
      deps.turnStateBySession.delete(eventKey);
      deps.messageDeltaAccumulator.clear(eventKey);
    }

    // Send desktop notification on permission request (needs user input)
    if (event.type === 'permission_request' && event.data) {
      const req = event.data as { tool?: string; command?: string; resolved?: boolean };
      if (!req.resolved) {
        if (eventKey !== sessionId && 'id' in event.data && typeof event.data.id === 'string') {
          deps.backgroundPermissionOwners.set(event.data.id, eventKey);
        }
        notificationService.notifyNeedsInput({
          sessionId,
          title: '需要授权',
          body: req.tool ? `${req.tool}: ${req.command || '请求执行权限'}` : '请求执行权限',
        });
      }
    }

    // task_complete 收口 + 后台条目终态收线（逻辑在 backgroundTaskTerminal：本文件贴
    // effective-line 硬限；task_complete 与 agent 终态两收口点共用 running-guard 幂等）。
    if (event.type === 'task_complete' && event.data) {
      await settleBackgroundOnTaskComplete(sessionId, eventKey, event.data);
    }
    // run 级终态 error 记账（可恢复 error 不记）；agent 终态到点仍 running → 收线（r4 决策表见 backgroundTaskTerminal）。
    if (event.type === 'error' && eventKey === sessionId) {
      trackBackgroundRunTerminalError(deps.backgroundRunTerminalErrors, sessionId, event.data);
    }
    if ((event.type === 'agent_complete' || event.type === 'agent_cancelled') && eventKey === sessionId) {
      await closeBackgroundRunAtTerminal(sessionId, event.type, deps.backgroundRunTerminalErrors);
    }
  } catch (error) {
    logger.error(`Failed to persist event for session ${sessionId}`, error);
  }
}
