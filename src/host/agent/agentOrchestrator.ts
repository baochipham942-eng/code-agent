// ============================================================================
// Agent Orchestrator - Main controller for the AI agent
// ============================================================================

import type {
  AgentEvent,
  Message,
  MessageAttachment,
  MessageMetadata,
  PermissionResponse,
  ModelConfig,
} from '../../shared/contract';
import type { AgentRunOptions, ResearchUserSettings } from '../research/types';
import { AgentLoop } from './agentLoop';
import { buildGoalContract } from './goalModeController';
import { SYSTEM_PROMPT } from '../prompts/builder';
import { applyProviderVariant } from '../prompts/providerVariants';
import { ToolExecutor } from '../tools/toolExecutor';
import type { ExecutionTopology } from '../permissions';
import { getPermissionModeManager, rolePermissionPresetToMode } from '../permissions/modes';
import type { PermissionDeliveryOutcome } from '../../shared/contract/permission';
import type { ConfigService } from '../services/core/configService';
import { getSessionManager } from '../services';
import type { PlanningService } from '../planning';
import { DeepResearchMode, SemanticResearchOrchestrator } from '../research';
import { analyzeTask } from './hybrid/taskRouter';
import { getSessionStateManager } from '../session/sessionStateManager';
import { getContextHealthService } from '../context/contextHealthService';
import { generateMessageId } from '../../shared/utils/id';
import { createLogger } from '../services/infra/logger';
import { getAgentRequirementsAnalyzer } from './agentRequirementsAnalyzer';
import { getRoutingService } from '../routing';
import type { RoutingContext, RoutingResolution } from '../../shared/contract/agentRouting';
import { getTelemetryCollector } from '../telemetry';
import { taskComplexityAnalyzer } from '../planning/taskComplexityAnalyzer';
import type { EffortLevel } from '../../shared/contract/agent';
import { getTaskListManager, type TaskListManager } from './taskList';
import { getEventBus } from '../services/eventing';
import { getComboRecorder } from '../services/skills/comboRecorder';
import { resolveAgent as registryResolveAgent } from './agentRegistry';
import { buildRoutingResolvedEventData } from './routingResolvedEvent';
import { assembleTurnDenylist } from './routingToolPolicy';
import { queuePendingSteerMessagesOrWarn, steerOrQueue, type SteerOrQueueOutcome } from '../runtime/steerQueueFence';
import { startRunPreferringDurable } from './orchestrator/durableRunStart';
import { getUserPresenceToolNames } from '../tools/dispatch/toolDefinitions';
import { OrchestratorRunSettings } from './orchestratorRunSettings';
import { OrchestratorMessageHistory } from './orchestratorMessageHistory';
import { OrchestratorPermissionIsland } from './orchestratorPermissions';
import { applyTurnSystemContext, buildLiveVoicePermissionNotice } from './orchestratorTurnContext';
import {
  resolveExplicitAgentRouting,
  syncAutoAgentDAGStatus,
  initRunDag,
} from './orchestratorDagSync';
import { seedGoalContractForRun } from './orchestratorGoalSeed';

// Sub-modules
import { type AgentOrchestratorConfig } from './orchestrator/types';
import {
  resolveModelConfig,
  resolveRunModelConfig,
  resolveTurnModelConfig,
} from './orchestrator/modelConfigResolver';
import { runDeepResearch } from './orchestrator/researchRunner';
import { runAutoAgentMode } from './orchestrator/autoAgentRunner';
import { resolveNeoTagModelIntent } from '../services/project/neoTagModelIntentResolver';
import { createRunContext, type RunHandle } from '../runtime/runContext';
import { selectBackgroundWorkspaceScope } from '../runtime/workspaceAuthority';
import type { RunRegistry } from '../runtime/runRegistry';
import { getProjectService } from '../services/project/projectService';
import { resolveWorkspacePath } from '../runtime/workspaceScope';
import { resolveSessionWorkspaceScope } from '../services/sessionFork/workspace';
import { getAuthService } from '../services/auth/authService';
import { getDatabase } from '../services/core/databaseService';
import { IPC_CHANNELS } from '../../shared/ipc';
import type { AgentNoticeEvent } from '../../shared/ipc/handlers';
import type { WorkspaceScope } from '../../shared/contract/project';

export type { AgentOrchestratorConfig } from './orchestrator/types';

const logger = createLogger('AgentOrchestrator');

/**
 * agent:notice 广播（比照 inferenceProviderFallback.ts 的 broadcastAiSdkProviderFallback）。
 * 动态 import windowBridge，best-effort，不影响主链路。
 */
async function broadcastAgentNotice(event: AgentNoticeEvent): Promise<void> {
  try {
    const { broadcastToRenderer } = await import('../platform/windowBridge');
    broadcastToRenderer?.(IPC_CHANNELS.AGENT_NOTICE, event);
  } catch {
    /* toast 是 best-effort，不影响主链路 */
  }
}

interface PendingSteerMessage {
  content: string;
  /** 用户原话；`content` 可能带 turnSystemContext 脚手架，那份只给模型。 */
  displayContent?: string;
  clientMessageId?: string;
  attachments?: MessageAttachment[];
  messageMetadata?: MessageMetadata;
}

// ----------------------------------------------------------------------------
// Agent Orchestrator
// ----------------------------------------------------------------------------


export class AgentOrchestrator {
  private configService: ConfigService;
  private toolExecutor: ToolExecutor;
  private agentLoop: AgentLoop | null = null;
  private deepResearchMode: DeepResearchMode | null = null;
  private semanticResearchOrchestrator: SemanticResearchOrchestrator | null = null;
  private onEvent: (event: AgentEvent) => void;
  private workingDirectory: string;
  private isDefaultWorkingDirectory: boolean = true;
  private readonly runSettings: OrchestratorRunSettings;
  private readonly messageHistory: OrchestratorMessageHistory;
  private readonly permissions: OrchestratorPermissionIsland;
  private planningService?: PlanningService;
  // Real-time steering: 中断排队
  private isInterrupting: boolean = false;
  private pendingSteerMessages: PendingSteerMessage[] = [];

  // TaskList: 可视化任务管理
  private taskListManager: TaskListManager;
  private sessionId: string | null = null;
  private workspaceScopeAuthority?: WorkspaceScope;
  private activeRunPromise: Promise<void> | null = null;
  private readonly runRegistry?: RunRegistry;

  // Dependency injection: decoupled from Electron APIs
  private getHomeDir: () => string;
  private broadcastDAGEvent?: (event: import('../../shared/contract/dagVisualization').DAGVisualizationEvent) => void;

  constructor(config: AgentOrchestratorConfig) {
    this.configService = config.configService;
    this.onEvent = config.onEvent;
    this.getHomeDir = config.getHomeDir ?? (() => process.cwd());
    this.broadcastDAGEvent = config.broadcastDAGEvent;
    this.runRegistry = config.runRegistry;
    this.runSettings = new OrchestratorRunSettings();
    this.messageHistory = new OrchestratorMessageHistory(() => this.agentLoop);
    this.permissions = new OrchestratorPermissionIsland({
      getSettings: () => this.configService.getSettings(),
      getExecutionTopology: () => this.toolExecutor.getExecutionTopology(),
      onEvent: (event) => this.onEvent(event),
      injectedPendingApprovalRepo: config.pendingApprovalRepo,
    });

    this.workingDirectory = this.initializeWorkDirectory();
    this.isDefaultWorkingDirectory = true;
    logger.info('Initial working directory:', this.workingDirectory);
    this.planningService = config.planningService;

    this.toolExecutor = new ToolExecutor({
      requestPermission: this.permissions.requestPermission.bind(this.permissions),
      workingDirectory: this.workingDirectory,
      ledgerOrigin: 'desktop',
    });

    this.taskListManager = getTaskListManager();
  }

  private initializeWorkDirectory(): string {
    try {
      const homeDir = this.getHomeDir();
      logger.debug('Default working directory set to home:', homeDir);
      return homeDir;
    } catch (error) {
      logger.warn('Failed to get home path, falling back to cwd:', error);
      return process.cwd();
    }
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  /**
   * 标注本 orchestrator 的执行拓扑（2026-07-13 拓扑激活批）。cron/heartbeat 等
   * 无人值守路径在 sendMessage 前标 async_agent，让 TOPOLOGY_RULES 生效。
   */
  setExecutionTopology(topology: ExecutionTopology): void {
    this.toolExecutor.setExecutionTopology(topology);
  }

  async sendMessage(
    content: string,
    attachments?: unknown[],
    options?: AgentRunOptions,
    messageMetadata?: MessageMetadata,
    clientMessageId?: string,
  ): Promise<void> {
    // 新用户消息到达：任何仍挂起的权限请求都已过期。先 deny 解除，
    // 否则上一轮被权限 Promise 卡住的 agentLoop 会冻结到 60s 超时（确认死锁）。
    this.permissions.drainPendingPermissions('deny');

    const settings = this.configService.getSettings();
    const sessionManager = getSessionManager();
    const sessionId = await this.resolveSessionId();

    const userMessage: Message = {
      id: clientMessageId ?? this.generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      attachments: attachments as MessageAttachment[] | undefined,
      metadata: messageMetadata,
    };
    this.applyHistoryVisibility(userMessage, options);

    this.addMessage(userMessage);
    logger.debug('User message added, hasAttachments:', !!userMessage.attachments?.length, 'count:', userMessage.attachments?.length || 0);

    // Combo recording: start recording + mark this turn
    try {
      const recorder = getComboRecorder();
      if (sessionId) {
        recorder.startRecording(sessionId);
        recorder.markTurn(sessionId, content);
      }
    } catch {
      // Non-blocking
    }

    try {
      if (sessionId) {
        await sessionManager.addMessageToSession(sessionId, userMessage);
      } else {
        await sessionManager.addMessage(userMessage);
      }
    } catch (error) {
      logger.error('Failed to save user message:', error);
    }

    // 排队恢复的显式模型优先于 E4 会话 override；旧 envelope 仍沿用原解析链。
    let modelConfig = resolveRunModelConfig(
      this.configService,
      settings,
      sessionId,
      options?.modelSpec,
    );
    if (sessionId) {
      this.updateContextHealthSnapshot(sessionId, modelConfig.model);
    }

    // Session-aware event handler with telemetry
    let eventService: { saveEvent: (sid: string, event: AgentEvent) => void } | null = null;
    if (process.env.EVAL_DISABLED !== 'true') {
      try {
        const mod = await import('../evaluation/sessionEventService');
        eventService = mod.getSessionEventService();
      } catch { /* evaluation module not available */ }
    }
    const telemetryCollector = getTelemetryCollector();
    const sessionAwareOnEvent = (event: AgentEvent) => {
      this.onEvent({ ...event, sessionId } as AgentEvent & { sessionId?: string });
      if (sessionId) {
        eventService?.saveEvent(sessionId, event);
        telemetryCollector.handleEvent(sessionId, event);
      }
    };

    const neoTagModel = options?.neoTag
      ? resolveNeoTagModelIntent({
          baseConfig: modelConfig,
          modelIntent: options.neoTag.modelIntent,
          configService: this.configService,
        })
      : null;
    if (neoTagModel) {
      modelConfig = neoTagModel.modelConfig;
    }

    // Route to appropriate mode
    const mode = options?.mode ?? 'normal';

    if (mode === 'deep-research') {
      await this.runDeepResearchMode(content, options, sessionAwareOnEvent, modelConfig);
    } else if (mode === 'normal') {
      const analysis = analyzeTask(content);
      // An auxiliary slot has already been explicitly split and receives a constrained
      // tool surface. Auto-routing it into DeepResearch would silently switch providers
      // and bypass those run-level tool constraints, so keep it on the standard loop.
      if (!options?.disableAutoAgent && analysis.taskType === 'research') {
        logger.info('Auto-detected research task (keyword match), routing to deep research pipeline');
        await this.runDeepResearchMode(content, options, sessionAwareOnEvent, modelConfig);
      } else {
        await this.runNormalMode(content, sessionAwareOnEvent, modelConfig, sessionId ?? undefined, options);
      }
    } else {
      await this.runNormalMode(content, sessionAwareOnEvent, modelConfig, sessionId ?? undefined, options);
    }
  }

  private queuePendingSteer(pending: PendingSteerMessage[], sessionId: string | null, logContext: string): void {
    const asQueueable = pending.map(({ messageMetadata, ...m }) => ({ ...m, metadata: messageMetadata }));
    queuePendingSteerMessagesOrWarn(sessionId, asQueueable, logContext, logger);
  }

  async cancel(reason?: 'user' | 'session-switch'): Promise<void> {
    logger.info('Cancel requested', { reason });
    const sessionId = this.sessionId ?? getSessionManager().getCurrentSessionId();

    // 先解除挂起权限，否则 agentLoop 若正 await 在 requestPermission 上，
    // cancel 会一直等到 60s 超时才能真正 unwind。
    this.permissions.drainPendingPermissions('deny');

    this.isInterrupting = false;
    this.queuePendingSteer(this.pendingSteerMessages, sessionId, 'during cancel');
    this.pendingSteerMessages = [];

    if (this.agentLoop) {
      await this.agentLoop.cancel(reason);
      if (this.activeRunPromise) {
        try {
          await this.activeRunPromise;
        } catch (error) {
          logger.debug('[AgentOrchestrator] Agent loop finished after cancel with error', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        this.agentLoop = null;
        this.onEvent({
          type: 'agent_cancelled',
          data: null,
          sessionId,
        } as AgentEvent & { sessionId?: string });
      }
      return;
    }
    if (this.deepResearchMode) {
      this.deepResearchMode.cancel();
      this.deepResearchMode = null;
    }
    if (this.semanticResearchOrchestrator) {
      this.semanticResearchOrchestrator.cancel();
      this.semanticResearchOrchestrator = null;
    }

    this.onEvent({
      type: 'agent_cancelled',
      data: null,
      sessionId,
    } as AgentEvent & { sessionId?: string });
  }

  async interruptAndContinue(
    newMessage: string,
    attachments?: unknown[],
    options?: AgentRunOptions,
    messageMetadata?: MessageMetadata,
    clientMessageId?: string,
  ): Promise<SteerOrQueueOutcome> {
    logger.info('Interrupt and continue requested');
    const sessionManager = getSessionManager();
    const sessionId = this.sessionId ?? sessionManager.getCurrentSessionId();
    const effectiveMessage = this.applyTurnSystemContext(newMessage, options, sessionId);

    if (this.isInterrupting) {
      logger.info('[AgentOrchestrator] Already interrupting, queuing message');
      this.pendingSteerMessages.push({
        content: effectiveMessage,
        displayContent: newMessage,
        clientMessageId,
        attachments: attachments as MessageAttachment[] | undefined,
        messageMetadata,
      });
      return { outcome: 'steered' };
    }

    this.isInterrupting = true;

    this.onEvent({
      type: 'interrupt_start',
      data: { message: '正在调整方向...', newUserMessage: newMessage },
      sessionId,
    } as AgentEvent & { sessionId?: string });

    if (this.agentLoop) {
      try {
        const outcome = await steerOrQueue(this.agentLoop, {
          sessionId, content: effectiveMessage, displayContent: newMessage, clientMessageId, attachments: attachments as MessageAttachment[] | undefined, metadata: messageMetadata,
        });

        while (this.pendingSteerMessages.length > 0) {
          const queued = this.pendingSteerMessages.shift()!;
          await steerOrQueue(this.agentLoop, {
            sessionId, content: queued.content, displayContent: queued.displayContent, clientMessageId: queued.clientMessageId, attachments: queued.attachments, metadata: queued.messageMetadata,
          });
          logger.info('[AgentOrchestrator] Processed queued steer message');
        }

        this.onEvent({
          type: 'interrupt_complete',
          data: { message: '已调整方向', newUserMessage: newMessage },
          sessionId,
        } as AgentEvent & { sessionId?: string });
        return outcome;
      } finally {
        this.isInterrupting = false;
      }
    }

    if (this.deepResearchMode) {
      this.deepResearchMode.cancel();
      this.deepResearchMode = null;
    }
    if (this.semanticResearchOrchestrator) {
      this.semanticResearchOrchestrator.cancel();
      this.semanticResearchOrchestrator = null;
    }

    this.onEvent({
      type: 'interrupt_complete',
      data: { message: '已切换到新任务', newUserMessage: newMessage },
      sessionId,
    } as AgentEvent & { sessionId?: string });

    this.isInterrupting = false;

    const pending = this.pendingSteerMessages.splice(0);
    await this.sendMessage(newMessage, attachments, options, messageMetadata, clientMessageId);
    this.queuePendingSteer(pending, sessionId, 'after interrupt');
    return { outcome: 'steered' };
  }

  isProcessing(): boolean {
    return this.agentLoop !== null ||
           this.deepResearchMode !== null ||
           this.semanticResearchOrchestrator !== null;
  }

  setResearchUserSettings(settings: Partial<ResearchUserSettings>): void {
    this.runSettings.setResearchUserSettings(settings);
  }

  getResearchUserSettings(): Partial<ResearchUserSettings> {
    return this.runSettings.getResearchUserSettings();
  }

  handlePermissionResponse(requestId: string, response: PermissionResponse): PermissionDeliveryOutcome {
    return this.permissions.handlePermissionResponse(requestId, response);
  }

  /**
   * B2 first-responder-wins 裁决口。会话内 permissionResponse 和收件箱 resolve 两个入口
   * 都汇入这里：以 pending_approvals 的 UPDATE changes 数为唯一裁决——changes=0 表示
   * 该行已被抢答/过期/orphaned，第二口静默 no-op，绝不二次 resolve 内存 Promise。
   * 内存 Map delete 只在 repo 裁决赢了之后做。
   */
  resolveParkedApproval(
    id: string,
    response: PermissionResponse,
    feedbackOverride?: string,
  ): void {
    this.permissions.resolveParkedApproval(id, response, feedbackOverride);
  }

  setWorkingDirectory(path: string, options: { syncWorkspaceServices?: boolean } = {}): void {
    this.workingDirectory = path;
    this.isDefaultWorkingDirectory = false;
    this.toolExecutor.setWorkingDirectory(path);
    logger.info('Working directory changed to:', path);
    if (options.syncWorkspaceServices !== false) {
      this.initializeLSP(path);
      this.updateSkillWatcher(path);
    }
  }

  /** Set once on a newly-created background orchestrator from the foreground host run. */
  setWorkspaceScopeAuthority(workspaceScope: WorkspaceScope): void {
    this.workspaceScopeAuthority = workspaceScope;
  }

  getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  isUsingDefaultWorkingDirectory(): boolean {
    return this.isDefaultWorkingDirectory;
  }

  // ========================================================================
  // Agent Teams: Delegate 模式和 Plan 审批
  // ========================================================================

  setDelegateMode(enabled: boolean): void {
    this.runSettings.setDelegateMode(enabled);
  }

  isDelegateMode(): boolean {
    return this.runSettings.isDelegateMode();
  }

  pause(): void {
    this.agentLoop?.pause();
    const sessionId = this.sessionId ?? getSessionManager().getCurrentSessionId();
    if (sessionId) {
      getSessionStateManager().updateStatus(sessionId, 'paused');
    }
    logger.info('[AgentOrchestrator] Pause requested');
  }

  resume(): void {
    this.agentLoop?.resume();
    const sessionId = this.sessionId ?? getSessionManager().getCurrentSessionId();
    if (sessionId) {
      getSessionStateManager().updateStatus(sessionId, 'running');
    }
    logger.info('[AgentOrchestrator] Resume requested');
  }

  setRequirePlanApproval(enabled: boolean): void {
    this.runSettings.setRequirePlanApproval(enabled);
  }

  isRequirePlanApproval(): boolean {
    return this.runSettings.isRequirePlanApproval();
  }

  setPlanningService(service: PlanningService): void {
    this.planningService = service;
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  setMessages(messages: Message[]): void {
    this.messageHistory.setMessages(messages);
  }

  getMessages(): Message[] {
    return this.messageHistory.getMessages();
  }

  getSerializedCompressionState(): string | null {
    return this.messageHistory.getSerializedCompressionState();
  }

  getHookManager() {
    return this.agentLoop?.getHookManager();
  }

  clearMessages(): void {
    this.messageHistory.clearMessages();
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private addMessage(message: Message): void {
    this.messageHistory.addMessage(message);
  }

  private applyHistoryVisibility(message: Message, options?: AgentRunOptions): Message {
    return this.messageHistory.applyHistoryVisibility(message, options);
  }

  private updateContextHealthSnapshot(sessionId: string, model: string): void {
    try {
      getContextHealthService().update(
        sessionId,
        this.messageHistory.getMessagesForRun().map((message) => ({
          role: message.role,
          content: message.content || '',
          toolResults: message.toolResults?.map((result) => ({
            output: result.output,
            error: result.error,
          })),
        })),
        SYSTEM_PROMPT,
        model,
      );
    } catch (error) {
      logger.warn('Failed to update context health after user message:', error);
    }
  }

  private async resolveSessionId(): Promise<string | null> {
    if (this.sessionId) {
      return this.sessionId;
    }
    const currentSession = await getSessionManager().getCurrentSession();
    return currentSession?.id || null;
  }

  /** Delegates to extracted resolveModelConfig */
  private getModelConfig(settings: ReturnType<ConfigService['getSettings']>): ModelConfig {
    return resolveModelConfig(this.configService, settings);
  }

  private generateId(): string {
    return generateMessageId();
  }

  /** Delegates to extracted runDeepResearch */
  private async runDeepResearchMode(
    topic: string,
    options: AgentRunOptions | undefined,
    onEvent: (event: AgentEvent) => void,
    modelConfig: ModelConfig
  ): Promise<void> {
    await runDeepResearch(this.applyTurnSystemContext(topic, options), options?.reportStyle, onEvent, modelConfig, {
      toolExecutor: this.toolExecutor,
      generateId: () => this.generateId(),
      addMessage: (msg) => this.addMessage(this.applyHistoryVisibility(msg, options)),
    });
  }

  private async runNormalMode(
    content: string,
    onEvent: (event: AgentEvent) => void,
    modelConfig: ModelConfig,
    sessionId?: string,
    options?: AgentRunOptions,
  ): Promise<void> {
    const sessionStateManager = getSessionStateManager();
    if (sessionId) {
      sessionStateManager.updateStatus(sessionId, 'running');
      getTelemetryCollector().startSession(sessionId, {
        title: content.substring(0, 80),
        modelProvider: modelConfig.provider,
        modelName: modelConfig.model,
        workingDirectory: this.workingDirectory,
      });
    }

    let terminalError: unknown;
    try {
      const requirementsAnalyzer = getAgentRequirementsAnalyzer();
      const requirements = await requirementsAnalyzer.analyze(content, this.workingDirectory);
      const executionContent = this.applyTurnSystemContext(content, options, sessionId);

      if (options?.disableAutoAgent) {
        requirements.needsAutoAgent = false;
        requirements.executionStrategy = 'sequential';
      }

      if (this.runSettings.isDelegateMode() && !requirements.needsAutoAgent) {
        logger.info('[DelegateMode] Forcing auto agent mode — orchestrator will not execute tools directly');
        requirements.needsAutoAgent = true;
        requirements.executionStrategy = requirements.executionStrategy || 'parallel';
        requirements.confidence = Math.max(requirements.confidence, 0.8);
        void broadcastAgentNotice({ reasonCode: 'delegate_mode_active' });
      }

      if (requirements.needsAutoAgent) {
        await runAutoAgentMode(content, executionContent, requirements, onEvent, modelConfig, {
          workingDirectory: this.workingDirectory,
          sessionId: this.sessionId,
          taskListManager: this.taskListManager,
          generateId: () => this.generateId(),
          addMessage: (msg) => this.addMessage(this.applyHistoryVisibility(msg, options)),
          sendDAGStatusEvent: (dagId, agentId, status) => this.syncAutoAgentDAGStatus(dagId, agentId, status),
          runStandardAgentLoop: (c, e, m, s, executionPrompt, toolScope, executionIntent) =>
            this.runStandardAgentLoop(c, e, m, s, executionPrompt, toolScope, executionIntent, options),
          toolScope: options?.toolScope,
          executionIntent: options?.executionIntent,
          sourceMessageId: this.messageHistory.getMessagesForRun().filter((message) => message.role === 'user').at(-1)?.id,
        }, sessionId);
      } else {
        await this.runStandardAgentLoop(
          content,
          onEvent,
          modelConfig,
          sessionId,
          executionContent,
          options?.toolScope,
          options?.executionIntent,
          options,
        );
      }
    } catch (error) {
      logger.error('========== Normal mode EXCEPTION ==========');
      logger.error('Error:', error);
      logger.error('Stack:', error instanceof Error ? error.stack : 'no stack');
      onEvent({
        type: 'error',
        data: {
          message: error instanceof Error ? error.message : 'Unknown error',
          // 同一次失败会经由多个出口各发一条 error（这里 + runFinalizer 的 RUN_FAILED）。
          // 渲染侧按后到的覆盖，所以每一条都得带这一轮真跑的模型，缺一条就把前面
          // 带对的那条盖掉——真机 2026-08-01：卡片指认了一个根本没跑过的模型。
          details: {
            provider: modelConfig.provider,
            model: modelConfig.model,
          },
        },
      });
      terminalError = error;
    } finally {
      if (sessionId) {
        sessionStateManager.updateStatus(sessionId, 'idle');
        try {
          const sm = getSessionManager();
          const session = await sm.getSession(sessionId);
          if (session?.title && session.title !== 'New Chat' && session.title !== '新对话' && !session.title.startsWith('Session ')) {
            getTelemetryCollector().updateSessionTitle(sessionId, session.title);
          }
        } catch { /* ignore - title sync is best effort */ }
        try {
          const sessionData = getTelemetryCollector().getSessionData(sessionId);
          if (sessionData && (sessionData.totalInputTokens > 0 || sessionData.totalOutputTokens > 0)) {
            const sm = getSessionManager();
            await sm.updateSession(sessionId, {
              lastTokenUsage: {
                inputTokens: sessionData.totalInputTokens,
                outputTokens: sessionData.totalOutputTokens,
                totalTokens: sessionData.totalTokens,
                timestamp: Date.now(),
              },
            });
          }
        } catch { /* ignore - token sync is best effort */ }
        getTelemetryCollector().endSession(sessionId);
      }
    }

    if (terminalError) throw terminalError;
  }

  private async runStandardAgentLoop(
    content: string,
    onEvent: (event: AgentEvent) => void,
    modelConfig: ModelConfig,
    sessionId?: string,
    executionContent?: string,
    toolScope?: AgentRunOptions['toolScope'],
    executionIntent?: AgentRunOptions['executionIntent'],
    options?: AgentRunOptions,
  ): Promise<void> {
    const effectiveContent = executionContent ?? content;
    const { dagAwareOnEvent } = initRunDag({
      sessionId,
      content,
      onEvent,
      broadcastDAGEvent: this.broadcastDAGEvent,
    });

    const { resolution: routingResolution, requestedAgentId } = await this.resolveTurnRouting(
      content,
      sessionId,
      options?.agentOverrideId ?? undefined,
    );
    const neoTagFixedModel = options?.neoTag?.modelIntent.mode === 'fixed_model';
    const effectiveModelConfig = resolveTurnModelConfig(modelConfig, routingResolution, neoTagFixedModel);
    // UI effort previously never reached a real request because this analyzer overwrote every
    // newly-created loop. Legacy users therefore remain automatic; an explicit envelope value
    // is the user's per-turn decision and takes priority over automatic complexity selection.
    const automaticEffort = options?.effortLevel === undefined
      ? (() => {
        const complexityAnalysis = taskComplexityAnalyzer.analyze(content);
        const effortMap: Record<string, EffortLevel> = {
          simple: 'low',
          moderate: 'medium',
          complex: 'high',
        };
        const effort = effortMap[complexityAnalysis.complexity] || 'high';
        logger.info(`[EffortLevel] complexity=${complexityAnalysis.complexity} → effort=${effort}`);
        return effort;
      })()
      : undefined;

    if (routingResolution) {
      logger.info('Agent routing resolved', {
        agentId: routingResolution.agent.id,
        agentName: routingResolution.agent.name,
        score: routingResolution.score,
        reason: routingResolution.reason,
      });

      if (routingResolution.agent.modelOverride && !neoTagFixedModel) {
        logger.debug('Model config overridden by agent', {
          provider: effectiveModelConfig.provider,
          model: effectiveModelConfig.model,
        });
      } else if (routingResolution.agent.modelOverride && neoTagFixedModel) {
        logger.info('Neo Tag fixed_model is active; agent routing model override skipped', {
          workCardId: options?.neoTag?.workCardId,
          provider: effectiveModelConfig.provider,
          model: effectiveModelConfig.model,
        });
      }

      if (routingResolution.agent.systemPrompt) {
        logger.debug('System prompt overridden by agent', {
          agentId: routingResolution.agent.id,
        });
      }

      onEvent({
        type: 'routing_resolved',
        data: buildRoutingResolvedEventData(routingResolution, { requestedAgentId, timestamp: Date.now() }),
      });

      void broadcastAgentNotice({
        reasonCode: 'agent_routed',
        params: { agentName: routingResolution.agent.name },
      });
    } else {
      onEvent({
        type: 'routing_resolved',
        data: buildRoutingResolvedEventData(null, { requestedAgentId, timestamp: Date.now() }),
      });
    }

    const telemetryAdapter = sessionId
      ? getTelemetryCollector().createAdapter(sessionId, 'main')
      : undefined;
    let sessionMemoryMode: import('../../shared/contract/session').SessionMemoryMode = 'auto';
    let suppressedMemoryEntryIds: string[] | undefined;
    if (sessionId) {
      try {
        const session = await getSessionManager().getSession(sessionId);
        sessionMemoryMode = session?.memoryMode ?? 'auto';
        suppressedMemoryEntryIds = session?.suppressedMemoryEntryIds?.length
          ? [...session.suppressedMemoryEntryIds]
          : undefined;
      } catch (error) {
        logger.warn('Failed to read session memory preferences; using defaults', {
          sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // /goal 自治模式：options.goal 存在则建 goalContract → AgentLoop 据此建 ctx.goalMode
    // + maxIterations=maxTurns + 预加载 attempt_completion（与 web /api/run 路径同源逻辑）。
    const goalContract = options?.goal
      ? buildGoalContract({
          goal: options.goal.goal ?? content,
          verifyCommand: options.goal.verify,
          reviewCondition: options.goal.review,
          tokenBudget: options.goal.budget,
          maxTurns: options.goal.maxTurns,
          wallClockBudgetMs: options.goal.wallClockBudgetMs,
          allowSwarm: options.goal.allowSwarm,
        })
      : undefined;

    if (goalContract && sessionId) {
      seedGoalContractForRun({ goalContract, sessionId, emitEvent: dagAwareOnEvent });
    }

    // 显式路由到 readonly agent（explore/plan）时收窄文件写入工具（Explorer 真只读）
    const deniedToolNames = assembleTurnDenylist({
      agent: routingResolution?.agent,
      optionDenied: options?.deniedToolNames,
      sessionMemoryMode,
      isLiveVoiceSession: getPermissionModeManager().isLiveVoiceSession(sessionId),
      runRegistration: options?.runRegistration,
      userPresenceToolNames: getUserPresenceToolNames(),
    });

    const baseSystemPrompt = routingResolution?.agent?.systemPrompt
      || applyProviderVariant(SYSTEM_PROMPT, effectiveModelConfig.provider, effectiveModelConfig.model);
    const systemPrompt = options?.neoTag?.promptLayer
      ? `${baseSystemPrompt}\n\n${options.neoTag.promptLayer}`
      : baseSystemPrompt;

    const nativeRunId = options?.runId?.trim() || `run-${generateMessageId()}`;
    let registeredRun: RunHandle | undefined;
    let runCompletedNormally = false;
    let rolePresetSessionId: string | undefined;
    try {
      // 本轮专家自带的审批档（详情页「安全」页写进 agent.md 的 permission-override）。
      // 钩在这里而不是某个 startTask 入口：IPC / cron 主动性 / neoTag / sessionAutomation /
      // idleWake 五个入口都汇到 runConversation，角色身份也是在上面 resolveTurnRouting 才定下来。
      // 没显式设过档的角色（registry 里 permissionPreset 为 undefined）不写，保持「跟随通用设置」。
      const turnRolePreset = sessionId && routingResolution
        ? registryResolveAgent(routingResolution.agent.id)?.permissionPreset
        : undefined;
      if (sessionId && turnRolePreset) {
        getPermissionModeManager().setRolePresetSession(
          sessionId,
          rolePermissionPresetToMode(turnRolePreset),
        );
        rolePresetSessionId = sessionId;
      }
      const runSession = sessionId ? await getSessionManager().getSession(sessionId) : undefined;
      const sessionWorkspaceScope = runSession
        ? resolveSessionWorkspaceScope(
            runSession,
            getAuthService().getCurrentUser()?.id ?? null,
            getDatabase(),
            getProjectService(),
          )
        : undefined;
      const workspaceScope = selectBackgroundWorkspaceScope(
        this.workspaceScopeAuthority,
        sessionWorkspaceScope,
      );
      const runWorkingDirectory = workspaceScope
        ? (resolveWorkspacePath(workspaceScope, this.workingDirectory, 'read')
          ? this.workingDirectory
          : workspaceScope.primaryRoot)
        : this.workingDirectory;
      // LSPManager / SkillWatcher 是 Host 级单例。辅助 run 若用自己的工作区反复重置它们，
      // 会和主 run 互抢全局指针；真机上 LSP 重建还会卡住实时语音心跳。
      // 辅助 run 仍然拿到独立 runContext 和正确 cwd，只是不改写这两个全局服务。
      if (workspaceScope && options?.runRegistration !== 'auxiliary') {
        this.initializeLSP(
          workspaceScope.primaryRoot,
          workspaceScope.roots.map((root) => root.path),
        );
        this.updateSkillWatcher(workspaceScope.primaryRoot);
      }
      const runContext = sessionId
        ? createRunContext({
          runId: nativeRunId,
          sessionId,
          workspace: workspaceScope?.primaryRoot,
          workspaceScope,
          cwd: runWorkingDirectory,
        })
        : undefined;
      this.agentLoop = new AgentLoop({
      // provider 变体（roadmap 2.4）：默认主提示词按 provider 家族追加纪律段落
      // （Claude 系 Git 安全 / GPT 国产系自治坚持）；agent 路由自带 prompt 时不动
      systemPrompt,
      modelConfig: effectiveModelConfig,
      toolExecutor: runContext ? this.toolExecutor.forRun(runContext) : this.toolExecutor,
      messages: this.messageHistory.getMessagesForRun(),
      onEvent: dagAwareOnEvent,
      planningService: this.planningService,
      runId: nativeRunId,
      sessionId,
      agentId: routingResolution?.agent?.id ?? 'default',
      agentName: routingResolution?.agent?.name ?? 'default',
      requestedAgentId,
      memoryMode: sessionMemoryMode,
      suppressedMemoryEntryIds,
      workingDirectory: runWorkingDirectory,
      projectConfigDirectory: workspaceScope?.primaryRoot ?? runWorkingDirectory,
      workspaceScope,
      isDefaultWorkingDirectory: this.isDefaultWorkingDirectory,
      toolScope,
      executionIntent,
      searchEnabled: options?.searchEnabled,
      thinkingEnabled: options?.thinkingEnabled,
      effortLevel: options?.effortLevel ?? automaticEffort,
      neoTag: options?.neoTag,
      goalContract,
      // 迭代数硬上限（角色主动性醒来等预算受限场景，内部文档 §6）
      maxIterations: options?.maxIterations,
      historyVisibility: options?.historyVisibility,
      deniedToolNames,
      allowedToolNames: options?.allowedToolNames,
      telemetryAdapter,
      persistMessage: sessionId
        ? async (message: Message) => {
            await getSessionManager().addMessageToSession(sessionId, message);
          }
        : undefined,
      onToolExecutionLog: (log) => {
        try {
          const recorder = getComboRecorder();
          recorder.enrichLastStep(log.sessionId, log.toolCallId, log.toolName, log.args);
        } catch {
          // Non-blocking
        }
      },
      });

      registeredRun = this.runRegistry && sessionId
        ? await startRunPreferringDurable(this.runRegistry, {
            runId: nativeRunId,
            sessionId,
            workspace: runContext!.workspace,
            workspaceScope,
            cwd: runContext!.cwd,
          }, options?.runRegistration, options?.parentRunId)
        : undefined;
      await registeredRun?.attach(this.agentLoop);

      logger.info('========== Starting agent loop ==========');
      // 第二个参数是用户原话：telemetry 的 user_prompt 只能存它，别存拼了
      // turnSystemContext 的 effectiveContent（backfill 会把那一列写回消息流）。
      const runPromise = this.agentLoop.run(effectiveContent, content);
      this.activeRunPromise = runPromise;
      await runPromise;
      runCompletedNormally = true;
      logger.info('========== Agent loop completed normally ==========');

      // Check for combo skill suggestion after loop completes
      if (sessionId) {
        try {
          const suggestion = getComboRecorder().checkSuggestion(sessionId);
          if (suggestion) {
            getEventBus().publish('agent', 'combo_skill_suggestion', suggestion, { sessionId, bridgeToRenderer: true });
          }
        } catch {
          // Non-blocking
        }
      }
    } finally {
      // 只钳这一轮：下一轮换成别的专家（或回到主会话）时回到会话自己的档。
      if (rolePresetSessionId) {
        getPermissionModeManager().clearRolePresetSession(rolePresetSessionId);
      }
      if (
        registeredRun
        && options?.runRegistration === 'auxiliary'
        && options.parentRunId
        && this.runRegistry?.hasDurableOwner(nativeRunId)
      ) {
        await this.runRegistry.terminalDurable(nativeRunId, {
          status: runCompletedNormally ? 'completed' : 'failed',
          now: Date.now(),
          reason: runCompletedNormally ? undefined : 'auxiliary_run_failed',
          event: {
            type: runCompletedNormally ? 'auxiliary_run_completed' : 'auxiliary_run_failed',
            payload: { parentRunId: options.parentRunId, sessionId },
            recordedAt: Date.now(),
          },
        }, registeredRun).catch((error) => {
          logger.error('Failed to persist auxiliary durable terminal state', error);
        });
      }
      if (registeredRun) this.runRegistry?.unregister(nativeRunId, registeredRun);
      this.messageHistory.captureCompressionState();
      logger.info('========== Finally block, agentLoop = null ==========');
      this.agentLoop = null;
      this.activeRunPromise = null;
    }
  }

  private applyTurnSystemContext(
    content: string,
    options?: AgentRunOptions,
    sessionId?: string | null,
  ): string {
    return applyTurnSystemContext(
      content,
      options,
      sessionId ?? this.sessionId ?? undefined,
      (resolvedSessionId) => this.buildLiveVoicePermissionNotice(resolvedSessionId),
    );
  }

  private buildLiveVoicePermissionNotice(sessionId?: string | null): string | null {
    return buildLiveVoicePermissionNotice(sessionId);
  }

  private async resolveAgentRouting(
    userMessage: string,
    sessionId?: string
  ): Promise<RoutingResolution | null> {
    try {
      const routingService = getRoutingService();

      if (!routingService.isInitialized()) {
        await routingService.initialize(this.workingDirectory);
      }

      const context: RoutingContext = {
        workingDirectory: this.workingDirectory,
        userMessage,
        sessionId,
      };

      const resolution = routingService.resolve(context);

      if (resolution.agent.id === 'default' && resolution.score <= 0) {
        return null;
      }

      return resolution;
    } catch (error) {
      logger.warn('Agent routing failed, using default', { error });
      return null;
    }
  }

  /**
   * 一轮对话的路由解析单入口：显式选择（agentOverrideId）优先，解析失败回落自动路由，
   * 但 requestedAgentId 必须保留——它是 routing_resolved 事件里降级信号的判定依据
   * （requestedAgentId !== 实际 agentId 即显式选择被降级，不再静默兜底）。
   */
  private async resolveTurnRouting(
    content: string,
    sessionId?: string,
    agentOverrideId?: string,
  ): Promise<{ resolution: RoutingResolution | null; requestedAgentId?: string }> {
    // trim 后再参与降级判定：未规整的 " explore " 会解析成功（resolver 内部 trim）
    // 却在 requestedAgentId !== agentId 比较上产生假降级警示
    const requestedAgentId = agentOverrideId?.trim() || undefined;
    if (requestedAgentId) {
      const explicit = this.resolveExplicitAgentRouting(requestedAgentId);
      if (explicit) {
        return { resolution: explicit, requestedAgentId };
      }
      return {
        resolution: await this.resolveAgentRouting(content, sessionId),
        requestedAgentId,
      };
    }
    return { resolution: await this.resolveAgentRouting(content, sessionId) };
  }

  private resolveExplicitAgentRouting(agentId: string): RoutingResolution | null {
    return resolveExplicitAgentRouting(agentId);
  }

  // --------------------------------------------------------------------------
  // DAG Status Sync (delegates to dagManager helpers)
  // --------------------------------------------------------------------------

  private syncAutoAgentDAGStatus(dagId: string, agentId: string, status: string): void {
    syncAutoAgentDAGStatus(dagId, agentId, status, this.broadcastDAGEvent);
  }

  // --------------------------------------------------------------------------
  // LSP & SkillWatcher (async, non-blocking)
  // --------------------------------------------------------------------------

  private initializeLSP(workspaceRoot: string, workspaceFolders: string[] = [workspaceRoot]): void {
    import('../lsp').then(async ({ initializeLSPManager, getLSPManager }) => {
      try {
        const existingManager = getLSPManager();
        if (existingManager) {
          logger.debug('LSP manager already exists, reinitializing for new workspace');
        }
        await initializeLSPManager(workspaceRoot, workspaceFolders);
        logger.info('LSP initialized for workspace:', workspaceRoot);
      } catch (error) {
        logger.warn('LSP initialization failed (non-blocking)', { error });
      }
    }).catch((error: unknown) => {
      logger.warn('Failed to import LSP module', { error });
    });
  }

  private updateSkillWatcher(workingDirectory: string): void {
    import('../services/skills').then(async ({ getSkillWatcher }) => {
      try {
        const watcher = getSkillWatcher();
        if (watcher.isInitialized()) {
          await watcher.updateProjectDirectory(workingDirectory);
          logger.debug('SkillWatcher updated for workspace:', workingDirectory);
        }
      } catch (error) {
        logger.warn('SkillWatcher update failed (non-blocking)', { error });
      }
    }).catch((error: unknown) => {
      logger.warn('Failed to import skills module', { error });
    });
  }
}
