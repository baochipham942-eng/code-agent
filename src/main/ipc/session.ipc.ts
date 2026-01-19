// ============================================================================
// Session IPC Handlers - session:* 通道
// ============================================================================

import type { IpcMain } from 'electron';
import { IPC_CHANNELS } from '../../shared/ipc';
import { getSessionManager } from '../services';
import { getMemoryService } from '../memory/MemoryService';
import type { ConfigService } from '../services';
import type { GenerationManager } from '../generation/GenerationManager';
import type { AgentOrchestrator } from '../agent/AgentOrchestrator';

interface SessionHandlerDeps {
  getConfigService: () => ConfigService | null;
  getGenerationManager: () => GenerationManager | null;
  getOrchestrator: () => AgentOrchestrator | null;
  getCurrentSessionId: () => string | null;
  setCurrentSessionId: (id: string) => void;
}

/**
 * 注册 Session 相关 IPC handlers
 */
export function registerSessionHandlers(ipcMain: IpcMain, deps: SessionHandlerDeps): void {
  const {
    getConfigService,
    getGenerationManager,
    getOrchestrator,
    getCurrentSessionId,
    setCurrentSessionId,
  } = deps;

  ipcMain.handle(IPC_CHANNELS.SESSION_LIST, async () => {
    const sessionManager = getSessionManager();
    return sessionManager.listSessions();
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_CREATE, async (_, title?: string) => {
    const configService = getConfigService();
    const generationManager = getGenerationManager();
    const orchestrator = getOrchestrator();

    if (!configService || !generationManager) {
      throw new Error('Services not initialized');
    }

    const sessionManager = getSessionManager();
    const memoryService = getMemoryService();
    const settings = configService.getSettings();
    const currentGen = generationManager.getCurrentGeneration();

    const session = await sessionManager.createSession({
      title: title || 'New Session',
      generationId: currentGen.id,
      modelConfig: {
        provider: settings.model?.provider || 'deepseek',
        model: settings.model?.model || 'deepseek-chat',
        temperature: settings.model?.temperature || 0.7,
        maxTokens: settings.model?.maxTokens || 4096,
      },
      workingDirectory: orchestrator?.getWorkingDirectory(),
    });

    sessionManager.setCurrentSession(session.id);
    setCurrentSessionId(session.id);

    memoryService.setContext(session.id, orchestrator?.getWorkingDirectory() || undefined);

    return session;
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_LOAD, async (_, sessionId: string) => {
    const sessionManager = getSessionManager();
    const memoryService = getMemoryService();
    const orchestrator = getOrchestrator();

    const session = await sessionManager.restoreSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    setCurrentSessionId(sessionId);

    memoryService.setContext(sessionId, session.workingDirectory || undefined);

    if (session.workingDirectory && orchestrator) {
      orchestrator.setWorkingDirectory(session.workingDirectory);
    }

    return session;
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_DELETE, async (_, sessionId: string) => {
    const sessionManager = getSessionManager();
    const configService = getConfigService();
    const generationManager = getGenerationManager();
    const currentSessionId = getCurrentSessionId();

    await sessionManager.deleteSession(sessionId);

    if (sessionId === currentSessionId) {
      const settings = configService!.getSettings();
      const currentGen = generationManager!.getCurrentGeneration();

      const newSession = await sessionManager.createSession({
        title: 'New Session',
        generationId: currentGen.id,
        modelConfig: {
          provider: settings.model?.provider || 'deepseek',
          model: settings.model?.model || 'deepseek-chat',
          temperature: settings.model?.temperature || 0.7,
          maxTokens: settings.model?.maxTokens || 4096,
        },
      });

      sessionManager.setCurrentSession(newSession.id);
      setCurrentSessionId(newSession.id);

      const memoryService = getMemoryService();
      memoryService.setContext(newSession.id);
    }
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_GET_MESSAGES, async (_, sessionId: string) => {
    const sessionManager = getSessionManager();
    return sessionManager.getMessages(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_EXPORT, async (_, sessionId: string) => {
    const sessionManager = getSessionManager();
    return sessionManager.exportSession(sessionId);
  });

  ipcMain.handle(IPC_CHANNELS.SESSION_IMPORT, async (_, data: any) => {
    const sessionManager = getSessionManager();
    return sessionManager.importSession(data);
  });
}
