// ============================================================================
// UnifiedOrchestrator - 统一指挥家
// 智能路由任务到本地或云端执行
// ============================================================================

import { EventEmitter } from 'events';
import type { ModelConfig } from '../../shared/types';
import type { TaskExecutionLocation } from '../../shared/types/cloud';
import type {
  OrchestratorRequest,
  OrchestratorResult,
  OrchestratorConfig,
  OrchestratorEvent,
  OrchestratorEventType,
  RoutingDecision,
  ExecutorRequest,
  ExecutorResult,
  UserRoutingPreferences,
} from './types';
import { getTaskAnalyzer, TaskAnalyzer } from './TaskAnalyzer';
import { getExecutionRouter, ExecutionRouter } from './ExecutionRouter';
import { getLocalExecutor, LocalExecutor } from './LocalExecutor';
import { getCloudExecutor, CloudExecutor } from './CloudExecutor';
import { getHybridTaskCoordinator, HybridTaskCoordinator } from '../cloud/HybridTaskCoordinator';

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_CONFIG: OrchestratorConfig = {
  localExecutor: {
    maxConcurrent: 2,
    defaultTimeout: 120000,
    maxIterations: 30,
  },
  cloudExecutor: {
    maxConcurrent: 5,
    defaultTimeout: 180000,
    maxIterations: 50,
  },
  hybridCoordinator: {
    autoSplitThreshold: 100,
    preferLocalForSensitive: true,
  },
};

// ============================================================================
// UnifiedOrchestrator 类
// ============================================================================

export class UnifiedOrchestrator extends EventEmitter {
  private config: OrchestratorConfig;
  private analyzer: TaskAnalyzer;
  private router: ExecutionRouter;
  private localExecutor: LocalExecutor;
  private cloudExecutor: CloudExecutor;
  private hybridCoordinator: HybridTaskCoordinator;
  private modelConfig?: ModelConfig;
  private executionHistory: Map<string, OrchestratorResult> = new Map();
  private isInitialized = false;

  constructor(config: Partial<OrchestratorConfig> = {}) {
    super();
    this.config = this.mergeConfig(DEFAULT_CONFIG, config);

    // 初始化组件
    this.analyzer = getTaskAnalyzer();
    this.router = getExecutionRouter();
    this.localExecutor = getLocalExecutor();
    this.cloudExecutor = getCloudExecutor();
    this.hybridCoordinator = getHybridTaskCoordinator();

    // 监听执行器事件
    this.setupEventListeners();
  }

  /**
   * 初始化
   */
  initialize(context: {
    modelConfig: ModelConfig;
    authToken?: string;
  }): void {
    this.modelConfig = context.modelConfig;
    this.localExecutor.initialize(context.modelConfig);

    if (context.authToken) {
      this.cloudExecutor.setAuthToken(context.authToken);
    }

    this.isInitialized = true;
  }

  /**
   * 执行任务（主入口）
   */
  async execute(request: OrchestratorRequest): Promise<OrchestratorResult> {
    const startTime = Date.now();
    const requestId = this.generateRequestId();

    // 发送分析开始事件
    this.emitEvent('analysis:start', requestId, { prompt: request.prompt });

    try {
      // Step 1: 分析任务
      const analysis = this.analyzer.analyze(request.prompt, {
        fileTree: request.context?.fileTree,
        currentFile: request.context?.currentFile,
      });

      this.emitEvent('analysis:complete', requestId, { analysis });

      // Step 2: 路由决策
      this.emitEvent('routing:start', requestId, { analysis });

      let routingDecision: RoutingDecision;

      if (request.forceLocation) {
        // 强制指定位置
        routingDecision = {
          decisionId: `forced_${requestId}`,
          recommendedLocation: request.forceLocation,
          reason: '用户强制指定执行位置',
          priority: 'P4_PREFERENCE',
          confidence: 1.0,
          alternatives: [],
          analysis,
        };
      } else {
        // 智能路由
        routingDecision = this.router.routeWithAnalysis(analysis, request.preferences);
      }

      this.emitEvent('routing:complete', requestId, { routingDecision });

      // Step 3: 执行
      this.emitEvent('execution:start', requestId, {
        location: routingDecision.recommendedLocation,
      });

      const executorRequest: ExecutorRequest = {
        requestId,
        prompt: request.prompt,
        maxIterations: request.maxIterations,
        timeout: request.timeout,
        context: request.context,
        modelConfig: request.modelConfig || this.modelConfig,
      };

      let executionResult: ExecutorResult;

      switch (routingDecision.recommendedLocation) {
        case 'local':
          executionResult = await this.executeLocal(executorRequest);
          break;
        case 'cloud':
          executionResult = await this.executeCloud(executorRequest);
          break;
        case 'hybrid':
          executionResult = await this.executeHybrid(executorRequest);
          break;
        default:
          executionResult = await this.executeLocal(executorRequest);
      }

      this.emitEvent('execution:complete', requestId, { executionResult });

      // 构建结果
      const result: OrchestratorResult = {
        requestId,
        success: executionResult.success,
        output: executionResult.output,
        error: executionResult.error,
        routingDecision,
        executionResult,
        totalDuration: Date.now() - startTime,
      };

      // 记录历史
      this.executionHistory.set(requestId, result);

      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.emitEvent('execution:error', requestId, { error: errorMessage });

      // 构建错误结果
      const errorResult: OrchestratorResult = {
        requestId,
        success: false,
        error: errorMessage,
        routingDecision: {
          decisionId: `error_${requestId}`,
          recommendedLocation: 'local',
          reason: '执行过程中发生错误',
          priority: 'P1_SECURITY',
          confidence: 0,
          alternatives: [],
          analysis: this.analyzer.analyze(request.prompt),
        },
        executionResult: {
          requestId,
          success: false,
          error: errorMessage,
          location: 'local',
          duration: Date.now() - startTime,
          iterations: 0,
          toolsUsed: [],
        },
        totalDuration: Date.now() - startTime,
      };

      this.executionHistory.set(requestId, errorResult);

      return errorResult;
    }
  }

  /**
   * 流式执行
   */
  async *executeStream(
    request: OrchestratorRequest
  ): AsyncGenerator<{ type: string; content?: string; data?: unknown }> {
    const requestId = this.generateRequestId();

    // 分析和路由
    const analysis = this.analyzer.analyze(request.prompt, {
      fileTree: request.context?.fileTree,
      currentFile: request.context?.currentFile,
    });

    const routingDecision = request.forceLocation
      ? {
          decisionId: `forced_${requestId}`,
          recommendedLocation: request.forceLocation,
          reason: '用户强制指定执行位置',
          priority: 'P4_PREFERENCE' as const,
          confidence: 1.0,
          alternatives: [],
          analysis,
        }
      : this.router.routeWithAnalysis(analysis, request.preferences);

    yield {
      type: 'routing',
      data: {
        location: routingDecision.recommendedLocation,
        reason: routingDecision.reason,
      },
    };

    // 根据位置选择执行方式
    if (routingDecision.recommendedLocation === 'cloud') {
      const executorRequest: ExecutorRequest = {
        requestId,
        prompt: request.prompt,
        maxIterations: request.maxIterations,
        timeout: request.timeout,
        context: request.context,
        modelConfig: request.modelConfig || this.modelConfig,
      };

      for await (const event of this.cloudExecutor.executeStream(executorRequest)) {
        yield event;
      }
    } else {
      // 本地执行暂不支持流式，直接返回结果
      const executorRequest: ExecutorRequest = {
        requestId,
        prompt: request.prompt,
        maxIterations: request.maxIterations,
        timeout: request.timeout,
        context: request.context,
        modelConfig: request.modelConfig || this.modelConfig,
      };

      const result = await this.localExecutor.execute(executorRequest);
      yield { type: 'text', content: result.output };
      yield { type: 'done' };
    }
  }

  /**
   * 本地执行
   */
  private async executeLocal(request: ExecutorRequest): Promise<ExecutorResult> {
    return this.localExecutor.execute(request);
  }

  /**
   * 云端执行
   */
  private async executeCloud(request: ExecutorRequest): Promise<ExecutorResult> {
    // 先检查云端是否可用
    const isHealthy = await this.cloudExecutor.checkHealth();

    if (!isHealthy) {
      // 云端不可用，回退到本地
      console.warn('[UnifiedOrchestrator] Cloud unavailable, falling back to local');
      return this.localExecutor.execute(request);
    }

    return this.cloudExecutor.execute(request);
  }

  /**
   * 混合执行
   */
  private async executeHybrid(request: ExecutorRequest): Promise<ExecutorResult> {
    // 使用 HybridTaskCoordinator 进行混合执行
    const result = await this.hybridCoordinator.execute({
      type: 'analyzer',
      title: request.prompt.slice(0, 50),
      description: '',
      prompt: request.prompt,
      location: 'hybrid',
      maxIterations: request.maxIterations,
      timeout: request.timeout,
      sessionId: request.context?.sessionId,
      projectId: request.context?.projectId,
    });

    return {
      requestId: request.requestId,
      success: result.success,
      output: result.output,
      error: result.error,
      location: 'hybrid',
      duration: result.duration,
      iterations: result.iterations,
      toolsUsed: result.toolsUsed,
    };
  }

  /**
   * 分析任务（不执行）
   */
  analyzeTask(prompt: string, context?: { fileTree?: string[]; currentFile?: string }) {
    return this.analyzer.analyze(prompt, context);
  }

  /**
   * 获取路由建议（不执行）
   */
  getRoutingRecommendation(
    prompt: string,
    preferences?: Partial<UserRoutingPreferences>,
    context?: { fileTree?: string[]; currentFile?: string }
  ): RoutingDecision {
    return this.router.route(prompt, preferences, context);
  }

  /**
   * 获取执行历史
   */
  getExecutionHistory(): OrchestratorResult[] {
    return Array.from(this.executionHistory.values());
  }

  /**
   * 获取指定执行记录
   */
  getExecutionResult(requestId: string): OrchestratorResult | undefined {
    return this.executionHistory.get(requestId);
  }

  /**
   * 清除历史
   */
  clearHistory(): void {
    this.executionHistory.clear();
  }

  /**
   * 检查云端状态
   */
  async checkCloudStatus(): Promise<{
    available: boolean;
    latency?: number;
  }> {
    const startTime = Date.now();
    const available = await this.cloudExecutor.checkHealth();
    return {
      available,
      latency: available ? Date.now() - startTime : undefined,
    };
  }

  /**
   * 获取当前状态
   */
  getStatus(): {
    initialized: boolean;
    localRunning: number;
    cloudRunning: number;
    historyCount: number;
  } {
    return {
      initialized: this.isInitialized,
      localRunning: this.localExecutor.getRunningCount(),
      cloudRunning: this.cloudExecutor.getRunningCount(),
      historyCount: this.executionHistory.size,
    };
  }

  /**
   * 设置事件监听器
   */
  private setupEventListeners(): void {
    // 监听本地执行器进度
    this.localExecutor.on('progress', (event) => {
      this.emitEvent('execution:progress', event.requestId, event);
    });

    // 监听云端执行器进度
    this.cloudExecutor.on('progress', (event) => {
      this.emitEvent('execution:progress', event.requestId, event);
    });

    // 监听混合协调器进度
    this.hybridCoordinator.on('progress', (event) => {
      this.emitEvent('execution:progress', event.taskId, event);
    });
  }

  /**
   * 发送事件
   */
  private emitEvent(type: OrchestratorEventType, requestId: string, data: unknown): void {
    const event: OrchestratorEvent = {
      type,
      requestId,
      timestamp: Date.now(),
      data,
    };
    this.emit(type, event);
    this.emit('event', event);
  }

  /**
   * 生成请求 ID
   */
  private generateRequestId(): string {
    return `orch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * 合并配置
   */
  private mergeConfig(
    defaultConfig: OrchestratorConfig,
    userConfig: Partial<OrchestratorConfig>
  ): OrchestratorConfig {
    return {
      ...defaultConfig,
      ...userConfig,
      localExecutor: defaultConfig.localExecutor && userConfig.localExecutor
        ? { ...defaultConfig.localExecutor, ...userConfig.localExecutor }
        : defaultConfig.localExecutor || userConfig.localExecutor,
      cloudExecutor: defaultConfig.cloudExecutor && userConfig.cloudExecutor
        ? { ...defaultConfig.cloudExecutor, ...userConfig.cloudExecutor }
        : defaultConfig.cloudExecutor || userConfig.cloudExecutor,
      hybridCoordinator: defaultConfig.hybridCoordinator && userConfig.hybridCoordinator
        ? { ...defaultConfig.hybridCoordinator, ...userConfig.hybridCoordinator }
        : defaultConfig.hybridCoordinator || userConfig.hybridCoordinator,
    };
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.executionHistory.clear();
    this.hybridCoordinator.dispose();
    this.removeAllListeners();
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let orchestratorInstance: UnifiedOrchestrator | null = null;

export function getUnifiedOrchestrator(): UnifiedOrchestrator {
  if (!orchestratorInstance) {
    orchestratorInstance = new UnifiedOrchestrator();
  }
  return orchestratorInstance;
}

export function initUnifiedOrchestrator(config: Partial<OrchestratorConfig>): UnifiedOrchestrator {
  orchestratorInstance = new UnifiedOrchestrator(config);
  return orchestratorInstance;
}
