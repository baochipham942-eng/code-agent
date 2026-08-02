import type { Session } from '../../shared/contract';
import type { CreateSessionConfig } from '../../shared/contract/appService';
import { normalizeAgentEngineSession } from '../../shared/contract/agentEngine';
import type { TaskManager } from '../task';
import type { ConfigService } from '../services';
import { getSessionManager } from '../services';
import { loadStreamSnapshot } from '../session/streamSnapshot';
import { rehydrateModelOverrideFromSession } from '../session/modelOverridePersistence';
import { resolveSessionDefaultModelConfig } from '../services/core/sessionDefaults';
import { isExternalAgentEngine } from '../services/agentEngine';
import { getUserBrowserLinkService } from '../services/surfaceExecution/UserBrowserLinkService';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('SessionLifecycleAppService');

type SessionLifecycleDependencies = {
  getTaskManager: () => TaskManager;
  getConfigService: () => ConfigService | null;
  getCurrentSessionId: () => string | null;
  setCurrentSessionId: (id: string) => void;
  getWorkingDirectory: () => string | undefined;
};

export class SessionLifecycleAppService {
  constructor(private readonly deps: SessionLifecycleDependencies) {}

  private async endPreviousUserBrowserRun(nextSessionId: string): Promise<void> {
    const previousSessionId = this.deps.getCurrentSessionId();
    if (!previousSessionId || previousSessionId === nextSessionId) return;
    await getUserBrowserLinkService().end(previousSessionId, 'session-switch').catch((error) => {
      logger.warn('Failed to end user browser run while switching sessions', {
        previousSessionId,
        nextSessionId,
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async createSession(config?: CreateSessionConfig): Promise<Session> {
    if (!this.deps.getConfigService()) throw new Error('Services not initialized');

    const sessionManager = getSessionManager();
    const hasExplicitWorkingDirectory = Object.prototype.hasOwnProperty.call(config ?? {}, 'workingDirectory');
    const requestedWorkingDirectory = typeof config?.workingDirectory === 'string'
      ? config.workingDirectory.trim()
      : undefined;
    const workingDirectory = hasExplicitWorkingDirectory
      ? requestedWorkingDirectory
      : this.deps.getWorkingDirectory();

    const requestedEngine = normalizeAgentEngineSession(config?.engine);
    if (config?.engine && isExternalAgentEngine(requestedEngine.kind)) {
      throw new Error('External Agent Engine selection must be done after creating a manual chat session.');
    }

    const session = await sessionManager.createSession({
      title: config?.title || 'New Session',
      modelConfig: resolveSessionDefaultModelConfig(),
      workingDirectory,
      engine: config?.engine ? requestedEngine : undefined,
      metadata: config?.metadata,
    });

    await this.endPreviousUserBrowserRun(session.id);
    sessionManager.setCurrentSession(session.id);
    this.deps.setCurrentSessionId(session.id);

    const taskManager = this.deps.getTaskManager();
    taskManager.cleanup(session.id);
    taskManager.setCurrentSessionId(session.id);
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(session.id);
    if (orchestrator && workingDirectory?.trim()) {
      orchestrator.setWorkingDirectory(workingDirectory);
    }

    return session;
  }

  async loadSession(sessionId: string): Promise<Session> {
    const session = await getSessionManager().restoreSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    await this.endPreviousUserBrowserRun(sessionId);
    this.deps.setCurrentSessionId(sessionId);

    const taskManager = this.deps.getTaskManager();
    taskManager.setCurrentSessionId(sessionId);
    if (session.messages && session.messages.length > 0) {
      taskManager.setSessionContext(sessionId, session.messages);
    }

    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId);
    if (orchestrator && session.workingDirectory?.trim()) {
      orchestrator.setWorkingDirectory(session.workingDirectory);
    }

    rehydrateModelOverrideFromSession(session);
    const streamSnapshot = loadStreamSnapshot({
      workingDir: session.workingDirectory,
      sessionId: session.id,
    });
    return streamSnapshot?.sessionId === session.id
      ? { ...session, streamSnapshot }
      : session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sessionManager = getSessionManager();
    const currentSessionId = this.deps.getCurrentSessionId();
    await sessionManager.deleteSession(sessionId);

    if (sessionId === currentSessionId) {
      const newSession = await sessionManager.createSession({
        title: 'New Session',
        modelConfig: resolveSessionDefaultModelConfig(),
      });
      sessionManager.setCurrentSession(newSession.id);
      this.deps.setCurrentSessionId(newSession.id);
    }
  }
}
