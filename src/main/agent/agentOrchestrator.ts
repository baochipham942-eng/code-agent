// ============================================================================
// Agent Orchestrator - Main controller for the AI agent
// ============================================================================

import type {
  AgentEvent,
  Message,
  MessageAttachment,
  PermissionRequest,
  PermissionResponse,
  ModelConfig,
  ModelProvider,
} from '../../shared/types';
import type { ReportStyle, AgentRunOptions, ResearchUserSettings } from '../research/types';
import { AgentLoop } from './agentLoop';
import { ToolRegistry } from '../tools/toolRegistry';
import { ToolExecutor } from '../tools/toolExecutor';
import type { GenerationManager } from '../generation/generationManager';
import type { ConfigService } from '../services/core/configService';
import { getSessionManager, getAuthService } from '../services';
import type { PlanningService } from '../planning';
import { DeepResearchMode, SemanticResearchOrchestrator } from '../research';
import { getSessionStateManager } from '../session/sessionStateManager';
import { ModelRouter } from '../model/modelRouter';
import { generateMessageId, generatePermissionRequestId } from '../../shared/utils/id';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
// Auto Agent Generation
import { getAgentRequirementsAnalyzer } from './agentRequirementsAnalyzer';
import { getDynamicAgentFactory } from './dynamicAgentFactory';
import { getAutoAgentCoordinator } from './autoAgentCoordinator';
import { DEFAULT_MODELS } from '../../shared/constants';
// Agent Routing
import { getRoutingService } from '../routing';
import type { RoutingContext, RoutingResolution } from '../../shared/types/agentRouting';

const logger = createLogger('AgentOrchestrator');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Agent Orchestrator 配置
 * @internal
 */
export interface AgentOrchestratorConfig {
  generationManager: GenerationManager;
  configService: ConfigService;
  onEvent: (event: AgentEvent) => void;
  planningService?: PlanningService;
}

// ----------------------------------------------------------------------------
// Agent Orchestrator
// ----------------------------------------------------------------------------

/**
 * Agent Orchestrator - AI Agent 的主控制器
 *
 * 负责管理 Agent 的完整生命周期，包括：
 * - 对话消息历史管理
 * - 权限请求和响应处理
 * - 模型配置获取
 * - AgentLoop 创建和启动
 * - 工作目录管理
 *
 * @example
 * ```typescript
 * const orchestrator = new AgentOrchestrator({
 *   generationManager,
 *   configService,
 *   onEvent: (event) => console.log(event),
 * });
 *
 * await orchestrator.sendMessage('帮我写一个贪吃蛇游戏');
 * orchestrator.cancel(); // 取消执行
 * ```
 *
 * @see AgentLoop - 核心执行循环
 * @see ToolRegistry - 工具注册表
 * @see ToolExecutor - 工具执行器
 */
// 消息历史最大长度（内存管理）
const MAX_MESSAGES_IN_MEMORY = 200;

export class AgentOrchestrator {
  private generationManager: GenerationManager;
  private configService: ConfigService;
  private toolRegistry: ToolRegistry;
  private toolExecutor: ToolExecutor;
  private agentLoop: AgentLoop | null = null;
  private deepResearchMode: DeepResearchMode | null = null;
  private semanticResearchOrchestrator: SemanticResearchOrchestrator | null = null;
  private onEvent: (event: AgentEvent) => void;
  private workingDirectory: string;
  private isDefaultWorkingDirectory: boolean = true; // Track if using default sandbox
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

  constructor(config: AgentOrchestratorConfig) {
    this.generationManager = config.generationManager;
    this.configService = config.configService;
    this.onEvent = config.onEvent;

    // 设置默认工作目录为 app/work 文件夹
    this.workingDirectory = this.initializeWorkDirectory();
    this.isDefaultWorkingDirectory = true; // Default sandbox
    logger.info('Initial working directory:', this.workingDirectory);
    this.planningService = config.planningService;

    // Initialize tool registry and executor
    this.toolRegistry = new ToolRegistry();
    this.toolExecutor = new ToolExecutor({
      toolRegistry: this.toolRegistry,
      requestPermission: this.requestPermission.bind(this),
      workingDirectory: this.workingDirectory,
    });
  }

  /**
   * 初始化工作目录
   * 默认使用 app 数据目录下的 work 文件夹，确保有写入权限
   *
   * 性能优化：目录创建延迟到后台执行，构造函数不阻塞
   */
  private initializeWorkDirectory(): string {
    try {
      // 使用 Electron 的 userData 目录（有写入权限）
      const userDataPath = app.getPath('userData');
      const workDir = path.join(userDataPath, 'work');

      // 异步确保目录存在（不阻塞构造函数）
      fs.promises.mkdir(workDir, { recursive: true })
        .then(() => logger.debug('Work directory ensured:', workDir))
        .catch((err) => {
          // EEXIST 表示目录已存在，不是错误
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
            logger.warn('Failed to create work directory:', err);
          }
        });

      return workDir;
    } catch (error) {
      // 如果获取 app 路径失败（如在测试环境），回退到当前目录
      logger.warn('Failed to get userData path, falling back to cwd:', error);
      return process.cwd();
    }
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  /**
   * 发送用户消息并启动 Agent 执行循环
   *
   * @param content - 用户消息内容
   * @param attachments - 可选的附件列表（图片、文件等）
   * @param options - 可选的运行选项（模式、报告风格等）
   * @returns Promise 在 Agent 执行完成后 resolve
   * @throws 执行过程中的错误会通过 onEvent 发送 error 事件
   *
   * @example
   * ```typescript
   * await orchestrator.sendMessage('请帮我创建一个 React 组件');
   * await orchestrator.sendMessage('分析这张图片', [{ type: 'image', data: base64 }]);
   * await orchestrator.sendMessage('研究 AI Agent', undefined, { mode: 'deep-research', reportStyle: 'academic' });
   * ```
   */
  async sendMessage(
    content: string,
    attachments?: unknown[],
    options?: AgentRunOptions
  ): Promise<void> {
    const generation = this.generationManager.getCurrentGeneration();
    const settings = this.configService.getSettings();
    const sessionManager = getSessionManager();

    // 获取当前会话 ID（在创建 AgentLoop 之前）
    // 这样事件就会关联到正确的会话，即使用户在执行过程中切换会话
    const currentSession = await sessionManager.getCurrentSession();
    const sessionId = currentSession?.id;

    // Create user message
    const userMessage: Message = {
      id: this.generateId(),
      role: 'user',
      content,
      timestamp: Date.now(),
      attachments: attachments as MessageAttachment[] | undefined,
    };

    this.addMessage(userMessage);
    logger.debug('User message added, hasAttachments:', !!userMessage.attachments?.length, 'count:', userMessage.attachments?.length || 0);
    // Note: Don't emit user message event - frontend already added it

    // 持久化保存用户消息
    try {
      await sessionManager.addMessage(userMessage);
    } catch (error) {
      logger.error('Failed to save user message:', error);
    }

    // Get model config
    const modelConfig = this.getModelConfig(settings);

    // Create agent loop with session-aware event handler
    // Wrap onEvent to inject sessionId, ensuring events are associated with the correct session
    const sessionAwareOnEvent = (event: AgentEvent) => {
      // Inject sessionId into all events for proper session isolation
      this.onEvent({ ...event, sessionId } as AgentEvent & { sessionId?: string });
    };

    // Check if deep research mode is requested or should be auto-detected
    const mode = options?.mode ?? 'normal';

    if (mode === 'deep-research') {
      // Manual deep research mode
      await this.runDeepResearchMode(content, options?.reportStyle, sessionAwareOnEvent, modelConfig, generation);
    } else if (this.researchUserSettings.autoDetect && mode === 'normal') {
      // Semantic auto-detection: check if research is needed
      const shouldResearch = await this.checkAndRunSemanticResearch(
        content,
        options?.reportStyle,
        sessionAwareOnEvent,
        modelConfig,
        generation,
        sessionId
      );

      if (!shouldResearch) {
        // Research not triggered, run normal mode
        await this.runNormalMode(content, sessionAwareOnEvent, modelConfig, generation, sessionId);
      }
    } else {
      // Normal Mode: Create and run agent loop
      await this.runNormalMode(content, sessionAwareOnEvent, modelConfig, generation, sessionId);
    }
  }

  /**
   * 检查并运行语义研究模式
   *
   * @returns true 如果研究模式被触发并执行，false 否则
   */
  private async checkAndRunSemanticResearch(
    content: string,
    reportStyle: ReportStyle | undefined,
    onEvent: (event: AgentEvent) => void,
    modelConfig: ModelConfig,
    generation: ReturnType<GenerationManager['getCurrentGeneration']>,
    sessionId?: string
  ): Promise<boolean> {
    // Create model router
    const modelRouter = new ModelRouter();

    // Create semantic research orchestrator
    this.semanticResearchOrchestrator = new SemanticResearchOrchestrator({
      modelRouter,
      toolExecutor: this.toolExecutor,
      onEvent,
      generation,
      userSettings: this.researchUserSettings,
    });

    try {
      // Run semantic analysis and potential research
      const result = await this.semanticResearchOrchestrator.run(
        content,
        false, // Don't force research
        reportStyle
      );

      if (result.researchTriggered && result.success && result.report) {
        // Research was triggered and completed successfully
        // Add report as assistant message
        const reportMessage: Message = {
          id: this.generateId(),
          role: 'assistant',
          content: result.report.content,
          timestamp: Date.now(),
        };
        this.addMessage(reportMessage);

        // Emit message event
        onEvent({
          type: 'message',
          data: reportMessage,
        });

        logger.info('Semantic research completed:', {
          duration: result.duration,
          intent: result.classification?.intent,
        });

        // Emit completion event
        onEvent({ type: 'agent_complete', data: null });

        return true;
      }

      // Research was not triggered or failed
      if (result.researchTriggered && !result.success) {
        logger.warn('Semantic research failed:', result.error);
      }

      return false;
    } catch (error) {
      logger.error('Semantic research exception:', error);
      return false;
    } finally {
      this.semanticResearchOrchestrator = null;
    }
  }

  /**
   * 运行深度研究模式
   */
  private async runDeepResearchMode(
    topic: string,
    reportStyle: ReportStyle | undefined,
    onEvent: (event: AgentEvent) => void,
    modelConfig: ModelConfig,
    generation: ReturnType<GenerationManager['getCurrentGeneration']>
  ): Promise<void> {
    logger.info('========== Starting deep research mode ==========');
    logger.info('Topic:', topic);
    logger.info('Report style:', reportStyle);

    // Create model router
    const modelRouter = new ModelRouter();

    // Create deep research mode instance
    this.deepResearchMode = new DeepResearchMode({
      modelRouter,
      toolExecutor: this.toolExecutor,
      onEvent,
      generation,
    });

    try {
      const result = await this.deepResearchMode.run(topic, reportStyle ?? 'default');

      if (result.success && result.report) {
        // 将报告作为 assistant 消息添加
        const reportMessage: Message = {
          id: this.generateId(),
          role: 'assistant',
          content: result.report.content,
          timestamp: Date.now(),
        };
        this.addMessage(reportMessage);

        // 发送消息事件
        onEvent({
          type: 'message',
          data: reportMessage,
        });
      }

      logger.info('========== Deep research completed ==========');
      logger.info('Success:', result.success);
      logger.info('Duration:', result.duration, 'ms');
    } catch (error) {
      logger.error('========== Deep research EXCEPTION ==========');
      logger.error('Error:', error);
      onEvent({
        type: 'error',
        data: {
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    } finally {
      this.deepResearchMode = null;
      // 发送完成事件
      onEvent({ type: 'agent_complete', data: null });
    }
  }

  /**
   * 运行正常模式
   */
  private async runNormalMode(
    content: string,
    onEvent: (event: AgentEvent) => void,
    modelConfig: ModelConfig,
    generation: ReturnType<GenerationManager['getCurrentGeneration']>,
    sessionId?: string
  ): Promise<void> {
    // Update session state to running
    const sessionStateManager = getSessionStateManager();
    if (sessionId) {
      sessionStateManager.updateStatus(sessionId, 'running');
    }

    try {
      // Check if auto agent generation is needed
      const requirementsAnalyzer = getAgentRequirementsAnalyzer();
      const requirements = await requirementsAnalyzer.analyze(content, this.workingDirectory);

      if (requirements.needsAutoAgent) {
        // Use auto agent mode
        await this.runAutoAgentMode(
          content,
          requirements,
          onEvent,
          modelConfig,
          generation,
          sessionId
        );
      } else {
        // Use standard agent loop
        await this.runStandardAgentLoop(
          content,
          onEvent,
          modelConfig,
          generation,
          sessionId
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
      // Update session state to idle
      if (sessionId) {
        sessionStateManager.updateStatus(sessionId, 'idle');
      }
    }
  }

  /**
   * 运行标准 Agent Loop
   */
  private async runStandardAgentLoop(
    content: string,
    onEvent: (event: AgentEvent) => void,
    modelConfig: ModelConfig,
    generation: ReturnType<GenerationManager['getCurrentGeneration']>,
    sessionId?: string
  ): Promise<void> {
    // Resolve agent routing
    const routingResolution = await this.resolveAgentRouting(content, sessionId);
    let effectiveModelConfig = modelConfig;
    let effectiveGeneration = generation;

    if (routingResolution) {
      logger.info('Agent routing resolved', {
        agentId: routingResolution.agent.id,
        agentName: routingResolution.agent.name,
        score: routingResolution.score,
        reason: routingResolution.reason,
      });

      // Apply model override from agent config
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

      // Create custom generation with agent's system prompt
      if (routingResolution.agent.systemPrompt) {
        effectiveGeneration = {
          ...generation,
          systemPrompt: routingResolution.agent.systemPrompt,
        };
        logger.debug('System prompt overridden by agent', {
          agentId: routingResolution.agent.id,
        });
      }

      // Notify UI about agent selection
      onEvent({
        type: 'notification',
        data: {
          message: `使用 Agent: ${routingResolution.agent.name}`,
        },
      });
    }

    // Create agent loop with potentially overridden config
    this.agentLoop = new AgentLoop({
      generation: effectiveGeneration,
      modelConfig: effectiveModelConfig,
      toolRegistry: this.toolRegistry,
      toolExecutor: this.toolExecutor,
      messages: this.messages,
      onEvent,
      planningService: this.planningService,
      sessionId, // Pass sessionId for tracing
      workingDirectory: this.workingDirectory,
      isDefaultWorkingDirectory: this.isDefaultWorkingDirectory,
    });

    try {
      // Run agent loop
      logger.info('========== Starting agent loop ==========');
      await this.agentLoop.run(content);
      logger.info('========== Agent loop completed normally ==========');
    } finally {
      logger.info('========== Finally block, agentLoop = null ==========');
      this.agentLoop = null;
    }
  }

  /**
   * 解析 Agent 路由
   */
  private async resolveAgentRouting(
    userMessage: string,
    sessionId?: string
  ): Promise<RoutingResolution | null> {
    try {
      const routingService = getRoutingService();

      // Initialize routing service if not already
      if (!routingService.isInitialized()) {
        await routingService.initialize(this.workingDirectory);
      }

      const context: RoutingContext = {
        workingDirectory: this.workingDirectory,
        userMessage,
        sessionId,
      };

      const resolution = routingService.resolve(context);

      // Skip if default agent with no specific match
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
   * 运行自动 Agent 模式
   */
  private async runAutoAgentMode(
    content: string,
    requirements: Awaited<ReturnType<ReturnType<typeof getAgentRequirementsAnalyzer>['analyze']>>,
    onEvent: (event: AgentEvent) => void,
    modelConfig: ModelConfig,
    generation: ReturnType<GenerationManager['getCurrentGeneration']>,
    sessionId?: string
  ): Promise<void> {
    logger.info('========== Starting auto agent mode ==========');
    logger.info('Task type:', requirements.taskType);
    logger.info('Execution strategy:', requirements.executionStrategy);
    logger.info('Confidence:', requirements.confidence);

    // Create dynamic agents
    const factory = getDynamicAgentFactory();
    const agents = factory.create(requirements, {
      userMessage: content,
      workingDirectory: this.workingDirectory,
      sessionId,
    });

    if (agents.length === 0) {
      // Fallback to standard agent loop if no agents generated
      logger.warn('No auto agents generated, falling back to standard loop');
      await this.runStandardAgentLoop(content, onEvent, modelConfig, generation, sessionId);
      return;
    }

    // Notify UI about auto agent planning
    onEvent({
      type: 'agent_thinking',
      data: {
        message: `正在规划自动 Agent 执行...\n任务类型: ${requirements.taskType}\n策略: ${requirements.executionStrategy}\nAgent 数量: ${agents.length}`,
      },
    });

    // Execute agents through coordinator
    const coordinator = getAutoAgentCoordinator();
    const toolMap = new Map<string, import('../tools/toolRegistry').Tool>();
    for (const tool of this.toolRegistry.getAllTools()) {
      toolMap.set(tool.name, tool);
    }

    const result = await coordinator.execute(agents, requirements, {
      sessionId: sessionId || 'unknown',
      modelConfig,
      toolRegistry: toolMap,
      toolContext: {
        workingDirectory: this.workingDirectory,
        generation: { id: generation.id },
        requestPermission: async () => true, // Auto-approve for auto agents
      },
      onProgress: (agentId, status, progress) => {
        onEvent({
          type: 'agent_thinking',
          data: {
            message: `Agent ${agentId}: ${status}${progress !== undefined ? ` (${progress}%)` : ''}`,
            agentId,
            progress,
          },
        });
      },
    });

    // Process result
    if (result.success && result.aggregatedOutput) {
      // Create assistant message with aggregated output
      const assistantMessage: Message = {
        id: this.generateId(),
        role: 'assistant',
        content: result.aggregatedOutput,
        timestamp: Date.now(),
      };
      this.addMessage(assistantMessage);

      // Save and emit message
      const sessionManager = getSessionManager();
      try {
        await sessionManager.addMessage(assistantMessage);
      } catch (error) {
        logger.error('Failed to save auto agent result:', error);
      }

      onEvent({
        type: 'message',
        data: assistantMessage,
      });
    }

    // Log summary
    logger.info('========== Auto agent mode completed ==========');
    logger.info('Success:', result.success);
    logger.info('Total iterations:', result.totalIterations);
    logger.info('Total cost:', result.totalCost);
    if (result.errors.length > 0) {
      logger.warn('Errors:', result.errors);
    }

    // Emit completion
    onEvent({ type: 'agent_complete', data: null });
  }

  /**
   * 取消当前正在执行的 Agent 任务
   *
   * @returns Promise 在取消操作完成后 resolve
   */
  async cancel(): Promise<void> {
    logger.info('Cancel requested');

    // 获取当前会话 ID 用于事件
    const sessionId = getSessionManager().getCurrentSessionId();

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

    // 立即发送 agent_complete 事件，让前端更新状态
    // 这样用户可以立即看到反馈，而不需要等待当前 API 请求完成
    this.onEvent({
      type: 'agent_complete',
      data: null,
      sessionId,
    } as AgentEvent & { sessionId?: string });
  }

  /**
   * 设置研究用户设置
   *
   * @param settings - 研究设置
   */
  setResearchUserSettings(settings: Partial<ResearchUserSettings>): void {
    this.researchUserSettings = { ...this.researchUserSettings, ...settings };
    logger.debug('Research user settings updated:', this.researchUserSettings);
  }

  /**
   * 获取研究用户设置
   */
  getResearchUserSettings(): Partial<ResearchUserSettings> {
    return { ...this.researchUserSettings };
  }

  /**
   * 处理用户对权限请求的响应
   *
   * @param requestId - 权限请求的唯一标识符
   * @param response - 用户的响应（'allow' | 'allow_session' | 'deny'）
   */
  handlePermissionResponse(requestId: string, response: PermissionResponse): void {
    const pending = this.pendingPermissions.get(requestId);
    if (pending) {
      pending.resolve(response);
      this.pendingPermissions.delete(requestId);
    }
  }

  /**
   * 设置 Agent 的工作目录
   *
   * @param path - 新的工作目录路径
   */
  setWorkingDirectory(path: string): void {
    this.workingDirectory = path;
    this.isDefaultWorkingDirectory = false; // User explicitly set a directory
    this.toolExecutor.setWorkingDirectory(path);
    logger.info('Working directory changed to:', path);
  }

  /**
   * 获取当前工作目录
   *
   * @returns 当前工作目录的绝对路径
   */
  getWorkingDirectory(): string {
    return this.workingDirectory;
  }

  isUsingDefaultWorkingDirectory(): boolean {
    return this.isDefaultWorkingDirectory;
  }

  /**
   * 设置规划服务实例
   *
   * @param service - PlanningService 实例
   */
  setPlanningService(service: PlanningService): void {
    this.planningService = service;
  }

  /**
   * 设置消息历史
   *
   * 用于恢复会话时加载历史消息，确保 Agent 能够继续之前的对话。
   * 会完全替换当前的消息历史。
   *
   * @param messages - 历史消息数组
   */
  setMessages(messages: Message[]): void {
    this.messages = [...messages];
    logger.debug(`Messages set, count: ${this.messages.length}`);
  }

  /**
   * 获取当前消息历史
   *
   * @returns 消息数组的副本
   */
  getMessages(): Message[] {
    return [...this.messages];
  }

  /**
   * 清空消息历史
   *
   * 用于开始新对话时重置状态
   */
  clearMessages(): void {
    this.messages = [];
    logger.debug('Messages cleared');
  }

  /**
   * 添加消息到历史（带内存管理）
   *
   * 性能优化：限制内存中消息数量，防止长会话 OOM
   * 超出限制时保留最近的消息
   *
   * @param message - 要添加的消息
   */
  private addMessage(message: Message): void {
    this.messages.push(message);

    // 内存管理：限制消息数量
    if (this.messages.length > MAX_MESSAGES_IN_MEMORY) {
      const trimCount = this.messages.length - MAX_MESSAGES_IN_MEMORY;
      this.messages = this.messages.slice(trimCount);
      logger.debug(`Trimmed ${trimCount} old messages, keeping ${this.messages.length}`);
    }
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private async requestPermission(request: Omit<PermissionRequest, 'id' | 'timestamp'>): Promise<boolean> {
    const fullRequest: PermissionRequest = {
      ...request,
      id: generatePermissionRequestId(),
      timestamp: Date.now(),
    };

    // Auto-approve all permissions in AUTO_TEST mode
    if (process.env.AUTO_TEST) {
      logger.info(`[AUTO_TEST] Auto-approving permission: ${request.type} for ${request.tool}`);
      return true;
    }

    // Check auto-approve settings
    const settings = this.configService.getSettings();
    const permissionLevel = this.getPermissionLevel(request.type);

    // Dev mode: auto-approve all permissions (configurable)
    if (settings.permissions.devModeAutoApprove) {
      logger.info(`[DevMode] Auto-approving permission: ${request.type} for ${request.tool}`);
      return true;
    }

    if (settings.permissions.autoApprove[permissionLevel]) {
      return true;
    }

    // Send permission request to UI with timeout
    const PERMISSION_TIMEOUT = 60000; // 60 seconds timeout

    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        // Timeout - deny permission
        this.pendingPermissions.delete(fullRequest.id);
        logger.warn(`Timeout for ${request.type} on ${request.tool}, denying`);
        resolve(false);
      }, PERMISSION_TIMEOUT);

      this.pendingPermissions.set(fullRequest.id, {
        resolve: (response) => {
          clearTimeout(timeoutId);
          resolve(response === 'allow' || response === 'allow_session');
        },
        request: fullRequest,
      });
      this.onEvent({ type: 'permission_request', data: fullRequest });
    });
  }

  private getPermissionLevel(type: PermissionRequest['type']): 'read' | 'write' | 'execute' | 'network' {
    switch (type) {
      case 'file_read':
        return 'read';
      case 'file_write':
      case 'file_edit':
        return 'write';
      case 'command':
      case 'dangerous_command':
        return 'execute';
      case 'network':
        return 'network';
      default:
        return 'read';
    }
  }

  private getModelConfig(settings: ReturnType<ConfigService['getSettings']>): ModelConfig {
    const authService = getAuthService();
    const currentUser = authService.getCurrentUser();
    const isAdmin = currentUser?.isAdmin === true;

    // 从用户配置获取选择的 provider 和 model
    const userProviderStr = settings.models?.default || settings.models?.defaultProvider || 'deepseek';
    const providerConfig = settings.models?.providers?.[userProviderStr as keyof typeof settings.models.providers];
    const userModel = providerConfig?.model || this.getDefaultModel(userProviderStr);

    // 获取对应的 API Key
    const selectedApiKey = this.configService.getApiKey(userProviderStr as ModelProvider);

    let selectedProvider: ModelProvider = userProviderStr as ModelProvider;
    let selectedModel = userModel;

    logger.info(`[模型选择] 用户配置: provider=${selectedProvider}, model=${selectedModel}`);
    logger.debug(`Is admin: ${isAdmin}, hasApiKey: ${!!selectedApiKey}`);

    // 优先使用本地 API Key（无论是否管理员）
    // 只有当本地 Key 不存在且是管理员时，才走云端代理
    if (selectedApiKey) {
      logger.info(`[模型选择] 使用本地 API Key: ${selectedProvider}`);
      return {
        provider: selectedProvider,
        model: selectedModel,
        apiKey: selectedApiKey,
        temperature: 0.7,
        maxTokens: 4096,
      };
    }

    // 没有本地 Key，管理员走云端代理
    if (isAdmin) {
      // 云端代理支持的 provider（需要在 Vercel 环境变量中配置对应的 API Key）
      const cloudSupportedProviders = ['deepseek', 'openrouter', 'openai', 'anthropic', 'zhipu', 'groq', 'qwen', 'moonshot'];
      if (!cloudSupportedProviders.includes(selectedProvider)) {
        // 不支持的 provider，回退到 deepseek
        logger.warn(`[模型选择] 云端代理不支持 ${selectedProvider}，回退到 deepseek`);
        selectedProvider = 'deepseek' as ModelProvider;
        selectedModel = DEFAULT_MODELS.chat;
      }
      logger.info(`[模型选择] 管理员使用云端代理: ${selectedProvider}`);
      return {
        provider: selectedProvider,
        model: selectedModel,
        apiKey: undefined,
        useCloudProxy: true,
        temperature: 0.7,
        maxTokens: 4096,
      };
    }

    // 非管理员且没有 Key，报错
    logger.warn(`[模型选择] 未配置 ${selectedProvider} API Key`);
    return {
      provider: selectedProvider,
      model: selectedModel,
      apiKey: undefined,
      temperature: 0.7,
      maxTokens: 4096,
    };
  }

  private generateId(): string {
    return generateMessageId();
  }

  private getDefaultModel(provider: string): string {
    const defaultModels: Record<string, string> = {
      zhipu: 'glm-4.7',
      deepseek: DEFAULT_MODELS.chat,
      openai: 'gpt-4o',
      anthropic: 'claude-sonnet-4-20250514',
      openrouter: 'google/gemini-2.0-flash-exp:free',
      groq: 'llama-3.3-70b-versatile',
      qwen: 'qwen-max',
      moonshot: 'moonshot-v1-8k',
      gemini: 'gemini-1.5-pro',
    };
    return defaultModels[provider] || DEFAULT_MODELS.chat;
  }
}
