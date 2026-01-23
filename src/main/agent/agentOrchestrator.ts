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
} from '../../shared/types';
import type { ReportStyle, AgentRunOptions } from '../research/types';
import { AgentLoop } from './agentLoop';
import { ToolRegistry } from '../tools/toolRegistry';
import { ToolExecutor } from '../tools/toolExecutor';
import type { GenerationManager } from '../generation/generationManager';
import type { ConfigService } from '../services/core/configService';
import { getSessionManager, getAuthService } from '../services';
import type { PlanningService } from '../planning';
import { DeepResearchMode } from '../research';
import { ModelRouter } from '../model/modelRouter';
import { generateMessageId, generatePermissionRequestId } from '../../shared/utils/id';
import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';

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
export class AgentOrchestrator {
  private generationManager: GenerationManager;
  private configService: ConfigService;
  private toolRegistry: ToolRegistry;
  private toolExecutor: ToolExecutor;
  private agentLoop: AgentLoop | null = null;
  private deepResearchMode: DeepResearchMode | null = null;
  private onEvent: (event: AgentEvent) => void;
  private workingDirectory: string;
  private messages: Message[] = [];
  private pendingPermissions: Map<string, {
    resolve: (response: PermissionResponse) => void;
    request: PermissionRequest;
  }> = new Map();
  private planningService?: PlanningService;

  constructor(config: AgentOrchestratorConfig) {
    this.generationManager = config.generationManager;
    this.configService = config.configService;
    this.onEvent = config.onEvent;

    // 设置默认工作目录为 app/work 文件夹
    this.workingDirectory = this.initializeWorkDirectory();
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
   */
  private initializeWorkDirectory(): string {
    try {
      // 使用 Electron 的 userData 目录（有写入权限）
      const userDataPath = app.getPath('userData');
      const workDir = path.join(userDataPath, 'work');

      // 确保目录存在
      if (!fs.existsSync(workDir)) {
        fs.mkdirSync(workDir, { recursive: true });
        logger.info('Created work directory:', workDir);
      }

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

    this.messages.push(userMessage);
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

    // Check if deep research mode is requested
    const mode = options?.mode ?? 'normal';

    if (mode === 'deep-research') {
      // Deep Research Mode
      await this.runDeepResearchMode(content, options?.reportStyle, sessionAwareOnEvent, modelConfig, generation);
    } else {
      // Normal Mode: Create and run agent loop
      await this.runNormalMode(content, sessionAwareOnEvent, modelConfig, generation, sessionId);
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
        this.messages.push(reportMessage);

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
    // Create agent loop
    this.agentLoop = new AgentLoop({
      generation,
      modelConfig,
      toolRegistry: this.toolRegistry,
      toolExecutor: this.toolExecutor,
      messages: this.messages,
      onEvent,
      planningService: this.planningService,
      sessionId, // Pass sessionId for tracing
    });

    try {
      // Run agent loop
      logger.info('========== Starting agent loop ==========');
      await this.agentLoop.run(content);
      logger.info('========== Agent loop completed normally ==========');
    } catch (error) {
      logger.error('========== Agent loop EXCEPTION ==========');
      logger.error('Error:', error);
      logger.error('Stack:', error instanceof Error ? error.stack : 'no stack');
      onEvent({
        type: 'error',
        data: {
          message: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    } finally {
      logger.info('========== Finally block, agentLoop = null ==========');
      this.agentLoop = null;
    }
  }

  /**
   * 取消当前正在执行的 Agent 任务
   *
   * @returns Promise 在取消操作完成后 resolve
   */
  async cancel(): Promise<void> {
    if (this.agentLoop) {
      this.agentLoop.cancel();
      this.agentLoop = null;
    }
    if (this.deepResearchMode) {
      this.deepResearchMode.cancel();
      this.deepResearchMode = null;
    }
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
    this.toolExecutor.setWorkingDirectory(path);
  }

  /**
   * 获取当前工作目录
   *
   * @returns 当前工作目录的绝对路径
   */
  getWorkingDirectory(): string {
    return this.workingDirectory;
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

  private getModelConfig(_settings: ReturnType<ConfigService['getSettings']>): ModelConfig {
    const defaultProvider = 'deepseek';
    const authService = getAuthService();
    const currentUser = authService.getCurrentUser();
    const isAdmin = currentUser?.isAdmin === true;

    logger.debug(`Using provider: ${defaultProvider}`);
    logger.debug(`Is admin: ${isAdmin}`);

    // 管理员使用云端代理，不需要本地 API Key
    if (isAdmin) {
      logger.info('Admin user detected, using cloud proxy');
      return {
        provider: defaultProvider,
        model: 'deepseek-chat',
        apiKey: undefined,
        useCloudProxy: true,
        temperature: 0.7,
        maxTokens: 4096,
      };
    }

    // 非管理员使用本地 API Key
    const apiKey = this.configService.getApiKey(defaultProvider);
    logger.debug(`API Key exists: ${!!apiKey}`);
    logger.debug(`API Key prefix: ${apiKey?.substring(0, 10)}...`);

    return {
      provider: defaultProvider,
      model: 'deepseek-chat',
      apiKey,
      temperature: 0.7,
      maxTokens: 4096,
    };
  }

  private generateId(): string {
    return generateMessageId();
  }
}
