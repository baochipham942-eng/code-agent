// ============================================================================
// Phase 3: Agent Runtime - TaskManager + Channel Bridge
//
// Per-session model: TaskManager is the sole owner of AgentOrchestrator
// instances. No global orchestrator is created here.
// ============================================================================

import { createLogger } from '../services/infra/logger';
import type { ConfigService } from '../services';
import type { AgentEventEnvelope } from '../../shared/contract';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getTaskManager } from '../task';
import { initChannelAgentBridge } from '../channels/channelAgentBridge';
import { initApprovalFeishuRelay } from '../channels/feishu/approvalFeishuRelay';
import { getChannelManager } from '../channels';
import { getMainWindow } from './window';
import { EventBatcher } from '../agent/eventBatcher';
import type { RunRegistry } from '../runtime/runRegistry';

const logger = createLogger('Bootstrap:AgentRuntime');

type RendererAgentEvent = AgentEventEnvelope & { sessionId: string };

const rendererEventSequences = new Map<string, number>();

function nextRendererEventSeq(sessionId: string): number {
  const next = (rendererEventSequences.get(sessionId) || 0) + 1;
  rendererEventSequences.set(sessionId, next);
  return next;
}

/**
 * Initialize TaskManager and Channel Agent Bridge.
 *
 * No global AgentOrchestrator is created — TaskManager creates per-session
 * instances on demand (via getOrCreateOrchestrator).
 */
export function createAgentRuntime(configService: ConfigService, runRegistry?: RunRegistry): void {
  const mainWindow = getMainWindow();
  const rendererEventBatcher = new EventBatcher<RendererAgentEvent>({
    flushInterval: 16,
    maxBatchSize: 50,
    onFlush: (events) => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      const sequencedEvents = events.map((event) => ({
        ...event,
        seq: nextRendererEventSeq(event.sessionId),
      }));
      if (sequencedEvents.length === 1) {
        mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT, sequencedEvents[0]);
        return;
      }
      mainWindow.webContents.send(IPC_CHANNELS.AGENT_EVENT_BATCH, sequencedEvents);
    },
  });

  // Initialize TaskManager as the sole orchestrator owner
  const taskManager = getTaskManager();
  taskManager.initialize({
    configService,
    runRegistry,
    planningService: undefined, // Will be set after planningService is initialized
    onAgentEvent: (sessionId, event) => {
      // Forward events to renderer with sessionId
      rendererEventBatcher.emit({ ...event, sessionId });
    },
  });
  logger.info('TaskManager initialized (sole orchestrator owner)');

  // Initialize Channel Agent Bridge (multi-channel access: HTTP API, Feishu, etc.)
  const channelBridge = initChannelAgentBridge({
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

  // B3: 无人值守审批停车 → 飞书卡片镜像 + 按钮回批。订阅进程内事件，没配飞书零影响。
  initApprovalFeishuRelay();
}
