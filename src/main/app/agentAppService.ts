// ============================================================================
// AgentAppServiceImpl — AgentApplicationService 接口的适配器实现
//
// 内部委托给 TaskManager → AgentOrchestrator、SessionManager、MemoryService 等。
// IPC handler 通过接口访问，不直接 import 具体实现类。
// ============================================================================

import type {
  AgentApplicationService,
  AppServiceRunOptions,
  CreateSessionConfig,
  SwitchModelParams,
  ModelOverride,
} from '../../shared/types/appService';
import type { PermissionResponse, Session, Message, ModelProvider } from '../../shared/types';
import type { TaskManager } from '../task';
import type { ConfigService } from '../services';
import { getSessionManager, type SessionWithMessages } from '../services';
import { getMemoryService } from '../memory/memoryService';
import { getMemoryTriggerService } from '../memory/memoryTriggerService';
import { getModelSessionState } from '../session/modelSessionState';
import { DEFAULT_MODELS, DEFAULT_PROVIDER, MODEL_MAX_TOKENS } from '../../shared/constants';

export class AgentAppServiceImpl implements AgentApplicationService {
  constructor(
    private getTaskManager: () => TaskManager,
    private getConfigService: () => ConfigService | null,
    private _getCurrentSessionId: () => string | null,
    private _setCurrentSessionId: (id: string) => void,
  ) {}

  // === Helper: get orchestrator or throw ===
  private getOrchestratorOrThrow() {
    const tm = this.getTaskManager();
    const orchestrator = tm.getOrCreateCurrentOrchestrator();
    if (!orchestrator) throw new Error('Agent not initialized');
    return orchestrator;
  }

  // === Agent Operations ===

  async sendMessage(content: string, attachments?: unknown[], options?: AppServiceRunOptions): Promise<void> {
    const orchestrator = this.getOrchestratorOrThrow();
    // Cast to concrete AgentRunOptions — AppServiceRunOptions is a superset via index signature
    await orchestrator.sendMessage(content, attachments, options as any);
  }

  async cancel(): Promise<void> {
    const orchestrator = this.getOrchestratorOrThrow();
    await orchestrator.cancel();
  }

  handlePermissionResponse(requestId: string, response: PermissionResponse): void {
    const orchestrator = this.getOrchestratorOrThrow();
    orchestrator.handlePermissionResponse(requestId, response);
  }

  async interruptAndContinue(content: string, attachments?: unknown[]): Promise<void> {
    const orchestrator = this.getOrchestratorOrThrow();
    await orchestrator.interruptAndContinue(content, attachments);
  }

  // === Workspace ===

  getWorkingDirectory(): string | undefined {
    const tm = this.getTaskManager();
    const orchestrator = tm.getOrCreateCurrentOrchestrator();
    return orchestrator?.getWorkingDirectory();
  }

  setWorkingDirectory(dir: string): void {
    const tm = this.getTaskManager();
    const orchestrator = tm.getOrCreateCurrentOrchestrator();
    if (orchestrator) orchestrator.setWorkingDirectory(dir);
  }

  // === Session Lifecycle ===

  async createSession(config?: CreateSessionConfig): Promise<Session> {
    const configService = this.getConfigService();
    if (!configService) throw new Error('Services not initialized');

    const sessionManager = getSessionManager();
    const memoryService = getMemoryService();
    const memoryTrigger = getMemoryTriggerService();
    const settings = configService.getSettings();
    const workingDirectory = this.getWorkingDirectory();

    const session = await sessionManager.createSession({
      title: config?.title || 'New Session',
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
    this._setCurrentSessionId(session.id);

    const taskManager = this.getTaskManager();
    taskManager.cleanup(session.id);
    taskManager.setCurrentSessionId(session.id);

    memoryService.setContext(session.id, workingDirectory || undefined);

    memoryTrigger.onSessionStart(session.id, workingDirectory).catch((err) => {
      console.warn('Memory trigger failed:', err);
    });

    return session;
  }

  async loadSession(sessionId: string): Promise<Session> {
    const sessionManager = getSessionManager();
    const memoryService = getMemoryService();
    const memoryTrigger = getMemoryTriggerService();

    const session = await sessionManager.restoreSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    this._setCurrentSessionId(sessionId);
    memoryService.setContext(sessionId, session.workingDirectory || undefined);

    const taskManager = this.getTaskManager();
    taskManager.setCurrentSessionId(sessionId);

    if (session.messages && session.messages.length > 0) {
      taskManager.setSessionContext(sessionId, session.messages);
    }

    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId);
    if (orchestrator && session.workingDirectory && session.workingDirectory.trim()) {
      orchestrator.setWorkingDirectory(session.workingDirectory);
    }
    // NOTE: 当 session.workingDirectory 为空时，orchestrator 使用默认值（用户主目录）

    memoryTrigger.onSessionStart(sessionId, session.workingDirectory).catch((err) => {
      console.warn('Memory trigger failed:', err);
    });

    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const sessionManager = getSessionManager();
    const configService = this.getConfigService();
    const currentSessionId = this._getCurrentSessionId();

    await sessionManager.deleteSession(sessionId);

    if (sessionId === currentSessionId) {
      const settings = configService!.getSettings();

      const newSession = await sessionManager.createSession({
        title: 'New Session',
        generationId: 'gen8',
        modelConfig: {
          provider: settings.model?.provider || DEFAULT_PROVIDER,
          model: settings.model?.model || DEFAULT_MODELS.chat,
          temperature: settings.model?.temperature || 0.7,
          maxTokens: settings.model?.maxTokens || MODEL_MAX_TOKENS.DEFAULT,
        },
      });

      sessionManager.setCurrentSession(newSession.id);
      this._setCurrentSessionId(newSession.id);

      const memoryService = getMemoryService();
      memoryService.setContext(newSession.id);
    }
  }

  async listSessions(options?: { includeArchived?: boolean }): Promise<Session[]> {
    return getSessionManager().listSessions({ includeArchived: options?.includeArchived });
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<void> {
    await getSessionManager().updateSession(sessionId, updates);
  }

  async archiveSession(sessionId: string): Promise<Session | null> {
    return getSessionManager().archiveSession(sessionId);
  }

  async unarchiveSession(sessionId: string): Promise<Session | null> {
    return getSessionManager().unarchiveSession(sessionId);
  }

  async getMessages(sessionId: string): Promise<Message[]> {
    return getSessionManager().getMessages(sessionId);
  }

  async loadOlderMessages(sessionId: string, beforeTimestamp: number, limit: number): Promise<{ messages: Message[]; hasMore: boolean }> {
    return getSessionManager().loadOlderMessages(sessionId, beforeTimestamp, limit);
  }

  async exportSession(sessionId: string): Promise<unknown> {
    return getSessionManager().exportSession(sessionId);
  }

  async importSession(data: unknown): Promise<string> {
    return getSessionManager().importSession(data as SessionWithMessages);
  }

  // === Session State ===

  getCurrentSessionId(): string | null {
    return this._getCurrentSessionId();
  }

  setCurrentSessionId(id: string): void {
    this._setCurrentSessionId(id);
  }

  // === Memory ===

  async getMemoryContext(sessionId: string, workingDirectory?: string, query?: string): Promise<unknown> {
    const memoryTrigger = getMemoryTriggerService();
    return memoryTrigger.onSessionStart(sessionId, workingDirectory, query);
  }

  // === Model Override ===

  switchModel(params: SwitchModelParams): void {
    const modelState = getModelSessionState();
    modelState.setOverride(params.sessionId, {
      provider: params.provider as ModelProvider,
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
    });
  }

  getModelOverride(sessionId: string): ModelOverride | undefined {
    const modelState = getModelSessionState();
    return modelState.getOverride(sessionId) as ModelOverride | undefined;
  }

  clearModelOverride(sessionId: string): void {
    const modelState = getModelSessionState();
    modelState.clearOverride(sessionId);
  }

  // === Delegate Mode ===

  setDelegateMode(enabled: boolean): void {
    const tm = this.getTaskManager();
    const orchestrator = tm.getOrCreateCurrentOrchestrator();
    if (orchestrator) orchestrator.setDelegateMode(enabled);
  }
}
