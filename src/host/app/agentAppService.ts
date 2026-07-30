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
  RestoreWorkspaceFilesAtCheckpointRequest,
  RestoreWorkspaceFilesAtCheckpointResult,
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
import type { PermissionDeliveryOutcome } from '../../shared/contract/permission';
import { closeDeadParkedApproval } from '../agent/parkedApprovalHydration';
import type { ConfigService } from '../services';
import { getSessionManager, type SessionWithMessages } from '../services';
import { createLogger } from '../services/infra/logger';
import { getDatabase } from '../services/core/databaseService';
import { getAuthService } from '../services/auth/authService';
import { applyPromptCommandExpansion } from '../services/commands/promptCommandService';
import { normalizeAgentEffortLevel } from '../../shared/effortLevels';
import type { AgentRunOptions } from '../research/types';
import type { SteerOrQueueOutcome } from '../runtime/steerQueueFence';
import type {
  CreateSessionForkRequest,
  CreateSessionForkResult,
  SessionForkLineageSummary,
} from '../../shared/contract/sessionFork';
import {
  DEFAULT_EXTERNAL_FORK_CONTEXT_POLICY,
  SessionForkRuntimeContextService,
  type PreparedSessionForkRuntimeContext,
} from '../services/sessionFork/context';
import type {
  RestoreConversationRewindRequest,
  RestoreConversationRewindResult,
  RewindConversationRequest,
  RewindConversationResult,
} from '../../shared/contract/sessionRewind';

const logger = createLogger('AgentAppService');
import { getModelSessionState } from '../session/modelSessionState';
import {
  clearPersistedModelOverride,
  persistModelOverride,
  rehydrateModelOverrideFromSession,
} from '../session/modelOverridePersistence';
import type {
  ConversationEnvelope,
  ConversationEnvelopeContext,
  WorkbenchMessageMetadata,
} from '../../shared/contract/conversationEnvelope';
import { withWorkbenchTurnSystemContext } from './workbenchTurnContext';
import { getPermissionModeManager } from '../permissions/modes';
import {
  exportSessionToMarkdown,
  suggestExportFilename,
} from '../session/exportMarkdown';
import { materializeGenerativeUIFallbacks } from '../services/generativeUI/generativeUIExport';
import { getGenerativeUIRepository } from '../services/generativeUI/generativeUIRepositoryAccess';
import { buildSessionLogExport } from '../telemetry/diagnosticBundleService';
import { getSwarmServices, hasSwarmServices } from '../agent/swarmServices';
import type { CancellationReason } from '../../shared/contract/cancellation';
import { normalizeCancellationReason } from '../../shared/contract/cancellation';
import { AGENT_ENGINE_LABELS, normalizeAgentEngineSession } from '../../shared/contract/agentEngine';
import {
  ClaudeCodeAdapter,
  CodeBuddyCliAdapter,
  CodexCliAdapter,
  GrokCliAdapter,
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
import { getProjectService } from '../services/project/projectService';
import { getLibraryService } from '../services/library/libraryService';
import { resolveSessionWorkspaceScope } from '../services/sessionFork/workspace';
import { getLogsPath } from '../platform/appPaths';
import {
  createClaudeContinuationResumeLaunch,
  createCodexContinuationResumeLaunch,
} from '../services/agentEngine/externalEngineResumeBuilders';
import {
  projectDurableRunToSessionPayload,
  type DurableRunReadService,
} from './durableRunReadService';
import { listTasks } from '../services/planning/taskStore';
import { upgradeLegacyAnchor } from '../tools/artifacts/artifactLocatorHost';
import { SessionHistoryAppService } from './sessionHistoryAppService';
import { SessionLifecycleAppService } from './sessionLifecycleAppService';
import { toCachedSession } from './sessionExportCache';

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
  private readonly sessionHistory: SessionHistoryAppService;
  private readonly sessionLifecycle: SessionLifecycleAppService;

  constructor(
    private getTaskManager: () => TaskManager,
    getConfigService: () => ConfigService | null,
    private _getCurrentSessionId: () => string | null,
    private _setCurrentSessionId: (id: string) => void,
    private readonly externalRunRegistry?: RunRegistry,
    private readonly durableRunReadService?: DurableRunReadService,
  ) {
    this.sessionHistory = new SessionHistoryAppService(getTaskManager, durableRunReadService);
    this.sessionLifecycle = new SessionLifecycleAppService({
      getTaskManager,
      getConfigService,
      getCurrentSessionId: _getCurrentSessionId,
      setCurrentSessionId: _setCurrentSessionId,
      getWorkingDirectory: () => this.getWorkingDirectory(),
    });
  }

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

  private prepareExternalForkContext(
    sessionId: string,
    engine: ExternalAgentEngineKind,
    firstUserPrompt: string,
  ): Promise<PreparedSessionForkRuntimeContext | null> {
    return new SessionForkRuntimeContextService(getDatabase()).prepareFirstChildRun({
      childSessionId: sessionId,
      engine,
      firstUserPrompt,
      policy: DEFAULT_EXTERNAL_FORK_CONTEXT_POLICY,
    });
  }

  private isExplicitForkChild(sessionId: string): boolean {
    return Boolean(getDatabase().getSessionForkLineage(
      sessionId,
      getAuthService().getCurrentUser()?.id ?? null,
    ));
  }

  private async withDurableSessionReplayPayload(session: Session): Promise<Session> {
    if (!this.durableRunReadService) {
      return session;
    }
    const { durableWaitingInput: _durableWaitingApproval, ...base } = session;
    const run = await this.durableRunReadService.readSessionReplay(session.id, () => ({
      status: session.status === 'running' || session.status === 'paused' ? session.status : 'idle',
      updatedAt: session.updatedAt,
    }));
    return {
      ...base,
      ...projectDurableRunToSessionPayload(run),
    };
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
    if (context.pendingCommand) {
      metadata.pendingCommand = { ...context.pendingCommand };
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
    // UX round2 20f：pin 资料是会话级状态、不在 envelope——持久化 user message 时
    // 由 host 把当前 pin 条目 id+标题快照进 metadata，回放 chip 行按快照渲染（事后改 pin 不漂移）。
    const pinnedLibraryItems = this.getPinnedLibrarySnapshot(envelope.sessionId);
    const merged = workbench || pinnedLibraryItems
      ? { ...(workbench ?? {}), ...(pinnedLibraryItems ? { pinnedLibraryItems } : {}) }
      : undefined;
    return merged ? { workbench: merged } : undefined;
  }

  private getPinnedLibrarySnapshot(sessionId?: string): Array<{ id: string; title: string }> | undefined {
    const resolvedSessionId = this.resolveSessionId(sessionId);
    if (!resolvedSessionId) return undefined;
    try {
      const items = getLibraryService().getPinnedItems(resolvedSessionId);
      return items.length > 0
        ? items.map((item) => ({ id: item.id, title: item.title }))
        : undefined;
    } catch {
      // pin 快照是展示增强，library 未初始化等失败不阻塞发送
      return undefined;
    }
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

  // === Agent Operations ===

  async sendMessage(envelope: ConversationEnvelope): Promise<void> {
    const tm = this.getTaskManager();
    const resolvedSessionId = this.resolveSessionId(envelope.sessionId);
    if (!resolvedSessionId) throw new Error('No active session');
    const sessionManager = getSessionManager();
    const session = await sessionManager.getSession(resolvedSessionId, 1);
    const engine = normalizeAgentEngineSession(session?.engine);
    const orchestrator = this.getOrchestrator(resolvedSessionId);
    const sessionWorkspaceScope = resolveSessionWorkspaceScope(
      session,
      getAuthService().getCurrentUser()?.id ?? null,
      getDatabase(),
      getProjectService(),
    );
    const requestedWorkingDirectory = await this.resolveWorkingDirectory(
      resolvedSessionId,
      envelope.context?.workingDirectory,
    );
    const effectiveWorkingDirectory = sessionWorkspaceScope?.version.startsWith('isolated-v1:')
      ? sessionWorkspaceScope.primaryRoot
      : requestedWorkingDirectory;
    if (sessionWorkspaceScope?.version.startsWith('isolated-v1:')) {
      envelope = {
        ...envelope,
        context: {
          ...(envelope.context ?? {}),
          workingDirectory: sessionWorkspaceScope.primaryRoot,
        },
      };
    }
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
    const externalRequestedCwd = sessionWorkspaceScope?.version.startsWith('isolated-v1:')
      ? sessionWorkspaceScope.primaryRoot
      : envelope.context?.workingDirectory ?? effectiveWorkingDirectory;
    if (engine.kind === 'codex_cli') {
      const launch = resolveExternalEngineLaunch(session, engine, externalRequestedCwd, sessionWorkspaceScope);
      orchestrator?.setWorkingDirectory(launch.cwd);
      const resolvedModel = await getRemoteAgentEngineModelCatalogService().resolveModelId('codex_cli', launch.model, { strict: true });
      const persistedExternalSessionId = this.isExplicitForkChild(resolvedSessionId)
        ? engine.externalSessionId?.trim() || undefined
        : undefined;
      if (persistedExternalSessionId) {
        new SessionForkRuntimeContextService(getDatabase()).assertConsumedForResume(
          resolvedSessionId,
          engine.kind,
        );
      }
      const forkContext = persistedExternalSessionId
        ? null
        : await this.prepareExternalForkContext(
            resolvedSessionId,
            engine.kind,
            envelope.content,
          );
      const durableLifecycle = await this.startExternalLifecycle({
        engine: engine.kind,
        sessionId: resolvedSessionId,
        workspace: launch.workspaceRoot,
        cwd: launch.cwd,
        externalSessionId: persistedExternalSessionId,
      });
      if (persistedExternalSessionId && !durableLifecycle) {
        throw new Error('Codex continuation requires durable lifecycle identity');
      }
      const resumeLaunch = persistedExternalSessionId && durableLifecycle
        ? createCodexContinuationResumeLaunch({
            lifecycle: durableLifecycle,
            sessionId: resolvedSessionId,
            persistedExternalSessionId,
            cwd: launch.cwd,
            model: resolvedModel,
            continuationInput: envelope.content,
            permissionProfile: launch.permissionProfile,
            logsRoot: getLogsPath(),
          })
        : undefined;
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
        resumeLaunch,
        ...(forkContext ? {
          forkContextHandoff: forkContext.handoff,
          onForkContextDispatchStart: forkContext.onDispatchStart,
          onForkContextDispatched: forkContext.onDispatched,
        } : {}),
      }));
      return;
    }
    if (engine.kind === 'claude_code') {
      const launch = resolveExternalEngineLaunch(session, engine, externalRequestedCwd, sessionWorkspaceScope);
      orchestrator?.setWorkingDirectory(launch.cwd);
      const resolvedModel = await getRemoteAgentEngineModelCatalogService().resolveModelId('claude_code', launch.model, { strict: true });
      const persistedExternalSessionId = this.isExplicitForkChild(resolvedSessionId)
        ? engine.externalSessionId?.trim() || undefined
        : undefined;
      if (persistedExternalSessionId) {
        new SessionForkRuntimeContextService(getDatabase()).assertConsumedForResume(
          resolvedSessionId,
          engine.kind,
        );
      }
      const forkContext = persistedExternalSessionId
        ? null
        : await this.prepareExternalForkContext(
            resolvedSessionId,
            engine.kind,
            envelope.content,
          );
      const durableLifecycle = await this.startExternalLifecycle({
        engine: engine.kind,
        sessionId: resolvedSessionId,
        workspace: launch.workspaceRoot,
        cwd: launch.cwd,
        externalSessionId: persistedExternalSessionId,
      });
      if (persistedExternalSessionId && !durableLifecycle) {
        throw new Error('Claude continuation requires durable lifecycle identity');
      }
      const resumeLaunch = persistedExternalSessionId && durableLifecycle
        ? createClaudeContinuationResumeLaunch({
            lifecycle: durableLifecycle,
            sessionId: resolvedSessionId,
            persistedExternalSessionId,
            cwd: launch.cwd,
            model: resolvedModel,
            continuationInput: envelope.content,
            permissionProfile: launch.permissionProfile,
          })
        : undefined;
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
        resumeLaunch,
        ...(forkContext ? {
          forkContextHandoff: forkContext.handoff,
          onForkContextDispatchStart: forkContext.onDispatchStart,
          onForkContextDispatched: forkContext.onDispatched,
        } : {}),
      }));
      return;
    }
    if (engine.kind === 'mimo_code') {
      const launch = resolveExternalEngineLaunch(session, engine, externalRequestedCwd, sessionWorkspaceScope);
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
      const launch = resolveExternalEngineLaunch(session, engine, externalRequestedCwd, sessionWorkspaceScope);
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
    if (engine.kind === 'codebuddy_code') {
      const launch = resolveExternalEngineLaunch(
        session,
        engine,
        externalRequestedCwd,
        sessionWorkspaceScope,
      );
      orchestrator?.setWorkingDirectory(launch.cwd);
      const resolvedModel = await getRemoteAgentEngineModelCatalogService()
        .resolveModelId('codebuddy_code', launch.model);
      const durableLifecycle = await this.startExternalLifecycle({
        engine: engine.kind,
        sessionId: resolvedSessionId,
        workspace: launch.workspaceRoot,
        cwd: launch.cwd,
      });
      await this.executeExternalRun(durableLifecycle, () => new CodeBuddyCliAdapter().run({
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
    if (engine.kind === 'grok_cli') {
      const launch = resolveExternalEngineLaunch(
        session,
        engine,
        externalRequestedCwd,
        sessionWorkspaceScope,
      );
      orchestrator?.setWorkingDirectory(launch.cwd);
      const resolvedModel = await getRemoteAgentEngineModelCatalogService()
        .resolveModelId('grok_cli', launch.model, { strict: true });
      const durableLifecycle = await this.startExternalLifecycle({
        engine: engine.kind,
        sessionId: resolvedSessionId,
        workspace: launch.workspaceRoot,
        cwd: launch.cwd,
      });
      await this.executeExternalRun(durableLifecycle, () => new GrokCliAdapter().run({
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
      sessionWorkspaceScope?.version.startsWith('isolated-v1:')
        ? sessionWorkspaceScope.primaryRoot
        : envelope.context?.workingDirectory ?? effectiveWorkingDirectory ?? orchestrator?.getWorkingDirectory(),
    );

    const options = withWorkbenchTurnSystemContext(
      envelope.options as AppServiceRunOptions | undefined,
      envelope.context,
    );

    // 云货架专家首跑：本轮档位钳到最严，让用户看见它每一步要干什么。
    // 必须挂在**主 agent 轮起点**——用户在输入框选中专家后说话，专家就是主 agent
    // （preferredAgentId → agentOverrideId），不经过 subagentExecutor。
    // PR #690 钩错成子 agent 那条路，真机 dogfood 因此判 NO-GO（两轮行为无差别）。
    const turnRoleId = envelope.context?.preferredAgentId ?? options?.agentOverrideId ?? undefined;
    let firstRunStrictSessionId: string | undefined;
    if (turnRoleId) {
      const { consumeFirstRunStrict } = await import('../services/roleAssets/rolePackInstallService');
      if (await consumeFirstRunStrict(turnRoleId)) {
        getPermissionModeManager().markFirstRunStrictSession(resolvedSessionId);
        firstRunStrictSessionId = resolvedSessionId;
      }
    }

    try {
      await tm.startTask(
        resolvedSessionId,
        envelope.content,
        envelope.attachments,
        toAgentRunOptions(options),
        await this.getMessageMetadataWithLocator(envelope),
        envelope.clientMessageId,
      );
    } finally {
      // 只钳这一轮：第二轮起回到会话自己的档（dogfood 明确要求两轮可见差别）。
      if (firstRunStrictSessionId) {
        getPermissionModeManager().clearFirstRunStrictSession(firstRunStrictSessionId);
      }
    }
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
        const registeredHandle = this.externalRunRegistry?.getBySessionId(resolvedSessionId);
        const externalView = this.durableRunReadService
          ? await this.durableRunReadService.readExternalEngine(resolvedSessionId, () => {
            return {
              runId: registeredHandle?.context.runId,
              status: registeredHandle ? 'running' : 'idle',
              engine: null,
            };
          })
          : undefined;
        const durableExternalHandle = externalView?.terminal === false
          && externalView.engine?.kind === 'external_cli'
          && externalView.runId === registeredHandle?.context.runId
          ? registeredHandle
          : undefined;
        const externalHandle = this.durableRunReadService
          ? durableExternalHandle
          : registeredHandle;
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

  handlePermissionResponse(requestId: string, response: PermissionResponse, sessionId?: string): PermissionDeliveryOutcome {
    // 停车审批的宿主可能已随进程重启消失（D0 根因，2026-07-27）：
    // 找不到宿主/内存 pending 已丢时，把 DB 行 fail-closed 拒绝收尾，
    // 返回类型化结果而不是裸抛或静默丢弃。
    let outcome: PermissionDeliveryOutcome;
    try {
      outcome = this.getOrchestratorOrThrow(sessionId).handlePermissionResponse(requestId, response);
    } catch (err) {
      if (closeDeadParkedApproval(requestId)) return 'no_orchestrator';
      throw err;
    }
    if (outcome === 'unknown_request') closeDeadParkedApproval(requestId);
    return outcome;
  }

  async interruptAndContinue(envelope: ConversationEnvelope): Promise<SteerOrQueueOutcome> {
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
    return tm.interruptAndContinue(
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
    return this.sessionLifecycle.createSession(config);
  }

  async loadSession(sessionId: string): Promise<Session> {
    return this.sessionLifecycle.loadSession(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    return this.sessionLifecycle.deleteSession(sessionId);
  }

  async listSessions(options?: { includeArchived?: boolean }): Promise<Session[]> {
    const sessions = await getSessionManager().listSessions({ includeArchived: options?.includeArchived });
    return Promise.all(sessions.map((session) => this.withDurableSessionReplayPayload(session)));
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

  async forkSession(params: CreateSessionForkRequest): Promise<CreateSessionForkResult> {
    return this.sessionHistory.forkSession(params);
  }

  async getForkLineage(sessionId: string): Promise<SessionForkLineageSummary | null> {
    return this.sessionHistory.getForkLineage(sessionId);
  }

  async listForkChildren(sessionId: string): Promise<SessionForkLineageSummary[]> {
    return this.sessionHistory.listForkChildren(sessionId);
  }

  async exportSessionFork(
    params: import('../../shared/contract/sessionForkPortability').ExportSessionForkRequest,
  ): Promise<import('../../shared/contract/sessionForkPortability').SessionExportEnvelopeV2> {
    return this.sessionHistory.exportSessionFork(params);
  }

  async importSessionFork(
    params: import('../../shared/contract/sessionForkPortability').ImportSessionForkRequest,
  ): Promise<import('../../shared/contract/sessionForkPortability').ImportSessionForkResponse> {
    return this.sessionHistory.importSessionFork(params);
  }

  async enqueueSessionForkSync(
    params: import('../../shared/contract/sessionForkPortability').EnqueueSessionForkSyncRequest,
  ): Promise<import('../../shared/contract/sessionForkPortability').SessionForkSyncEnvelopeRecord> {
    return this.sessionHistory.enqueueSessionForkSync(params);
  }

  async ingestSessionForkSync(
    params: import('../../shared/contract/sessionForkPortability').IngestSessionForkSyncRequest,
  ): Promise<import('../../shared/contract/sessionForkPortability').SessionForkSyncEnvelopeRecord> {
    return this.sessionHistory.ingestSessionForkSync(params);
  }

  async importReadySessionForkSync(
    params: import('../../shared/contract/sessionForkPortability').ImportReadySessionForkSyncRequest,
  ): Promise<import('../../shared/contract/sessionForkPortability').ImportReadySessionForkSyncResponse> {
    return this.sessionHistory.importReadySessionForkSync(params);
  }

  async searchSessionForkExports(
    params: import('../../shared/contract/sessionForkPortability').SearchSessionForkExportsRequest,
  ): Promise<import('../../shared/contract/sessionForkPortability').ForkSearchDocument[]> {
    return this.sessionHistory.searchSessionForkExports(params);
  }

  async readSessionForkTree(
    params: import('../../shared/contract/sessionForkPortability').ReadSessionForkTreeRequest,
  ): Promise<import('../../shared/contract/sessionForkPortability').ForkTreeNodeProjection> {
    return this.sessionHistory.readSessionForkTree(params);
  }

  async readSessionForkNeighborhood(
    params: import('../../shared/contract/sessionForkPortability').ReadSessionForkNeighborhoodRequest,
  ): Promise<import('../../shared/contract/sessionForkPortability').ForkNeighborhoodProjection> {
    return this.sessionHistory.readSessionForkNeighborhood(params);
  }

  async replayConversationBranch(
    sessionId: string,
    options?: { includeRewound?: boolean; allowRepairOverride?: boolean },
  ): Promise<import('../../shared/contract/conversationBranch').ConversationReplay> {
    return this.sessionHistory.replayConversationBranch(sessionId, options);
  }

  async compareConversationBranches(
    leftSessionId: string,
    rightSessionId: string,
  ): Promise<import('../../shared/contract/conversationBranch').ConversationBranchComparison> {
    return this.sessionHistory.compareConversationBranches(leftSessionId, rightSessionId);
  }

  async traceConversationProvenance(
    sessionId: string,
    messageId: string,
  ): Promise<import('../../shared/contract/conversationBranch').ConversationProvenanceTrace> {
    return this.sessionHistory.traceConversationProvenance(sessionId, messageId);
  }

  async auditConversationLineage(
    sessionId: string,
  ): Promise<import('../../shared/contract/conversationBranch').ConversationLineageAudit> {
    return this.sessionHistory.auditConversationLineage(sessionId);
  }

  async quarantineConversationLineage(
    sessionId: string,
    idempotencyKey: string,
  ): Promise<import('../../shared/contract/conversationBranch').ConversationLineageAudit> {
    return this.sessionHistory.quarantineConversationLineage(sessionId, idempotencyKey);
  }

  async repairConversationLineage(params: {
    sessionId: string;
    issueDigest: string;
    reason: string;
    idempotencyKey: string;
  }): Promise<import('../../shared/contract/conversationBranch').ConversationLineageAudit> {
    return this.sessionHistory.repairConversationLineage(params);
  }

  async recordConversationEvaluationAttribution(params: {
    sessionId: string;
    evaluationId: string;
    runId?: string | null;
    metric: string;
    value: number;
    attributedMessageIds: string[];
    idempotencyKey: string;
  }): Promise<import('../../shared/contract/conversationBranch').ConversationEvaluationAttribution> {
    return this.sessionHistory.recordConversationEvaluationAttribution(params);
  }

  async listConversationEvaluationAttributions(
    sessionId: string,
  ): Promise<import('../../shared/contract/conversationBranch').ConversationEvaluationAttribution[]> {
    return this.sessionHistory.listConversationEvaluationAttributions(sessionId);
  }

  async rewindConversation(params: RewindConversationRequest): Promise<RewindConversationResult> {
    return this.sessionHistory.rewindConversation(params);
  }

  async restoreWorkspaceFilesAtCheckpoint(
    params: RestoreWorkspaceFilesAtCheckpointRequest,
  ): Promise<RestoreWorkspaceFilesAtCheckpointResult> {
    return this.sessionHistory.restoreWorkspaceFilesAtCheckpoint(params);
  }

  async restoreConversationRewind(
    params: RestoreConversationRewindRequest,
  ): Promise<RestoreConversationRewindResult> {
    return this.sessionHistory.restoreConversationRewind(params);
  }

  async rewindToPrompt(
    params: { sessionId: string; userMessageId: string; idempotencyKey?: string },
  ): Promise<PromptRewindResult> {
    return this.sessionHistory.rewindToPrompt(params);
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

    const cachedSession = toCachedSession({
      ...session,
      messages: materializeGenerativeUIFallbacks(
        session.messages,
        getGenerativeUIRepository().listBySession(sessionId),
      ),
    });
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
