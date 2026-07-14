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
  ModelOverridePersistResult,
  SessionMarkdownExport,
  SessionLogExport,
  PromptRewindResult,
} from '../../shared/contract/appService';
import type {
  Message,
  MessageMetadata,
  ModelProvider,
  PermissionResponse,
  Session,
  SessionTask,
} from '../../shared/contract';
import type { SessionStatus, TaskManager } from '../task';
import type { ConfigService } from '../services';
import { getSessionManager, type SessionWithMessages } from '../services';
import { createLogger } from '../services/infra/logger';
import { getDatabase } from '../services/core/databaseService';
import { getAuthService } from '../services/auth/authService';
import { getFileCheckpointService } from '../services/checkpoint';
import { applyPromptCommandExpansion } from '../services/commands/promptCommandService';
import { normalizeAgentEffortLevel } from '../../shared/effortLevels';
import type { AgentRunOptions } from '../research/types';

const logger = createLogger('AgentAppService');
import { getModelSessionState } from '../session/modelSessionState';
import {
  clearPersistedModelOverride,
  persistModelOverride,
  rehydrateModelOverrideFromSession,
} from '../session/modelOverridePersistence';
import { resolveSessionDefaultModelConfig } from '../services/core/sessionDefaults';
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
import { buildSessionLogExport } from '../telemetry/diagnosticBundleService';
import type { CachedMessage, CachedSession } from '../session/localCache';
import { loadStreamSnapshot } from '../session/streamSnapshot';
import { getSwarmServices, hasSwarmServices } from '../agent/swarmServices';
import type { CancellationReason } from '../../shared/contract/cancellation';
import { normalizeCancellationReason } from '../../shared/contract/cancellation';
import { AGENT_ENGINE_LABELS, normalizeAgentEngineSession } from '../../shared/contract/agentEngine';
import {
  ClaudeCodeAdapter,
  CodexCliAdapter,
  KimiCliAdapter,
  MimoCliAdapter,
  ExternalEngineDurableLifecycle,
  getRemoteAgentEngineModelCatalogService,
  isExternalAgentEngine,
  resolveExternalEngineLaunch,
} from '../services/agentEngine';
import type { ExternalAgentEngineKind } from '../../shared/contract/agentEngine';
import type { AgentEngineRunResult } from '../../shared/contract/agentEngine';
import type { RunRegistry } from '../runtime/runRegistry';
import type { DurableRunReadService } from './durableRunReadService';
import { listTasks } from '../services/planning/taskStore';
import { upgradeLegacyAnchor } from '../tools/artifacts/artifactLocatorHost';

function isTaskManagerOwnedRunState(status: SessionStatus): boolean {
  return status === 'running'
    || status === 'paused'
    || status === 'queued'
    || status === 'cancelling';
}

function toAgentRunOptions(options: AppServiceRunOptions | undefined): AgentRunOptions | undefined {
  if (!options) {
    return undefined;
  }

  return {
    ...options,
    mode: options.mode ?? (options.researchMode ? 'deep-research' : 'normal'),
  };
}

export class AgentAppServiceImpl implements AgentApplicationService {
  /**
   * Per-session in-flight cancel promise. Second ESC during first shutdown
   * reuses the same promise instead of triggering a duplicate cascade.
   */
  private readonly cancelInFlight = new Map<string, Promise<void>>();

  constructor(
    private getTaskManager: () => TaskManager,
    private getConfigService: () => ConfigService | null,
    private _getCurrentSessionId: () => string | null,
    private _setCurrentSessionId: (id: string) => void,
    private readonly externalRunRegistry?: RunRegistry,
    private readonly durableRunReadService?: DurableRunReadService,
  ) {}

  private async startExternalLifecycle(input: {
    engine: ExternalAgentEngineKind;
    sessionId: string;
    workspace: string;
    cwd: string;
    externalSessionId?: string;
  }): Promise<ExternalEngineDurableLifecycle | undefined> {
    if (!this.externalRunRegistry) return undefined;
    return ExternalEngineDurableLifecycle.start({ registry: this.externalRunRegistry, ...input });
  }

  private async executeExternalRun<T extends AgentEngineRunResult>(
    lifecycle: ExternalEngineDurableLifecycle | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      const result = await run();
      await lifecycle?.finish(
        result,
        result.status !== 'completed' || Boolean(result.outputText?.trim()),
      );
      return result;
    } catch (error) {
      if (lifecycle) {
        const message = error instanceof Error ? error.message : String(error);
        await lifecycle.finish({
          runId: lifecycle.runId,
          sessionId: lifecycle.sessionId,
          engine: lifecycle.engine,
          status: 'failed',
          error: message,
        }, true).catch((terminalError) => {
          logger.error('External Durable Run terminal commit failed', terminalError);
        });
      }
      throw error;
    }
  }

  // === Helper: get orchestrator or throw ===
  private resolveSessionId(sessionId?: string): string | null {
    return sessionId ?? this._getCurrentSessionId();
  }

  private getOrchestrator(sessionId?: string) {
    const tm = this.getTaskManager();
    const resolvedSessionId = this.resolveSessionId(sessionId);
    return resolvedSessionId ? tm.getOrCreateCurrentOrchestrator(resolvedSessionId) : undefined;
  }

  private getOrchestratorOrThrow(sessionId?: string) {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    if (!resolvedSessionId) throw new Error('No active session');
    const orchestrator = this.getOrchestrator(resolvedSessionId);
    if (!orchestrator) throw new Error('Agent not initialized');
    return orchestrator;
  }

  private toWorkbenchMetadata(context?: ConversationEnvelopeContext): WorkbenchMessageMetadata | undefined {
    if (!context) return undefined;

    const metadata: WorkbenchMessageMetadata = {};

    if (context.workingDirectory !== undefined) {
      metadata.workingDirectory = context.workingDirectory;
    }
    if (context.preferredAgentId !== undefined) {
      metadata.preferredAgentId = context.preferredAgentId;
    }
    if (context.preferredAgentName !== undefined) {
      metadata.preferredAgentName = context.preferredAgentName;
    }
    if (context.selectedAgent) {
      metadata.selectedAgent = { ...context.selectedAgent };
    }
    if (context.selectedPromptCommand) {
      metadata.selectedPromptCommand = {
        ...context.selectedPromptCommand,
        hints: context.selectedPromptCommand.hints ? [...context.selectedPromptCommand.hints] : undefined,
      };
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
    if (context.turnCapabilityScopeMode) {
      metadata.turnCapabilityScopeMode = context.turnCapabilityScopeMode;
    }
    if (context.designBrief) {
      metadata.designBrief = context.designBrief;
    }
    if (context.executionIntent) {
      metadata.executionIntent = {
        ...context.executionIntent,
      };
    }
    if (context.runtimeInput) {
      metadata.runtimeInputMode = context.runtimeInput.mode;
      if (context.runtimeInput.delivery) {
        metadata.runtimeInputDelivery = context.runtimeInput.delivery;
      }
    }
    if (context.voiceInput) {
      metadata.voiceInput = { ...context.voiceInput };
    }

    return Object.keys(metadata).length > 0 ? metadata : undefined;
  }

  private getMessageMetadata(envelope: ConversationEnvelope): MessageMetadata | undefined {
    const workbench = this.toWorkbenchMetadata(envelope.context);
    return workbench ? { workbench } : undefined;
  }

  /**
   * getMessageMetadata + ADR-040 locator（revision 要读源文件，只能异步）。
   *
   * 只给原生 loop 用：外部 CLI 引擎（codex/kimi/mimo/claude）跑的是自己的工具，
   * 写前 guard 根本不在那条链上，给它们挂 locator 只会造成"有锚点却没人对账"的错觉。
   */
  private async getMessageMetadataWithLocator(envelope: ConversationEnvelope): Promise<MessageMetadata | undefined> {
    const base = this.getMessageMetadata(envelope);
    const anchor = envelope.context?.localityAnchor;
    if (!anchor) return base;

    const artifactLocator = await upgradeLegacyAnchor(anchor);
    if (!artifactLocator) return base;
    return { ...base, artifactLocator };
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

  /**
   * 解析本轮使用的 workingDirectory：
   * 1. envelope 显式传了就用（例如 renderer 切了 workspace folder）
   * 2. 否则从 session 持久化数据恢复
   * 3. 都没有返回 undefined，让 orchestrator 保持原值（不要回退到 home dir / webServer cwd —
   *    后者在打包态是 .app 内部 read-only 路径，会让 artifact 写入永远失败）
   */
  private async resolveWorkingDirectory(
    sessionId: string,
    override?: string | null,
  ): Promise<string | undefined> {
    const trimmedOverride = override?.trim();
    if (trimmedOverride) return trimmedOverride;

    try {
      const session = await getSessionManager().getSession(sessionId, 1);
      const persisted = session?.workingDirectory?.trim();
      if (persisted) return persisted;
    } catch (error) {
      logger.warn('Failed to resolve workingDirectory from session:', error);
    }

    return undefined;
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
    const tm = this.getTaskManager();
    const resolvedSessionId = this.resolveSessionId(envelope.sessionId);
    if (!resolvedSessionId) throw new Error('No active session');
    const sessionManager = getSessionManager();
    const session = await sessionManager.getSession(resolvedSessionId, 1);
    const engine = normalizeAgentEngineSession(session?.engine);
    const orchestrator = this.getOrchestrator(resolvedSessionId);
    const effectiveWorkingDirectory = await this.resolveWorkingDirectory(
      resolvedSessionId,
      envelope.context?.workingDirectory,
    );
    // /命令协议层（roadmap 2.2）：命中注册命令时把 content 展开成模板 prompt；
    // 非命令消息零开销直通（startsWith 守卫在函数内）
    envelope = await applyPromptCommandExpansion(envelope, effectiveWorkingDirectory);
    // 外部引擎分支在 preferredAgentId 消费点（withWorkbenchTurnSystemContext →
    // agentOverrideId）之前 return，显式 agent 选择在引擎会话不适用——发降级
    // routing_resolved 让 renderer 清选择 + toast（与 web /api/run 引擎分支对称）。
    if (isExternalAgentEngine(engine.kind)) {
      const enginePreferredAgentId = typeof envelope.context?.preferredAgentId === 'string'
        ? envelope.context.preferredAgentId.trim() || undefined
        : undefined;
      if (enginePreferredAgentId) {
        const { buildRoutingResolvedEventData } = await import('../agent/routingResolvedEvent');
        const engineLabel = AGENT_ENGINE_LABELS[engine.kind] ?? engine.kind;
        tm.emitAgentEventForSession(resolvedSessionId, {
          type: 'routing_resolved',
          data: buildRoutingResolvedEventData(null, {
            requestedAgentId: enginePreferredAgentId,
            timestamp: Date.now(),
            fallbackAgentName: engineLabel,
            fallbackReason: `External engine session (${engineLabel}) does not support agent selection; the engine runs the turn directly.`,
          }),
        });
        logger.info('Explicit agent selection ignored on external engine session', {
          preferredAgentId: enginePreferredAgentId,
          engine: engine.kind,
          sessionId: resolvedSessionId,
        });
      }
    }
    if (engine.kind === 'codex_cli') {
      const launch = resolveExternalEngineLaunch(session, engine, envelope.context?.workingDirectory ?? effectiveWorkingDirectory);
      orchestrator?.setWorkingDirectory(launch.cwd);
      const resolvedModel = await getRemoteAgentEngineModelCatalogService().resolveModelId('codex_cli', launch.model, { strict: true });
      const durableLifecycle = await this.startExternalLifecycle({ engine: engine.kind, sessionId: resolvedSessionId, workspace: launch.workspaceRoot, cwd: launch.cwd });
      await this.executeExternalRun(durableLifecycle, () => new CodexCliAdapter().run({
        sessionId: resolvedSessionId,
        prompt: envelope.content,
        cwd: launch.cwd,
        workspaceRoot: launch.workspaceRoot,
        model: resolvedModel,
        permissionProfile: launch.permissionProfile,
        clientMessageId: envelope.clientMessageId,
        attachmentsCount: envelope.attachments?.length ?? 0,
        messageMetadata: this.getMessageMetadata(envelope),
        durableLifecycle,
      }));
      return;
    }
    if (engine.kind === 'claude_code') {
      const launch = resolveExternalEngineLaunch(session, engine, envelope.context?.workingDirectory ?? effectiveWorkingDirectory);
      orchestrator?.setWorkingDirectory(launch.cwd);
      const resolvedModel = await getRemoteAgentEngineModelCatalogService().resolveModelId('claude_code', launch.model, { strict: true });
      const durableLifecycle = await this.startExternalLifecycle({ engine: engine.kind, sessionId: resolvedSessionId, workspace: launch.workspaceRoot, cwd: launch.cwd });
      await this.executeExternalRun(durableLifecycle, () => new ClaudeCodeAdapter().run({
        sessionId: resolvedSessionId,
        prompt: envelope.content,
        cwd: launch.cwd,
        workspaceRoot: launch.workspaceRoot,
        model: resolvedModel,
        permissionProfile: launch.permissionProfile,
        clientMessageId: envelope.clientMessageId,
        attachmentsCount: envelope.attachments?.length ?? 0,
        messageMetadata: this.getMessageMetadata(envelope),
        durableLifecycle,
      }));
      return;
    }
    if (engine.kind === 'mimo_code') {
      const launch = resolveExternalEngineLaunch(session, engine, envelope.context?.workingDirectory ?? effectiveWorkingDirectory);
      orchestrator?.setWorkingDirectory(launch.cwd);
      const resolvedModel = await getRemoteAgentEngineModelCatalogService().resolveModelId('mimo_code', launch.model);
      const durableLifecycle = await this.startExternalLifecycle({ engine: engine.kind, sessionId: resolvedSessionId, workspace: launch.workspaceRoot, cwd: launch.cwd });
      await this.executeExternalRun(durableLifecycle, () => new MimoCliAdapter().run({
        sessionId: resolvedSessionId,
        prompt: envelope.content,
        cwd: launch.cwd,
        workspaceRoot: launch.workspaceRoot,
        model: resolvedModel,
        permissionProfile: launch.permissionProfile,
        clientMessageId: envelope.clientMessageId,
        attachmentsCount: envelope.attachments?.length ?? 0,
        messageMetadata: this.getMessageMetadata(envelope),
        durableLifecycle,
      }));
      return;
    }
    if (engine.kind === 'kimi_code') {
      const launch = resolveExternalEngineLaunch(session, engine, envelope.context?.workingDirectory ?? effectiveWorkingDirectory);
      orchestrator?.setWorkingDirectory(launch.cwd);
      const resolvedModel = await getRemoteAgentEngineModelCatalogService().resolveModelId('kimi_code', launch.model);
      const durableLifecycle = await this.startExternalLifecycle({ engine: engine.kind, sessionId: resolvedSessionId, workspace: launch.workspaceRoot, cwd: launch.cwd });
      // Kimi CLI 不读 env API key；per-user KIMI_CODE_HOME 凭据隔离目录由后续凭据接口派生后
      // 通过 KimiCliRunRequest.kimiCodeHome 注入（当前沿用 env.KIMI_CODE_HOME / CLI 默认）。
      await this.executeExternalRun(durableLifecycle, () => new KimiCliAdapter().run({
        sessionId: resolvedSessionId,
        prompt: envelope.content,
        cwd: launch.cwd,
        workspaceRoot: launch.workspaceRoot,
        model: resolvedModel,
        permissionProfile: launch.permissionProfile,
        clientMessageId: envelope.clientMessageId,
        attachmentsCount: envelope.attachments?.length ?? 0,
        messageMetadata: this.getMessageMetadata(envelope),
        durableLifecycle,
      }));
      return;
    }

    if (effectiveWorkingDirectory) {
      orchestrator?.setWorkingDirectory(effectiveWorkingDirectory);
    }
    // 无显式值时用本轮实际生效目录（含 orchestrator fallback）补写，
    // 否则未持久化的会话每次重开都可能解析到不同目录（562/1732 会话曾漂移）；
    // sync 内部的相等守卫保证已持久化的值不会被覆盖
    await this.syncSessionWorkingDirectory(
      resolvedSessionId,
      envelope.context?.workingDirectory ?? effectiveWorkingDirectory ?? orchestrator?.getWorkingDirectory(),
    );

    const options = withWorkbenchTurnSystemContext(
      envelope.options as AppServiceRunOptions | undefined,
      envelope.context,
    );
    await tm.startTask(
      resolvedSessionId,
      envelope.content,
      envelope.attachments,
      toAgentRunOptions(options),
      await this.getMessageMetadataWithLocator(envelope),
      envelope.clientMessageId,
    );
  }

  cancel(
    sessionId?: string,
    reason?: 'user' | 'session-switch' | CancellationReason,
  ): Promise<void> {
    const tm = this.getTaskManager();
    const resolvedSessionId = this.resolveSessionId(sessionId);
    if (!resolvedSessionId) return Promise.reject(new Error('No active session'));

    // Normalize legacy 'user' alias to 'user-cancel' for the cascade contract.
    const normalizedReason: CancellationReason = reason === 'user'
      ? 'user-cancel'
      : normalizeCancellationReason(reason);

    // In-flight dedupe — second ESC during first cancel should reuse the
    // same shutdown promise (idempotent, prevents double-flush race).
    const existing = this.cancelInFlight.get(resolvedSessionId);
    if (existing) {
      return existing;
    }

    const promise = (async () => {
      try {
        // Keep the legacy path synchronous through fan-out and cancelTask().
        // Awaiting an optional call still yields when the service is absent,
        // which lets a second ESC arrive before cancelInFlight is registered.
        const externalView = this.durableRunReadService
          ? await this.durableRunReadService.readExternalEngine(resolvedSessionId, () => {
            const legacy = this.externalRunRegistry?.getBySessionId(resolvedSessionId);
            return {
              runId: legacy?.context.runId,
              status: legacy ? 'running' : 'idle',
              engine: legacy ? { kind: 'external_cli' as const, engine: 'codex_cli' as const } : null,
            };
          })
          : undefined;
        const externalHandle = externalView?.terminal
          ? undefined
          : this.externalRunRegistry?.getBySessionId(resolvedSessionId);
        if (externalHandle) {
          await externalHandle.cancel(normalizedReason === 'session-switch' ? 'session-switch' : 'user');
          return;
        }
        // Release run-scoped waiters before awaiting the primary task shutdown.
        // A subagent can be blocked on plan/launch approval while the primary
        // orchestrator waits for that subagent to exit, so reversing this order
        // would deadlock session cancellation.
        if (
          hasSwarmServices() &&
          (normalizedReason === 'user-cancel' ||
            normalizedReason === 'session-switch' ||
            normalizedReason === 'parent-cancel')
        ) {
          try {
            const services = getSwarmServices();
            services.planApproval.cancelSession(resolvedSessionId, normalizedReason);
            services.launchApproval.cancelSession(resolvedSessionId, normalizedReason);
            const cancelled = services.spawnGuard.cancelSession(resolvedSessionId, normalizedReason);
            if (cancelled > 0) {
              logger.info(
                `[appService.cancel] spawnGuard cancelled ${cancelled} subagents reason=${normalizedReason}`,
              );
            }
            services.parallelCoordinators.abortSession(resolvedSessionId, normalizedReason);
          } catch (err) {
            logger.warn('[appService.cancel] subagent cascade fan-out failed', err);
          }
        }

        const state = tm.getSessionState(resolvedSessionId);
        if (isTaskManagerOwnedRunState(state.status)) {
          await tm.cancelTask(resolvedSessionId);
        } else {
          const orchestrator = this.getOrchestratorOrThrow(resolvedSessionId);
          // Legacy orchestrator.cancel signature accepts 'user' | 'session-switch'
          // — map our cascade reasons back for backward compatibility.
          const legacyReason = normalizedReason === 'session-switch'
            ? 'session-switch'
            : 'user';
          await orchestrator.cancel(legacyReason);
        }
      } finally {
        this.cancelInFlight.delete(resolvedSessionId);
      }
    })();
    this.cancelInFlight.set(resolvedSessionId, promise);
    return promise;
  }

  handlePermissionResponse(requestId: string, response: PermissionResponse, sessionId?: string): void {
    const orchestrator = this.getOrchestratorOrThrow(sessionId);
    orchestrator.handlePermissionResponse(requestId, response);
  }

  async interruptAndContinue(envelope: ConversationEnvelope): Promise<void> {
    const tm = this.getTaskManager();
    const resolvedSessionId = this.resolveSessionId(envelope.sessionId);
    if (!resolvedSessionId) throw new Error('No active session');
    const orchestrator = this.getOrchestrator(resolvedSessionId);
    const session = await getSessionManager().getSession(resolvedSessionId, 1);
    const engine = normalizeAgentEngineSession(session?.engine);
    if (isExternalAgentEngine(engine.kind)) {
      throw new Error('Interrupt and continue is not supported for external Agent Engine sessions.');
    }
    const effectiveWorkingDirectory = await this.resolveWorkingDirectory(
      resolvedSessionId,
      envelope.context?.workingDirectory,
    );
    if (effectiveWorkingDirectory) {
      orchestrator?.setWorkingDirectory(effectiveWorkingDirectory);
    }
    await this.syncSessionWorkingDirectory(
      resolvedSessionId,
      envelope.context?.workingDirectory ?? effectiveWorkingDirectory ?? orchestrator?.getWorkingDirectory(),
    );
    const options = withWorkbenchTurnSystemContext(
      envelope.options as AppServiceRunOptions | undefined,
      envelope.context,
    );
    await tm.interruptAndContinue(
      resolvedSessionId,
      envelope.content,
      envelope.attachments,
      toAgentRunOptions(options),
      await this.getMessageMetadataWithLocator(envelope),
      envelope.clientMessageId,
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
    const hasExplicitWorkingDirectory = Object.prototype.hasOwnProperty.call(config ?? {}, 'workingDirectory');
    const requestedWorkingDirectory = typeof config?.workingDirectory === 'string'
      ? config.workingDirectory.trim()
      : undefined;
    const workingDirectory = hasExplicitWorkingDirectory
      ? requestedWorkingDirectory
      : this.getWorkingDirectory();

    const requestedEngine = normalizeAgentEngineSession(config?.engine);
    if (config?.engine && isExternalAgentEngine(requestedEngine.kind)) {
      throw new Error('External Agent Engine selection must be done after creating a manual chat session.');
    }

    const session = await sessionManager.createSession({
      title: config?.title || 'New Session',
      modelConfig: resolveSessionDefaultModelConfig({
        provider: settings.model?.provider,
        model: settings.model?.model,
        temperature: settings.model?.temperature,
        maxTokens: settings.model?.maxTokens,
	      }),
	      workingDirectory,
	      engine: config?.engine ? requestedEngine : undefined,
	      metadata: config?.metadata,
	    });

    sessionManager.setCurrentSession(session.id);
    this._setCurrentSessionId(session.id);

    const taskManager = this.getTaskManager();
    taskManager.cleanup(session.id);
    taskManager.setCurrentSessionId(session.id);
    const orchestrator = taskManager.getOrCreateCurrentOrchestrator(session.id);
    if (orchestrator && workingDirectory?.trim()) {
      orchestrator.setWorkingDirectory(workingDirectory);
    }

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

    // 会话级模型切换跨重启恢复：按持久化标记回灌内存 Map（未切换的会话无标记，不受影响）
    rehydrateModelOverrideFromSession(session);

    const streamSnapshot = loadStreamSnapshot({
      workingDir: session.workingDirectory,
      sessionId: session.id,
    });
    if (streamSnapshot?.sessionId === session.id) {
      return { ...session, streamSnapshot };
    }

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
        modelConfig: resolveSessionDefaultModelConfig({
          provider: settings.model?.provider,
          model: settings.model?.model,
          temperature: settings.model?.temperature,
          maxTokens: settings.model?.maxTokens,
        }),
      });

      sessionManager.setCurrentSession(newSession.id);
      this._setCurrentSessionId(newSession.id);
    }
  }

  async listSessions(options?: { includeArchived?: boolean }): Promise<Session[]> {
    return getSessionManager().listSessions({ includeArchived: options?.includeArchived });
  }

  async updateSession(sessionId: string, updates: Partial<Session>): Promise<void> {
    if (updates.engine !== undefined) {
      throw new Error('Agent Engine metadata must be changed through the Agent Engine selector.');
    }
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

  async getSessionTasks(sessionId: string): Promise<SessionTask[]> {
    return listTasks(sessionId);
  }

  async rewindToPrompt(params: { sessionId: string; userMessageId: string }): Promise<PromptRewindResult> {
    const { sessionId, userMessageId } = params;
    const tm = this.getTaskManager();
    const state = tm.getSessionState(sessionId);
    if (isTaskManagerOwnedRunState(state.status)) {
      throw new Error('Cannot rewind while the session is running');
    }

    const db = getDatabase();
    const anchorMessage = db.getMessageById(sessionId, userMessageId);
    if (anchorMessage?.role !== 'user') {
      throw new Error(`Active user message not found: ${userMessageId}`);
    }

    const checkpointService = getFileCheckpointService();
    const checkpoint = await checkpointService.getFirstCheckpointAtOrAfter(
      sessionId,
      anchorMessage.timestamp,
    );

    let filesRestored = 0;
    let filesDeleted = 0;
    const errors: string[] = [];

    if (checkpoint) {
      const rewindFilesResult = await checkpointService.rewindFiles(sessionId, checkpoint.messageId);
      filesRestored = rewindFilesResult.restoredFiles.length;
      filesDeleted = rewindFilesResult.deletedFiles.length;
      if (!rewindFilesResult.success) {
        const message = rewindFilesResult.errors.map((item) => item.error).filter(Boolean).join('; ')
          || 'File checkpoint rewind failed';
        throw new Error(message);
      }
      errors.push(...rewindFilesResult.errors.map((item) => item.error).filter(Boolean));
    }

    const sessionManager = getSessionManager();
    const rewindResult = await sessionManager.applyPromptRewind(sessionId, userMessageId, {
      checkpointMessageId: checkpoint?.messageId ?? null,
      filesRestored,
      filesDeleted,
      errors,
    });

    tm.setSessionContext(sessionId, rewindResult.activeMessages);

    return {
      success: true,
      sessionId,
      rewindId: rewindResult.rewindId,
      draft: {
        content: anchorMessage.content,
        attachments: anchorMessage.attachments,
      },
      activeMessages: rewindResult.activeMessages,
      hiddenMessageCount: rewindResult.hiddenMessageCount,
      filesRestored,
      filesDeleted,
    };
  }

  getSerializedCompressionState(sessionId?: string): string | null {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    if (!resolvedSessionId) return null;

    const orchestrator = this.getTaskManager().getOrchestrator(resolvedSessionId);
    const liveState = orchestrator?.getSerializedCompressionState() ?? null;
    if (liveState) return liveState;

    try {
      return getSessionManager().getSessionRuntimeState(resolvedSessionId)?.compressionStateJson ?? null;
    } catch {
      return null;
    }
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

  async exportSessionDiagnostics(sessionId: string): Promise<SessionLogExport> {
    return buildSessionLogExport(sessionId);
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

  async switchModel(params: SwitchModelParams): Promise<ModelOverridePersistResult> {
    const modelState = getModelSessionState();
    const override = {
      provider: params.provider as ModelProvider,
      model: params.model,
      temperature: params.temperature,
      maxTokens: params.maxTokens,
      adaptive: params.adaptive,
    };
    modelState.setOverride(params.sessionId, override);
    // 落库让切换跨重启存活；失败不抛（内存 override 本轮仍生效），
    // persisted 标志透出到响应（audit R1-HIGH2：失败不完全静默）
    const persisted = await persistModelOverride(params.sessionId, override);
    return { persisted };
  }

  getModelOverride(sessionId: string): ModelOverride | undefined {
    const modelState = getModelSessionState();
    const existing = modelState.getOverride(sessionId) as ModelOverride | undefined;
    if (existing) return existing;
    // 对称回灌（audit R2）：web domain 路径已在重启后按持久化标记回灌，
    // IPC 路径首次查询同样要看得到标记（否则 ModelSwitcher 在 loadSession
    // 完成前拉到 null 且不再重拉）。getDatabase().getSession 是同步调用；
    // 带 owner filter（audit R3-LOW），与 sessionManager 的可访问性口径一致。
    try {
      const session = getDatabase().getSession(sessionId, {
        userId: getAuthService().getCurrentUser()?.id ?? null,
      });
      return (rehydrateModelOverrideFromSession(session ?? null) ?? undefined) as ModelOverride | undefined;
    } catch {
      return undefined;
    }
  }

  async clearModelOverride(sessionId: string): Promise<ModelOverridePersistResult> {
    const modelState = getModelSessionState();
    modelState.clearOverride(sessionId);
    const persisted = await clearPersistedModelOverride(sessionId);
    return { persisted };
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
    orchestrator.setEffortLevel(normalizeAgentEffortLevel(level));
  }

  setThinkingEnabled(enabled: boolean): void {
    const orchestrator = this.getOrchestratorOrThrow();
    orchestrator.setThinkingEnabled(enabled);
  }

  // === Interaction Mode ===

  setInteractionMode(mode: import('../../shared/contract/agent').InteractionMode): void {
    const orchestrator = this.getOrchestratorOrThrow();
    orchestrator.setInteractionMode(mode);
  }

  // === Pause / Resume ===

  pause(sessionId?: string): void {
    const tm = this.getTaskManager();
    const resolvedSessionId = this.resolveSessionId(sessionId);
    if (!resolvedSessionId) throw new Error('No active session');
    if (!tm.pauseTask(resolvedSessionId)) {
      const orchestrator = this.getOrchestratorOrThrow(resolvedSessionId);
      orchestrator.pause();
    }
  }

  resume(sessionId?: string): void {
    const tm = this.getTaskManager();
    const resolvedSessionId = this.resolveSessionId(sessionId);
    if (!resolvedSessionId) throw new Error('No active session');
    if (!tm.resumeTask(resolvedSessionId)) {
      const orchestrator = this.getOrchestratorOrThrow(resolvedSessionId);
      orchestrator.resume();
    }
  }
}
