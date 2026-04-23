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
import { SYSTEM_PROMPT } from '../prompts/builder';
import { ToolExecutor } from '../tools/toolExecutor';
import { getConfirmationGate } from './confirmationGate';
import type { ConfigService } from '../services/core/configService';
import { getSessionManager } from '../services';
import type { PlanningService } from '../planning';
import { DeepResearchMode, SemanticResearchOrchestrator } from '../research';
import { analyzeTask } from './hybrid/taskRouter';
import { classifyIntent } from '../routing/intentClassifier';
import { getSessionStateManager } from '../session/sessionStateManager';
import { ModelRouter } from '../model/modelRouter';
import { generateMessageId, generatePermissionRequestId } from '../../shared/utils/id';
import { createLogger } from '../services/infra/logger';
import { getAgentRequirementsAnalyzer } from './agentRequirementsAnalyzer';
import { getModelSessionState } from '../session/modelSessionState';
import { getRoutingService } from '../routing';
import type { RoutingContext, RoutingResolution } from '../../shared/contract/agentRouting';
import { getTelemetryCollector } from '../telemetry';
import { taskComplexityAnalyzer } from '../planning/taskComplexityAnalyzer';
import type { EffortLevel } from '../../shared/contract/agent';
import { getTaskListManager, type TaskListManager } from './taskList';
import { TaskDAG } from '../scheduler/TaskDAG';
import { sendDAGInitEvent } from '../scheduler/dagEventBridge';
import { getEventBus } from '../protocol/events';
import { getComboRecorder } from '../services/skills/comboRecorder';

// Sub-modules
import { type AgentOrchestratorConfig, MAX_MESSAGES_IN_MEMORY } from './orchestrator/types';
import {
  mapAgentEventToDAGStatus,
  mapAutoAgentStatusToDAGStatus,
  buildDAGStatusEvent,
} from './orchestrator/dagManager';
import { resolveModelConfig, getDefaultModelByProvider, getPermissionLevel } from './orchestrator/modelConfigResolver';
import { runDeepResearch, checkAndRunSemanticResearch } from './orchestrator/researchRunner';
import { runAutoAgentMode } from './orchestrator/autoAgentRunner';

export type { AgentOrchestratorConfig } from './orchestrator/types';

const logger = createLogger('AgentOrchestrator');

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
  private pendingSteerMessages: string[] = [];

  // TaskList: 可视化任务管理
  private taskListManager: TaskListManager;
  private sessionId: string | null = null;
  private lastSerializedCompressionState: string | null = null;

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

  async sendMessage(
    content: string,
    attachments?: unknown[],
    options?: AgentRunOptions,
    messageMetadata?: MessageMetadata,
  ): Promise<void> {
    const settings = this.configService.getSettings();
    const sessionManager = getSessionManager();
    const sessionId = await this.resolveSessionId();

    const userMessage: Message = {
      id: this.generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      attachments: attachments as MessageAttachment[] | undefined,
      metadata: messageMetadata,
    };

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

    // Get model config (with E4 session override support)
    let modelConfig = this.getModelConfig(settings);
    if (sessionId) {
      const modelState = getModelSessionState();
      const override = modelState.getOverride(sessionId);
      if (override) {
        if (override.adaptive === true) {
          // 用户选了"自动" → 保持默认 provider/model，只打开 adaptiveRouter
          modelConfig = { ...modelConfig, adaptive: true };
          logger.info('[模型选择] session 选了"自动"，使用默认模型 + adaptiveRouter');
        } else {
          const apiKey = this.configService.getApiKey(override.provider);
          modelConfig = {
            ...modelConfig,
            provider: override.provider,
            model: override.model,
            apiKey: apiKey || modelConfig.apiKey,
            temperature: override.temperature ?? modelConfig.temperature,
            maxTokens: override.maxTokens ?? modelConfig.maxTokens,
            adaptive: false,
          };
          logger.info(`[模型选择] 使用 session override: provider=${override.provider}, model=${override.model}`);
        }
      }
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
          if (intent === 'research') {
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

  async cancel(): Promise<void> {
    logger.info('Cancel requested');
    const sessionId = this.sessionId ?? getSessionManager().getCurrentSessionId();

    this.isInterrupting = false;
    this.pendingSteerMessages = [];

    if (this.agentLoop) {
      this.agentLoop.cancel();
      this.agentLoop = null;
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
      type: 'agent_complete',
      data: null,
      sessionId,
    } as AgentEvent & { sessionId?: string });
  }

  async interruptAndContinue(
    newMessage: string,
    attachments?: unknown[],
    options?: AgentRunOptions,
    messageMetadata?: MessageMetadata,
  ): Promise<void> {
    logger.info('Interrupt and continue requested');
    const sessionManager = getSessionManager();
    const sessionId = this.sessionId ?? sessionManager.getCurrentSessionId();
    const effectiveMessage = this.applyTurnSystemContext(newMessage, options);

    if (this.isInterrupting) {
      logger.info('[AgentOrchestrator] Already interrupting, queuing message');
      this.pendingSteerMessages.push(effectiveMessage);
      return;
    }

    this.isInterrupting = true;

    this.onEvent({
      type: 'interrupt_start',
      data: { message: '正在调整方向...', newUserMessage: newMessage },
      sessionId,
    } as AgentEvent & { sessionId?: string });

    if (this.agentLoop) {
      this.agentLoop.steer(effectiveMessage);

      while (this.pendingSteerMessages.length > 0) {
        const queued = this.pendingSteerMessages.shift()!;
        this.agentLoop.steer(queued);
        logger.info('[AgentOrchestrator] Processed queued steer message');
      }

      this.onEvent({
        type: 'interrupt_complete',
        data: { message: '已调整方向', newUserMessage: newMessage },
        sessionId,
      } as AgentEvent & { sessionId?: string });

      this.isInterrupting = false;
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
      type: 'interrupt_complete',
      data: { message: '已切换到新任务', newUserMessage: newMessage },
      sessionId,
    } as AgentEvent & { sessionId?: string });

    this.isInterrupting = false;

    const allMessages = [newMessage, ...this.pendingSteerMessages.splice(0)];
    await this.sendMessage(allMessages[allMessages.length - 1], attachments, options, messageMetadata);
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
      addMessage: (msg) => this.addMessage(msg),
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
          addMessage: (msg) => this.addMessage(msg),
          sendDAGStatusEvent: (dagId, agentId, status) => this.syncAutoAgentDAGStatus(dagId, agentId, status),
          runStandardAgentLoop: (c, e, m, s, executionPrompt, toolScope, executionIntent) =>
            this.runStandardAgentLoop(c, e, m, s, executionPrompt, toolScope, executionIntent),
          toolScope: options?.toolScope,
          executionIntent: options?.executionIntent,
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
              },
            } as any);
          }
        } catch { /* ignore - token sync is best effort */ }
        getTelemetryCollector().endSession(sessionId);
      }
    }
  }

  private async runStandardAgentLoop(
    content: string,
    onEvent: (event: AgentEvent) => void,
    modelConfig: ModelConfig,
    sessionId?: string,
    executionContent?: string,
    toolScope?: AgentRunOptions['toolScope'],
    executionIntent?: AgentRunOptions['executionIntent'],
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

    const routingResolution = await this.resolveAgentRouting(content, sessionId);
    let effectiveModelConfig = modelConfig;

    if (routingResolution) {
      logger.info('Agent routing resolved', {
        agentId: routingResolution.agent.id,
        agentName: routingResolution.agent.name,
        score: routingResolution.score,
        reason: routingResolution.reason,
      });

      if (routingResolution.agent.modelOverride) {
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
      }

      if (routingResolution.agent.systemPrompt) {
        logger.debug('System prompt overridden by agent', {
          agentId: routingResolution.agent.id,
        });
      }

      onEvent({
        type: 'routing_resolved',
        data: {
          mode: 'auto',
          agentId: routingResolution.agent.id,
          agentName: routingResolution.agent.name,
          reason: routingResolution.reason,
          score: routingResolution.score,
          fallbackToDefault: false,
          timestamp: Date.now(),
        },
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
        data: {
          mode: 'auto',
          agentId: 'default',
          agentName: 'default',
          reason: 'No specialized agent matched; continue with the default conversation loop.',
          score: 0,
          fallbackToDefault: true,
          timestamp: Date.now(),
        },
      });
    }

    const telemetryAdapter = sessionId
      ? getTelemetryCollector().createAdapter(sessionId, 'main')
      : undefined;

    this.agentLoop = new AgentLoop({
      systemPrompt: routingResolution?.agent?.systemPrompt || SYSTEM_PROMPT,
      modelConfig: effectiveModelConfig,
      toolExecutor: this.toolExecutor,
      messages: this.messages,
      onEvent: dagAwareOnEvent,
      planningService: this.planningService,
      sessionId,
      workingDirectory: this.workingDirectory,
      isDefaultWorkingDirectory: this.isDefaultWorkingDirectory,
      toolScope,
      executionIntent,
      telemetryAdapter,
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
      await this.agentLoop.run(effectiveContent);
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
