// ============================================================================
// Phase 3: Agent Runtime - Orchestrator, TaskManager, Channel Bridge
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { ConfigService, getSessionManager, notificationService } from '../services';
import { AgentOrchestrator } from '../agent/agentOrchestrator';
import { getTaskManager } from '../task';
import { initChannelAgentBridge } from '../channels/channelAgentBridge';
import { getChannelManager } from '../channels';
import { getMainWindow } from './window';
// Event channel constant (post-IPC_CHANNELS deprecation)
const AGENT_EVENT_CHANNEL = 'agent:event';
import type { ToolCall } from '../../shared/types';

const logger = createLogger('Bootstrap:AgentRuntime');

/**
 * Create and initialize the AgentOrchestrator with event handling,
 * TaskManager, and Channel Agent Bridge.
 */
export function createAgentRuntime(configService: ConfigService): AgentOrchestrator {
  const mainWindow = getMainWindow();

  // Track current assistant message for aggregating multiple messages in a turn
  // Use a Map to support multiple concurrent sessions
  const turnStateBySession = new Map<string, {
    messageId: string;
    toolCalls: ToolCall[];
    content: string;
  }>();

  const agentOrchestrator = new AgentOrchestrator({
    configService,
    onEvent: async (event) => {
      logger.debug('onEvent called', { eventType: event.type });
      if (mainWindow) {
        logger.debug('Sending event to renderer', { eventType: event.type });
        mainWindow.webContents.send(AGENT_EVENT_CHANNEL, event);
      } else {
        logger.warn('mainWindow is null, cannot send event');
      }

      const eventWithSession = event as typeof event & { sessionId?: string };
      const sessionId = eventWithSession.sessionId;

      if (!sessionId) {
        logger.warn('No sessionId in event, skipping message persistence');
        return;
      }

      const sessionManager = getSessionManager();

      // Aggregate assistant messages within a single turn
      if (event.type === 'message' && event.data?.role === 'assistant') {
        const message = event.data;

        let turnState = turnStateBySession.get(sessionId);
        if (!turnState) {
          turnState = { messageId: '', toolCalls: [], content: '' };
          turnStateBySession.set(sessionId, turnState);
        }

        if (message.toolCalls && message.toolCalls.length > 0) {
          turnState.toolCalls.push(...message.toolCalls);
        }

        if (message.content) {
          turnState.content = message.content;
        }

        try {
          if (!turnState.messageId) {
            turnState.messageId = message.id;
            await sessionManager.addMessage({
              ...message,
              toolCalls: turnState.toolCalls.length > 0 ? [...turnState.toolCalls] : undefined,
              content: turnState.content,
            });
          } else {
            await sessionManager.updateMessage(turnState.messageId, {
              toolCalls: turnState.toolCalls.length > 0 ? [...turnState.toolCalls] : undefined,
              content: turnState.content,
            });
          }
        } catch (error) {
          logger.error('Failed to save/update assistant message', error);
        }
      }

      // Update tool call results
      if (event.type === 'tool_call_end' && event.data) {
        const turnState = turnStateBySession.get(sessionId);
        const toolCallId = event.data.toolCallId;

        if (!turnState) {
          logger.warn('tool_call_end: turnState not found', { sessionId, toolCallId });
        } else if (!turnState.messageId) {
          logger.warn('tool_call_end: messageId not set', { sessionId, toolCallId });
        } else {
          try {
            const idx = turnState.toolCalls.findIndex((tc) => tc.id === toolCallId);
            if (idx !== -1) {
              turnState.toolCalls[idx] = { ...turnState.toolCalls[idx], result: event.data };
              logger.debug('tool_call_end: updated result', { toolCallId, idx, hasOutput: !!event.data.output });
            } else {
              logger.warn('tool_call_end: toolCall not found in turnState', {
                toolCallId,
                availableIds: turnState.toolCalls.map(tc => tc.id),
              });
            }

            await sessionManager.updateMessage(turnState.messageId, {
              toolCalls: [...turnState.toolCalls],
            });
          } catch (error) {
            logger.error('Failed to update tool call result', error);
          }
        }
      }

      // Reset turn state when turn ends or agent completes
      if (event.type === 'turn_end' || event.type === 'agent_complete') {
        turnStateBySession.delete(sessionId);
      }

      // Send desktop notification on task complete
      if (event.type === 'task_complete' && event.data) {
        try {
          const session = await sessionManager.getSession(sessionId);
          if (session) {
            notificationService.notifyTaskComplete({
              sessionId: session.id,
              sessionTitle: session.title,
              summary: event.data.summary,
              duration: event.data.duration,
              toolsUsed: event.data.toolsUsed || [],
            });
          }
        } catch (error) {
          logger.error('Failed to send task complete notification', error);
        }
      }
    },
  });

  // Initialize TaskManager
  const taskManager = getTaskManager();
  taskManager.initialize({
    configService,
    planningService: undefined, // Will be set after planningService is initialized
    onAgentEvent: (sessionId, event) => {
      if (mainWindow) {
        mainWindow.webContents.send(AGENT_EVENT_CHANNEL, { ...event, sessionId });
      }
    },
  });
  logger.info('TaskManager initialized');

  // Initialize Channel Agent Bridge (multi-channel access: HTTP API, Feishu, etc.)
  const channelBridge = initChannelAgentBridge({
    getOrchestrator: () => agentOrchestrator,
    configService,
  });
  channelBridge.initialize()
    .then(() => {
      const channelManager = getChannelManager();
      logger.info('Channel Agent Bridge initialized', {
        pluginCount: channelManager.getRegisteredPlugins().length,
        accountCount: channelManager.getAllAccounts().length,
      });
    })
    .catch((error) => {
      logger.error('Channel Agent Bridge failed to initialize (non-blocking)', error);
    });

  return agentOrchestrator;
}
