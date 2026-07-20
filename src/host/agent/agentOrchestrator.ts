// ============================================================================
// Agent Orchestrator - Main controller for the AI agent
// ============================================================================

import type {
  AgentEvent,
  Message,
  MessageAttachment,
  MessageMetadata,
  PermissionRequest,
  PermissionResponse,
  ModelConfig,
  ModelProvider,
} from '../../shared/contract';
import type { AgentRunOptions, ResearchUserSettings } from '../research/types';
import { AgentLoop } from './agentLoop';
import { buildGoalContract } from './goalModeController';
import { SYSTEM_PROMPT } from '../prompts/builder';
import { applyProviderVariant } from '../prompts/providerVariants';
import { ToolExecutor } from '../tools/toolExecutor';
import type { ExecutionTopology } from '../permissions';
import { getConfirmationGate } from './confirmationGate';
import type { ConfigService } from '../services/core/configService';
import { getSessionManager } from '../services';
import type { PlanningService } from '../planning';
import { DeepResearchMode, SemanticResearchOrchestrator } from '../research';
import { analyzeTask } from './hybrid/taskRouter';
import { classifyIntent } from '../routing/intentClassifier';
import { getSessionStateManager } from '../session/sessionStateManager';
import { getContextHealthService } from '../context/contextHealthService';
import { ModelRouter } from '../model/modelRouter';
import { generateMessageId, generatePermissionRequestId } from '../../shared/utils/id';
import { buildGoalSeedTodos } from '../../shared/utils/goalTodos';
import { createLogger } from '../services/infra/logger';
import { getAgentRequirementsAnalyzer } from './agentRequirementsAnalyzer';
import { getRoutingService } from '../routing';
import type { RoutingContext, RoutingResolution } from '../../shared/contract/agentRouting';
import { getTelemetryCollector } from '../telemetry';
import { taskComplexityAnalyzer } from '../planning/taskComplexityAnalyzer';
import type { EffortLevel } from '../../shared/contract/agent';
import { getTaskListManager, type TaskListManager } from './taskList';
import { TaskDAG } from '../scheduler/TaskDAG';
import { sendDAGInitEvent } from '../scheduler/dagEventBridge';
import { getEventBus } from '../services/eventing';
import { getComboRecorder } from '../services/skills/comboRecorder';
import { getPredefinedAgent } from './agentDefinition';
import { buildRoutingResolvedEventData } from './routingResolvedEvent';
import { buildRoutingToolDenylist } from './routingToolPolicy';
import { queuePendingSteerMessagesOrWarn, steerOrQueue, type SteerOrQueueOutcome } from '../runtime/steerQueueFence';

// Sub-modules
import { type AgentOrchestratorConfig, MAX_MESSAGES_IN_MEMORY } from './orchestrator/types';
import {
  mapAgentEventToDAGStatus,
  mapAutoAgentStatusToDAGStatus,
  buildDAGStatusEvent,
} from './orchestrator/dagManager';
import {
  resolveModelConfig,
  resolveRunModelConfig,
  getPermissionLevel,
} from './orchestrator/modelConfigResolver';
import { runDeepResearch } from './orchestrator/researchRunner';
import { runAutoAgentMode } from './orchestrator/autoAgentRunner';
import { setSessionTodos, syncTodosToSessionTasks } from './todoParser';
import { resolveNeoTagModelIntent } from '../services/project/neoTagModelIntentResolver';

export type { AgentOrchestratorConfig } from './orchestrator/types';

const logger = createLogger('AgentOrchestrator');

interface PendingSteerMessage {
  content: string;
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
  private messages: Message[] = [];
  private pendingPermissions: Map<string, {
    resolve: (response: PermissionResponse) => void;
    request: PermissionRequest;
  }> = new Map();
  private planningService?: PlanningService;
  private researchUserSettings: Partial<ResearchUserSettings> = {
    autoDetect: true,
    confirmBeforeStart: false,
  };

  // Agent Teams: Delegate 模式和 Plan 审批
  private delegateMode: boolean = false;
  private requirePlanApproval: boolean = false;

  // Real-time steering: 中断排队
  private isInterrupting: boolean = false;
  private pendingSteerMessages: PendingSteerMessage[] = [];

  // TaskList: 可视化任务管理
  private taskListManager: TaskListManager;
  private sessionId: string | null = null;
  private lastSerializedCompressionState: string | null = null;
  private activeRunPromise: Promise<void> | null = null;

  // Dependency injection: decoupled from Electron APIs
  private getHomeDir: () => string;
  private broadcastDAGEvent?: (event: import('../../shared/contract/dagVisualization').DAGVisualizationEvent) => void;

  constructor(config: AgentOrchestratorConfig) {
    this.configService = config.configService;
    this.onEvent = config.onEvent;
    this.getHomeDir = config.getHomeDir ?? (() => process.cwd());
    this.broadcastDAGEvent = config.broadcastDAGEvent;

    this.workingDirectory = this.initializeWorkDirectory();
    this.isDefaultWorkingDirectory = true;
    logger.info('Initial working directory:', this.workingDirectory);
    this.planningService = config.planningService;

    this.toolExecutor = new ToolExecutor({
      requestPermission: this.requestPermission.bind(this),
      workingDirectory: this.workingDirectory,
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
    this.drainPendingPermissions('deny');

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
      if (analysis.taskType === 'research') {
        logger.info('Auto-detected research task (keyword match), routing to deep research pipeline');
        await this.runDeepResearchMode(content, options, sessionAwareOnEvent, modelConfig);
      } else if (!['code', 'data', 'ppt', 'image', 'video'].includes(analysis.taskType)) {
        try {
          const modelRouter = new ModelRouter();
          const intent = await classifyIntent(content, modelRouter);
          if (intent.intent === 'research') {
            logger.info('Auto-detected research task (LLM classification), routing to deep research pipeline');
            await this.runDeepResearchMode(content, options, sessionAwareOnEvent, modelConfig);
          } else {
            await this.runNormalMode(content, sessionAwareOnEvent, modelConfig, sessionId ?? undefined, options);
          }
        } catch (error) {
          logger.warn('LLM intent classification failed, falling back to normal mode', { error: String(error) });
          await this.runNormalMode(content, sessionAwareOnEvent, modelConfig, sessionId ?? undefined, options);
        }
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
    this.drainPendingPermissions('deny');

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
    const effectiveMessage = this.applyTurnSystemContext(newMessage, options);

    if (this.isInterrupting) {
      logger.info('[AgentOrchestrator] Already interrupting, queuing message');
      this.pendingSteerMessages.push({
        content: effectiveMessage,
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
          sessionId, content: effectiveMessage, clientMessageId, attachments: attachments as MessageAttachment[] | undefined, metadata: messageMetadata,
        });

        while (this.pendingSteerMessages.length > 0) {
          const queued = this.pendingSteerMessages.shift()!;
          await steerOrQueue(this.agentLoop, {
            sessionId, content: queued.content, clientMessageId: queued.clientMessageId, attachments: queued.attachments, metadata: queued.messageMetadata,
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
    this.researchUserSettings = { ...this.researchUserSettings, ...settings };
    logger.debug('Research user settings updated:', this.researchUserSettings);
  }

  getResearchUserSettings(): Partial<ResearchUserSettings> {
    return { ...this.researchUserSettings };
  }

  handlePermissionResponse(requestId: string, response: PermissionResponse): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      pending.resolve(response);
      this.pendingPermissions.delete(requestId);
    }
  }

  /**
   * 解除所有挂起的权限请求。新消息到达 / 取消时调用：挂起的权限 Promise 若一直无人
   * resolve，会把 await 在 requestPermission 上的 agentLoop 冻结到 60s 超时（死锁）。
   * 统一以 'deny' 解除——安全侧默认不放行；模型在被拒后会按指令重新发起调用、重新弹卡。
   */
  private drainPendingPermissions(response: PermissionResponse = 'deny'): void {
    if (this.pendingPermissions.size === 0) return;
    const count = this.pendingPermissions.size;
    for (const { resolve } of this.pendingPermissions.values()) {
      resolve(response);
    }
    this.pendingPermissions.clear();
    logger.info(`Drained ${count} pending permission(s)`, { response });
  }

  setWorkingDirectory(path: string): void {
    this.workingDirectory = path;
    this.isDefaultWorkingDirectory = false;
    this.toolExecutor.setWorkingDirectory(path);
    logger.info('Working directory changed to:', path);
    this.initializeLSP(path);
    this.updateSkillWatcher(path);
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
    this.delegateMode = enabled;
    logger.info(`[AgentOrchestrator] Delegate mode ${enabled ? 'enabled' : 'disabled'}`);
  }

  isDelegateMode(): boolean {
    return this.delegateMode;
  }

  setEffortLevel(level: import('../../shared/contract/agent').EffortLevel): void {
    this.agentLoop?.setEffortLevel(level);
    logger.info(`[AgentOrchestrator] Effort level set to ${level}`);
  }

  setThinkingEnabled(enabled: boolean): void {
    this.agentLoop?.setThinkingEnabled(enabled);
    logger.info(`[AgentOrchestrator] Thinking ${enabled ? 'enabled' : 'disabled'}`);
  }

  setInteractionMode(mode: import('../../shared/contract/agent').InteractionMode): void {
    this.agentLoop?.setInteractionMode(mode);
    logger.info(`[AgentOrchestrator] Interaction mode set to ${mode}`);
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
    this.requirePlanApproval = enabled;
    logger.info(`[AgentOrchestrator] Plan approval ${enabled ? 'required' : 'not required'}`);
  }

  isRequirePlanApproval(): boolean {
    return this.requirePlanApproval;
  }

  setPlanningService(service: PlanningService): void {
    this.planningService = service;
  }

  setSessionId(sessionId: string | null): void {
    this.sessionId = sessionId;
  }

  setMessages(messages: Message[]): void {
    this.messages = [...messages];
    logger.debug(`Messages set, count: ${this.messages.length}`);
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  getSerializedCompressionState(): string | null {
    const liveState = this.agentLoop?.getSerializedCompressionState() ?? null;
    if (liveState) {
      this.lastSerializedCompressionState = liveState;
    }
    return liveState ?? this.lastSerializedCompressionState;
  }

  getHookManager() {
    return this.agentLoop?.getHookManager();
  }

  clearMessages(): void {
    this.messages = [];
    logger.debug('Messages cleared');
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private addMessage(message: Message): void {
    this.messages.push(message);
    if (this.messages.length > MAX_MESSAGES_IN_MEMORY) {
      const trimCount = this.messages.length - MAX_MESSAGES_IN_MEMORY;
      this.messages = this.messages.slice(trimCount);
      logger.debug(`Trimmed ${trimCount} old messages, keeping ${this.messages.length}`);
    }
  }

  private applyHistoryVisibility(message: Message, options?: AgentRunOptions): Message {
    if (options?.historyVisibility === 'meta') {
      message.isMeta = true;
      message.source = message.source ?? 'system';
    }
    return message;
  }

  private updateContextHealthSnapshot(sessionId: string, model: string): void {
    try {
      getContextHealthService().update(
        sessionId,
        this.messages.map((message) => ({
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

  private async requestPermission(request: Omit<PermissionRequest, 'id' | 'timestamp'>): Promise<boolean> {
    const fullRequest: PermissionRequest = {
      ...request,
      id: generatePermissionRequestId(),
      timestamp: Date.now(),
    };

    if (process.env.AUTO_TEST) {
      logger.info(`[AUTO_TEST] Auto-approving permission: ${request.type} for ${request.tool}`);
      return true;
    }

    const settings = this.configService.getSettings();
    const permissionLevel = getPermissionLevel(request.type);
    const forceConfirm = request.forceConfirm === true;

    if (!forceConfirm && settings.permissions.devModeAutoApprove) {
      logger.info(`[DevMode] Auto-approving permission: ${request.type} for ${request.tool}`);
      return true;
    }

    if (!forceConfirm && settings.permissions.autoApprove[permissionLevel]) {
      return true;
    }

    const PERMISSION_TIMEOUT = 60000;

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        this.pendingPermissions.delete(fullRequest.id);
        logger.warn(`Timeout for ${request.type} on ${request.tool}, denying`);
        resolve(false);
      }, PERMISSION_TIMEOUT);

      this.pendingPermissions.set(fullRequest.id, {
        resolve: (response) => {
          clearTimeout(timeoutId);
          if (response === 'allow_session' && fullRequest.sessionId) {
            getConfirmationGate().recordApproval(fullRequest.sessionId, fullRequest.tool);
          }
          resolve(response === 'allow' || response === 'allow_session');
        },
        request: fullRequest,
      });
      this.onEvent({ type: 'permission_request', data: fullRequest });
    });
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
      const executionContent = this.applyTurnSystemContext(content, options);

      if (this.delegateMode && !requirements.needsAutoAgent) {
        logger.info('[DelegateMode] Forcing auto agent mode — orchestrator will not execute tools directly');
        requirements.needsAutoAgent = true;
        requirements.executionStrategy = requirements.executionStrategy || 'parallel';
        requirements.confidence = Math.max(requirements.confidence, 0.8);
        onEvent({
          type: 'notification',
          data: { message: 'Delegate 模式：任务将委派给子 Agent 执行' },
        });
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
          sourceMessageId: this.messages.filter((message) => message.role === 'user').at(-1)?.id,
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
    const dagId = `conv-${sessionId || Date.now()}`;
    const dag = new TaskDAG(dagId, content.substring(0, 50) + (content.length > 50 ? '...' : ''));
    dag.addAgentTask('main', {
      role: 'general-purpose',
      prompt: content,
    }, {
      name: '对话处理',
      description: content.substring(0, 100),
    });

    sendDAGInitEvent(dag);

    const dagAwareOnEvent = (event: AgentEvent) => {
      onEvent(event);
      this.syncDAGStatus(dagId, event);
    };

    const { resolution: routingResolution, requestedAgentId } = await this.resolveTurnRouting(
      content,
      sessionId,
      options?.agentOverrideId ?? undefined,
    );
    let effectiveModelConfig = modelConfig;
    const neoTagFixedModel = options?.neoTag?.modelIntent.mode === 'fixed_model';

    if (routingResolution) {
      logger.info('Agent routing resolved', {
        agentId: routingResolution.agent.id,
        agentName: routingResolution.agent.name,
        score: routingResolution.score,
        reason: routingResolution.reason,
      });

      if (routingResolution.agent.modelOverride && !neoTagFixedModel) {
        const override = routingResolution.agent.modelOverride;
        effectiveModelConfig = {
          ...modelConfig,
          provider: (override.provider as ModelProvider) || modelConfig.provider,
          model: override.model || modelConfig.model,
          temperature: override.temperature ?? modelConfig.temperature,
        };
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

      onEvent({
        type: 'notification',
        data: {
          message: `使用 Agent: ${routingResolution.agent.name}`,
        },
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
      const goalSeedTodos = buildGoalSeedTodos(goalContract.goal);
      setSessionTodos(sessionId, goalSeedTodos);
      const taskSync = syncTodosToSessionTasks(sessionId, goalSeedTodos);
      dagAwareOnEvent({ type: 'todo_update', data: goalSeedTodos });
      dagAwareOnEvent({
        type: 'task_update',
        data: {
          tasks: taskSync.tasks,
          action: 'sync',
          taskIds: [
            ...taskSync.created.map((task) => task.id),
            ...taskSync.updated.map((task) => task.id),
          ],
          source: 'goal_mode',
        },
      });
    }

    // 显式路由到 readonly agent（explore/plan）时收窄文件写入工具（Explorer 真只读）
    const routingDeniedToolNames = buildRoutingToolDenylist(routingResolution?.agent);
    const baseDeniedToolNames = sessionMemoryMode === 'off'
      ? [
          ...(options?.deniedToolNames || []),
          'MemoryRead',
          'MemoryWrite',
          'History',
          'EpisodicRecall',
        ]
      : (options?.deniedToolNames || []);
    const mergedDeniedToolNames = Array.from(new Set([...baseDeniedToolNames, ...routingDeniedToolNames]));
    const deniedToolNames = mergedDeniedToolNames.length > 0 ? mergedDeniedToolNames : undefined;

    const baseSystemPrompt = routingResolution?.agent?.systemPrompt
      || applyProviderVariant(SYSTEM_PROMPT, effectiveModelConfig.provider, effectiveModelConfig.model);
    const systemPrompt = options?.neoTag?.promptLayer
      ? `${baseSystemPrompt}\n\n${options.neoTag.promptLayer}`
      : baseSystemPrompt;

    this.agentLoop = new AgentLoop({
      // provider 变体（roadmap 2.4）：默认主提示词按 provider 家族追加纪律段落
      // （Claude 系 Git 安全 / GPT 国产系自治坚持）；agent 路由自带 prompt 时不动
      systemPrompt,
      modelConfig: effectiveModelConfig,
      toolExecutor: this.toolExecutor,
      messages: this.messages,
      onEvent: dagAwareOnEvent,
      planningService: this.planningService,
      sessionId,
      agentId: routingResolution?.agent?.id ?? 'default',
      agentName: routingResolution?.agent?.name ?? 'default',
      requestedAgentId,
      memoryMode: sessionMemoryMode,
      suppressedMemoryEntryIds,
      workingDirectory: this.workingDirectory,
      isDefaultWorkingDirectory: this.isDefaultWorkingDirectory,
      toolScope,
      executionIntent,
      neoTag: options?.neoTag,
      goalContract,
      // 迭代数硬上限（角色主动性醒来等预算受限场景，内部文档 §6）
      maxIterations: options?.maxIterations,
      historyVisibility: options?.historyVisibility,
      deniedToolNames,
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

    const complexityAnalysis = taskComplexityAnalyzer.analyze(content);
    const effortMap: Record<string, EffortLevel> = {
      simple: 'low',
      moderate: 'medium',
      complex: 'high',
    };
    const effort = effortMap[complexityAnalysis.complexity] || 'high';
    this.agentLoop.setEffortLevel(effort);
    logger.info(`[EffortLevel] complexity=${complexityAnalysis.complexity} → effort=${effort}`);

    try {
      logger.info('========== Starting agent loop ==========');
      const runPromise = this.agentLoop.run(effectiveContent);
      this.activeRunPromise = runPromise;
      await runPromise;
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
      this.lastSerializedCompressionState = this.agentLoop?.getSerializedCompressionState()
        ?? this.lastSerializedCompressionState;
      logger.info('========== Finally block, agentLoop = null ==========');
      this.agentLoop = null;
      this.activeRunPromise = null;
    }
  }

  private applyTurnSystemContext(
    content: string,
    options?: AgentRunOptions,
  ): string {
    const turnSystemContext = options?.turnSystemContext?.filter((item) => item.trim().length > 0) || [];
    if (turnSystemContext.length === 0) {
      return content;
    }

    return `${turnSystemContext.join('\n\n')}\n\n<user_request>\n${content}\n</user_request>`;
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
    try {
      const agent = getPredefinedAgent(agentId);
      return {
        agent: {
          id: agent.id,
          name: agent.name,
          description: agent.description,
          systemPrompt: agent.prompt,
          tools: agent.tools,
          readonly: agent.coordination?.readonly === true,
          enabled: true,
          tags: agent.tags,
        },
        score: 1000,
        reason: `Explicit agent selected: ${agent.id}`,
      };
    } catch (error) {
      logger.warn('Explicit agent selection failed, falling back to auto routing', {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // DAG Status Sync (delegates to dagManager helpers)
  // --------------------------------------------------------------------------

  private syncDAGStatus(dagId: string, event: AgentEvent): void {
    const statusUpdate = mapAgentEventToDAGStatus(event);
    if (statusUpdate) {
      const vizEvent = buildDAGStatusEvent(dagId, statusUpdate);
      this.broadcastDAGEvent?.(vizEvent);
    }
  }

  private syncAutoAgentDAGStatus(dagId: string, agentId: string, status: string): void {
    const statusUpdate = mapAutoAgentStatusToDAGStatus(agentId, status);
    const vizEvent = buildDAGStatusEvent(dagId, statusUpdate);
    this.broadcastDAGEvent?.(vizEvent);
  }

  // --------------------------------------------------------------------------
  // LSP & SkillWatcher (async, non-blocking)
  // --------------------------------------------------------------------------

  private initializeLSP(workspaceRoot: string): void {
    import('../lsp').then(async ({ initializeLSPManager, getLSPManager }) => {
      try {
        const existingManager = getLSPManager();
        if (existingManager) {
          logger.debug('LSP manager already exists, reinitializing for new workspace');
        }
        await initializeLSPManager(workspaceRoot);
        logger.info('LSP initialized for workspace:', workspaceRoot);
      } catch (error) {
        logger.warn('LSP initialization failed (non-blocking)', { error });
      }
    }).catch((error) => {
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
    }).catch((error) => {
      logger.warn('Failed to import skills module', { error });
    });
  }
}
