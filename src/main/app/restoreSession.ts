// ============================================================================
// Phase 4: Session Restoration & Planning Service
// ============================================================================

import { app } from 'electron';
import { createLogger } from '../services/infra/logger';
import { getSessionManager } from '../services';
import { getMemoryService } from '../memory/memoryService';
import { AgentOrchestrator } from '../agent/agentOrchestrator';
import { createPlanningService, type PlanningService } from '../planning';
import { getMainWindow } from './window';
// Event channel constant (post-IPC_CHANNELS deprecation)
const PLANNING_EVENT_CHANNEL = 'planning:event';
import { DEFAULT_MODELS, DEFAULT_PROVIDER, MODEL_MAX_TOKENS } from '../../shared/constants';
import type { PlanningState } from '../../shared/types';

const logger = createLogger('Bootstrap:Session');

/**
 * Auto-restore or create a new session.
 * Returns the current session ID.
 */
export async function initializeSession(
  settings: any,
  agentOrchestrator: AgentOrchestrator,
): Promise<string> {
  const sessionManager = getSessionManager();
  const memoryService = getMemoryService();

  const recentSession = await sessionManager.getMostRecentSession();

  let sessionId: string;

  if (recentSession && settings.session?.autoRestore !== false) {
    const restoredSession = await sessionManager.restoreSession(recentSession.id);
    sessionId = recentSession.id;
    logger.info('Restored session', { sessionId });

    // 同步消息历史到 orchestrator，否则模型看不到之前的对话上下文
    if (restoredSession?.messages?.length) {
      agentOrchestrator.setMessages(restoredSession.messages);
      logger.info('Synced messages to orchestrator', { count: restoredSession.messages.length });
    }
  } else {
    const session = await sessionManager.createSession({
      title: 'New Session',
      generationId: 'gen8',
      modelConfig: {
        provider: settings.model?.provider || DEFAULT_PROVIDER,
        model: settings.model?.model || DEFAULT_MODELS.chat,
        temperature: settings.model?.temperature || 0.7,
        maxTokens: settings.model?.maxTokens || MODEL_MAX_TOKENS.DEFAULT,
      },
      workingDirectory: agentOrchestrator.getWorkingDirectory(),
    });
    sessionManager.setCurrentSession(session.id);
    sessionId = session.id;
    logger.info('Created new session', { sessionId });
  }

  // Set memory service context
  memoryService.setContext(
    sessionId,
    agentOrchestrator.getWorkingDirectory() || undefined
  );

  return sessionId;
}

/**
 * Initialize planning service and attach it to the orchestrator.
 * Returns the planning service instance, or null if not applicable.
 */
export async function initializePlanningService(
  agentOrchestrator: AgentOrchestrator,
  currentSessionId: string,
): Promise<PlanningService | null> {
  const workingDir = agentOrchestrator.getWorkingDirectory();
  logger.debug('initializePlanningService', { workingDir });

  // Fallback to app userData if workingDir is '/' (packaged Electron app issue)
  const effectiveWorkingDir = workingDir && workingDir !== '/'
    ? workingDir
    : app.getPath('userData');

  logger.debug('initializePlanningService', { effectiveWorkingDir });

  if (!effectiveWorkingDir) return null;

  const planningService = createPlanningService(effectiveWorkingDir, currentSessionId);
  logger.info('Planning service initialized', { path: effectiveWorkingDir });

  // Pass planning service to agent orchestrator
  agentOrchestrator.setPlanningService(planningService);

  // Send initial planning state to renderer
  await sendPlanningStateToRenderer(planningService);

  return planningService;
}

/**
 * 发送规划状态到渲染进程
 */
async function sendPlanningStateToRenderer(planningService: PlanningService): Promise<void> {
  const mainWindow = getMainWindow();
  if (!mainWindow) return;

  try {
    const plan = await planningService.plan.read();
    const findings = await planningService.findings.getAll();
    const errors = await planningService.errors.getAll();

    const state: PlanningState = {
      plan,
      findings,
      errors,
    };

    mainWindow.webContents.send(PLANNING_EVENT_CHANNEL, {
      type: 'plan_updated',
      data: state,
    });
  } catch (error) {
    logger.error('Failed to send planning state', error);
  }
}
