// ============================================================================
// Phase 3: Agent Runtime - TaskManager + Channel Bridge
//
// Per-session model: TaskManager is the sole owner of AgentOrchestrator
// instances. No global orchestrator is created here.
// ============================================================================

import { createLogger } from '../services/infra/logger';
import type { ConfigService } from '../services';
import { getTaskManager } from '../task';
import { initChannelAgentBridge } from '../channels/channelAgentBridge';
import { getChannelManager } from '../channels';
import { getMainWindow } from './window';
// Event channel constant (post-IPC_CHANNELS deprecation)
const AGENT_EVENT_CHANNEL = 'agent:event';

const logger = createLogger('Bootstrap:AgentRuntime');

/**
 * Initialize TaskManager and Channel Agent Bridge.
 *
 * No global AgentOrchestrator is created — TaskManager creates per-session
 * instances on demand (via getOrCreateOrchestrator).
 */
export function createAgentRuntime(configService: ConfigService): void {
  const mainWindow = getMainWindow();

  // Initialize TaskManager as the sole orchestrator owner
  const taskManager = getTaskManager();
  taskManager.initialize({
    configService,
    planningService: undefined, // Will be set after planningService is initialized
    onAgentEvent: (sessionId, event) => {
      // Forward events to renderer with sessionId
      if (mainWindow) {
        mainWindow.webContents.send(AGENT_EVENT_CHANNEL, { ...event, sessionId });
      }
    },
  });
  logger.info('TaskManager initialized (sole orchestrator owner)');

  // Initialize Channel Agent Bridge (multi-channel access: HTTP API, Feishu, etc.)
  // Channel bridge gets orchestrator from TaskManager's current session
  const channelBridge = initChannelAgentBridge({
    getOrchestrator: () => taskManager.getOrchestrator() ?? null,
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
}
