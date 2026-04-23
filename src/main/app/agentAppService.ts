// ============================================================================
// AgentAppServiceImpl — AgentApplicationService 接口的适配器实现
//
// 内部委托给 TaskManager → AgentOrchestrator、SessionManager、MemoryService 等。
// IPC handler 通过接口访问，不直接 import 具体实现类。
// ============================================================================

import type {
  AgentApplicationService,
  CreateSessionConfig,
  AppServiceRunOptions,
  SwitchModelParams,
  ModelOverride,
  SessionMarkdownExport,
} from '../../shared/contract/appService';
import type {
  Message,
  MessageMetadata,
  ModelProvider,
  PermissionResponse,
  Session,
} from '../../shared/contract';
import type { TaskManager } from '../task';
import type { ConfigService } from '../services';
import { getSessionManager, type SessionWithMessages } from '../services';
import { getModelSessionState } from '../session/modelSessionState';
import { DEFAULT_MODELS, DEFAULT_PROVIDER, MODEL_MAX_TOKENS } from '../../shared/constants';
import type {
  ConversationEnvelope,
  ConversationEnvelopeContext,
  WorkbenchMessageMetadata,
} from '../../shared/contract/conversationEnvelope';
import { withWorkbenchTurnSystemContext } from './workbenchTurnContext';
import {
  exportSessionToMarkdown,
  suggestExportFilename,
} from '../session/exportMarkdown';
import type { CachedMessage, CachedSession } from '../session/localCache';

export class AgentAppServiceImpl implements AgentApplicationService {
  constructor(
    private getTaskManager: () => TaskManager,
    private getConfigService: () => ConfigService | null,
    private _getCurrentSessionId: () => string | null,
    private _setCurrentSessionId: (id: string) => void,
  ) {}

  // === Helper: get orchestrator or throw ===
  private resolveSessionId(sessionId?: string): string | null {
    return sessionId ?? this._getCurrentSessionId();
  }

  private getOrchestratorOrThrow(sessionId?: string) {
    const tm = this.getTaskManager();
    const resolvedSessionId = this.resolveSessionId(sessionId);
    if (!resolvedSessionId) throw new Error('No active session');
    const orchestrator = tm.getOrCreateCurrentOrchestrator(resolvedSessionId);
    if (!orchestrator) throw new Error('Agent not initialized');
    return orchestrator;
  }

  private toWorkbenchMetadata(context?: ConversationEnvelopeContext): WorkbenchMessageMetadata | undefined {
    if (!context) return undefined;

    const metadata: WorkbenchMessageMetadata = {};

    if (context.workingDirectory !== undefined) {
      metadata.workingDirectory = context.workingDirectory;
    }
    if (context.routing) {
      metadata.routingMode = context.routing.mode;
      if (context.routing.targetAgentIds?.length) {
        metadata.targetAgentIds = [...context.routing.targetAgentIds];
      }
    }
    if (context.selectedSkillIds?.length) {
      metadata.selectedSkillIds = [...context.selectedSkillIds];
    }
    if (context.selectedConnectorIds?.length) {
      metadata.selectedConnectorIds = [...context.selectedConnectorIds];
    }
    if (context.selectedMcpServerIds?.length) {
      metadata.selectedMcpServerIds = [...context.selectedMcpServerIds];
    }
    if (context.executionIntent) {
      metadata.executionIntent = {
        ...context.executionIntent,
      };
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private getMessageMetadata(envelope: ConversationEnvelope): MessageMetadata | undefined {
    const workbench = this.toWorkbenchMetadata(envelope.context);
    return workbench ? { workbench } : undefined;
  }

  private async syncSessionWorkingDirectory(sessionId: string | null, workingDirectory?: string | null): Promise<void> {
    const nextWorkingDirectory = workingDirectory?.trim();
    if (!sessionId || !nextWorkingDirectory) {
      return;
    }

    const sessionManager = getSessionManager();
    const session = await sessionManager.getSession(sessionId, 1);
    if (session?.workingDirectory === nextWorkingDirectory) {
      return;
    }

    await sessionManager.updateSession(sessionId, {
      workingDirectory: nextWorkingDirectory,
      updatedAt: Date.now(),
    });
  }

  private toCachedMessage(message: Message): CachedMessage {
    const metadata = message.metadata
      ? ({ ...message.metadata } as Record<string, unknown>)
      : undefined;

    return {
      id: message.id,
      role: message.role === 'user' || message.role === 'system' ? message.role : 'assistant',
      content: message.content,
      timestamp: message.timestamp,
      tokens: (message.inputTokens || 0) + (message.outputTokens || 0) || undefined,
      metadata,
    };
  }

  private toCachedSession(session: SessionWithMessages): CachedSession {
    return {
      sessionId: session.id,
      messages: session.messages.map((message) => this.toCachedMessage(message)),
      startedAt: session.createdAt,
      lastActivityAt: session.updatedAt,
      totalTokens: session.messages.reduce(
        (sum, message) => sum + (message.inputTokens || 0) + (message.outputTokens || 0),
        0,
      ),
      metadata: {
        title: session.title,
        workingDirectory: session.workingDirectory,
      },
    };
  }

  // === Agent Operations ===

  async sendMessage(envelope: ConversationEnvelope): Promise<void> {
    const orchestrator = this.getOrchestratorOrThrow(envelope.sessionId);
    const resolvedSessionId = this.resolveSessionId(envelope.sessionId);
    if (envelope.context?.workingDirectory) {
      orchestrator.setWorkingDirectory(envelope.context.workingDirectory);
    }
    await this.syncSessionWorkingDirectory(resolvedSessionId, envelope.context?.workingDirectory);
    const options = withWorkbenchTurnSystemContext(
      envelope.options as AppServiceRunOptions | undefined,
      envelope.context,
    );
    // Cast to concrete AgentRunOptions — AppServiceRunOptions is a superset via index signature
    await orchestrator.sendMessage(
      envelope.content,
      envelope.attachments,
      options as any,
      this.getMessageMetadata(envelope),
    );
  }

  async cancel(sessionId?: string): Promise<void> {
    const orchestrator = this.getOrchestratorOrThrow(sessionId);
    await orchestrator.cancel();
  }

  handlePermissionResponse(requestId: string, response: PermissionResponse, sessionId?: string): void {
    const orchestrator = this.getOrchestratorOrThrow(sessionId);
    orchestrator.handlePermissionResponse(requestId, response);
  }

  async interruptAndContinue(envelope: ConversationEnvelope): Promise<void> {
    const orchestrator = this.getOrchestratorOrThrow(envelope.sessionId);
    const resolvedSessionId = this.resolveSessionId(envelope.sessionId);
    if (envelope.context?.workingDirectory) {
      orchestrator.setWorkingDirectory(envelope.context.workingDirectory);
    }
    await this.syncSessionWorkingDirectory(resolvedSessionId, envelope.context?.workingDirectory);
    const options = withWorkbenchTurnSystemContext(
      envelope.options as AppServiceRunOptions | undefined,
      envelope.context,
    );
    await orchestrator.interruptAndContinue(
      envelope.content,
      envelope.attachments,
      options as any,
      this.getMessageMetadata(envelope),
    );
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
    const settings = configService.getSettings();
    const workingDirectory = this.getWorkingDirectory();

    const session = await sessionManager.createSession({
      title: config?.title || 'New Session',
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

    return session;
  }

  async loadSession(sessionId: string): Promise<Session> {
    const sessionManager = getSessionManager();

    const session = await sessionManager.restoreSession(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    this._setCurrentSessionId(sessionId);

    const taskManager = this.getTaskManager();
    taskManager.setCurrentSessionId(sessionId);

    if (session.messages && session.messages.length > 0) {
      taskManager.setSessionContext(sessionId, session.messages);
    }

    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(sessionId);
    if (orchestrator && session.workingDirectory?.trim()) {
      orchestrator.setWorkingDirectory(session.workingDirectory);
    }
    // NOTE: 当 session.workingDirectory 为空时，orchestrator 使用默认值（用户主目录）

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
        modelConfig: {
          provider: settings.model?.provider || DEFAULT_PROVIDER,
          model: settings.model?.model || DEFAULT_MODELS.chat,
          temperature: settings.model?.temperature || 0.7,
          maxTokens: settings.model?.maxTokens || MODEL_MAX_TOKENS.DEFAULT,
        },
      });

      sessionManager.setCurrentSession(newSession.id);
      this._setCurrentSessionId(newSession.id);
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

  getSerializedCompressionState(sessionId?: string): string | null {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    if (!resolvedSessionId) return null;

    const orchestrator = this.getTaskManager().getOrchestrator(resolvedSessionId);
    return orchestrator?.getSerializedCompressionState() ?? null;
  }

  async loadOlderMessages(sessionId: string, beforeTimestamp: number, limit: number): Promise<{ messages: Message[]; hasMore: boolean }> {
    return getSessionManager().loadOlderMessages(sessionId, beforeTimestamp, limit);
  }

  async exportSession(sessionId: string): Promise<unknown> {
    return getSessionManager().exportSession(sessionId);
  }

  async exportSessionMarkdown(sessionId: string): Promise<SessionMarkdownExport> {
    const session = await getSessionManager().exportSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const cachedSession = this.toCachedSession(session);
    const result = exportSessionToMarkdown(cachedSession, {
      title: session.title || undefined,
      includeMetadata: true,
      includeTimestamps: true,
    });

    if (!result.success || !result.markdown) {
      throw new Error(result.error || 'Failed to export markdown');
    }

    return {
      markdown: result.markdown,
      suggestedFileName: suggestExportFilename(cachedSession),
      stats: result.stats,
    };
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

  async getMemoryContext(_sessionId: string, _workingDirectory?: string, _query?: string): Promise<unknown> {
    // Old memoryTriggerService removed — return empty context
    return {
      projectKnowledge: [],
      relevantCode: [],
      recentConversations: [],
      userPreferences: {},
      stats: { projectKnowledgeCount: 0, relevantCodeCount: 0, conversationCount: 0, retrievalTimeMs: 0 },
    };
  }

  // === Model Override ===

  switchModel(params: SwitchModelParams): void {
    const modelState = getModelSessionState();
    modelState.setOverride(params.sessionId, {
      provider: params.provider as ModelProvider,
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      adaptive: params.adaptive,
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

  isDelegateMode(): boolean {
    const tm = this.getTaskManager();
    const orchestrator = tm.getOrCreateCurrentOrchestrator();
    return orchestrator?.isDelegateMode() ?? false;
  }

  // === Effort Level ===

  setEffortLevel(level: import('../../shared/contract/agent').EffortLevel): void {
    const orchestrator = this.getOrchestratorOrThrow();
    orchestrator.setEffortLevel(level);
  }

  // === Interaction Mode ===

  setInteractionMode(mode: import('../../shared/contract/agent').InteractionMode): void {
    const orchestrator = this.getOrchestratorOrThrow();
    orchestrator.setInteractionMode(mode);
  }

  // === Pause / Resume ===

  pause(sessionId?: string): void {
    const orchestrator = this.getOrchestratorOrThrow(sessionId);
    orchestrator.pause();
  }

  resume(sessionId?: string): void {
    const orchestrator = this.getOrchestratorOrThrow(sessionId);
    orchestrator.resume();
  }
}
