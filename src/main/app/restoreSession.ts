// ============================================================================
// Phase 4: Session Restoration & Planning Service
//
// Uses TaskManager to manage orchestrator lifecycle (per-session model).
// ============================================================================

import { app } from '../platform';
import { createLogger } from '../services/infra/logger';
import { getSessionManager } from '../services';
import { getMemoryService } from '../memory/memoryService';
import { getTaskManager } from '../task';
import {
  createPlanningService,
  publishPlanningStateToRenderer,
  type PlanningService,
} from '../planning';
import { buildRecoveredWorkSuggestions } from '../planning/recoveredWorkOrchestrator';
import { DEFAULT_MODELS, DEFAULT_PROVIDER, MODEL_MAX_TOKENS } from '../../shared/constants';
import { getMainWindow } from './window';

const logger = createLogger('Bootstrap:Session');

/**
 * Auto-restore or create a new session.
 * Uses TaskManager to manage the orchestrator for the session.
 * Returns the current session ID.
 */
export async function initializeSession(
  settings: any,
): Promise<string> {
  const sessionManager = getSessionManager();
  const memoryService = getMemoryService();
  const taskManager = getTaskManager();

  const recentSession = await sessionManager.getMostRecentSession();

  let sessionId: string;

  if (recentSession && settings.session?.autoRestore !== false) {
    const restoredSession = await sessionManager.restoreSession(recentSession.id);
    sessionId = recentSession.id;
    logger.info('Restored session', { sessionId });

    // Set current session ID on TaskManager first (so getOrCreateOrchestrator works)
    taskManager.setCurrentSessionId(sessionId);

    // Sync message history via TaskManager's setSessionContext
    if (restoredSession?.messages?.length) {
      taskManager.setSessionContext(sessionId, restoredSession.messages);
      logger.info('Synced messages to orchestrator via TaskManager', { count: restoredSession.messages.length });
    }
  } else {
    // Get working directory from a lazy-created orchestrator
    taskManager.setCurrentSessionId('__bootstrap_pending__');
    const bootstrapOrchestrator = taskManager.getOrCreateCurrentOrchestrator('__bootstrap_pending__');
    const workingDirectory = bootstrapOrchestrator?.getWorkingDirectory();

    const session = await sessionManager.createSession({
      title: 'New Session',
      generationId: 'gen8',
      modelConfig: {
        provider: settings.model?.provider || DEFAULT_PROVIDER,
        model: settings.model?.model || DEFAULT_MODELS.chat,
        temperature: settings.model?.temperature || 0.7,
        maxTokens: settings.model?.maxTokens || MODEL_MAX_TOKENS.DEFAULT,
      },
      workingDirectory,
    });
    sessionManager.setCurrentSession(session.id);
    sessionId = session.id;

    // Clean up bootstrap placeholder and set real session ID
    taskManager.cleanup('__bootstrap_pending__');
    taskManager.setCurrentSessionId(sessionId);

    logger.info('Created new session', { sessionId });
  }

  // Set memory service context
  const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId);
  const workingDirectory = orchestrator?.getWorkingDirectory();

  memoryService.setContext(
    sessionId,
    workingDirectory || undefined
  );

  return sessionId;
}

/**
 * Initialize planning service and attach it to the orchestrator.
 * Uses TaskManager to get the current session's orchestrator.
 * Returns the planning service instance, or null if not applicable.
 */
export async function initializePlanningService(
  currentSessionId: string,
): Promise<PlanningService | null> {
  const taskManager = getTaskManager();
  const orchestrator = taskManager.getOrCreateCurrentOrchestrator(currentSessionId);

  if (!orchestrator) {
    logger.warn('No orchestrator available for planning service initialization');
    return null;
  }

  const workingDir = orchestrator.getWorkingDirectory();
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
  orchestrator.setPlanningService(planningService);

  // Send initial planning state to renderer
  await publishPlanningStateToRenderer(planningService);

  const suggestions = await buildRecoveredWorkSuggestions({
    sessionId: currentSessionId,
    planningService,
  }).catch((error) => {
    logger.debug('Failed to build recovered-work suggestions on session restore', {
      error: String(error),
      sessionId: currentSessionId,
    });
    return [];
  });

  const mainWindow = getMainWindow();
  if (mainWindow && suggestions.length > 0) {
    mainWindow.webContents.send('agent:event', {
      type: 'suggestions_update',
      data: suggestions,
      sessionId: currentSessionId,
    });
  }

  return planningService;
}
