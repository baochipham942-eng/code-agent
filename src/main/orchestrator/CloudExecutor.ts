// ============================================================================
// CloudExecutor - 云端执行器
// 将任务发送到云端执行
// ============================================================================

import { EventEmitter } from 'events';
import type { ModelConfig } from '../../shared/types';
import type {
  CloudTask,
  TaskExecutionLocation,
  CreateCloudTaskRequest,
  CloudAgentType,
} from '../../shared/types/cloud';
import type {
  ExecutorRequest,
  ExecutorResult,
  ExecutionProgressEvent,
} from './types';

// ============================================================================
// 配置
// ============================================================================

export interface CloudExecutorConfig {
  maxConcurrent: number;
  defaultTimeout: number;
  maxIterations: number;
  apiEndpoint: string;
}

const DEFAULT_CONFIG: CloudExecutorConfig = {
  maxConcurrent: 5,
  defaultTimeout: 180000,
  maxIterations: 50,
  apiEndpoint: process.env.CLOUD_API_ENDPOINT || 'https://code-agent-beta.vercel.app',
};

// ============================================================================
// CloudExecutor 类
// ============================================================================

export class CloudExecutor extends EventEmitter {
  private config: CloudExecutorConfig;
  private runningTasks: Map<string, CloudTask> = new Map();
  private cancelledTasks: Set<string> = new Set();
  private authToken?: string;

  constructor(config: Partial<CloudExecutorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 设置认证令牌
   */
  setAuthToken(token: string): void {
    this.authToken = token;
  }

  /**
   * 执行任务
   */
  async execute(request: ExecutorRequest): Promise<ExecutorResult> {
    const startTime = Date.now();
    const { requestId, prompt, maxIterations, timeout, context, taskType } = request;

    // 检查并发限制
    while (this.runningTasks.size >= this.config.maxConcurrent) {
      await this.sleep(100);
    }

    // 发送开始事件
    this.emitProgress(requestId, 0, '准备发送到云端');

    try {
      // 构建云端任务请求
      const cloudRequest: CreateCloudTaskRequest = {
        type: (taskType as CloudAgentType) || 'analyzer',
        title: this.extractTitle(prompt),
        description: '',
        prompt,
        location: 'cloud',
        maxIterations: maxIterations || this.config.maxIterations,
        timeout: timeout || this.config.defaultTimeout,
        sessionId: context?.sessionId,
        projectId: context?.projectId,
        metadata: {
          requestId,
          projectPath: context?.projectPath,
          currentFile: context?.currentFile,
        },
      };

      // 发送进度事件
      this.emitProgress(requestId, 10, '发送到云端');

      // 调用云端 API
      const result = await this.callCloudApi(cloudRequest);

      // 发送完成事件
      this.emitProgress(requestId, 100, '云端执行完成');

      return {
        requestId,
        success: result.success,
        output: result.output,
        error: result.error,
        location: 'cloud' as TaskExecutionLocation,
        duration: Date.now() - startTime,
        iterations: result.iterations || 0,
        toolsUsed: result.toolsUsed || [],
        metadata: {
          cloudTaskId: result.taskId,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      return {
        requestId,
        success: false,
        error: `云端执行失败: ${errorMessage}`,
        location: 'cloud' as TaskExecutionLocation,
        duration: Date.now() - startTime,
        iterations: 0,
        toolsUsed: [],
      };
    }
  }

  /**
   * 调用云端 API
   */
  private async callCloudApi(request: CreateCloudTaskRequest): Promise<{
    success: boolean;
    output?: string;
    error?: string;
    taskId?: string;
    iterations?: number;
    toolsUsed?: string[];
  }> {
    const url = `${this.config.apiEndpoint}/api/agent?action=chat`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages: [{ role: 'user', content: request.prompt }],
        maxTokens: 4096,
        projectContext: {
          summary: request.metadata?.projectPath as string,
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Cloud API error: ${response.status} - ${errorText}`);
    }

    const data = await response.json();

    return {
      success: data.success ?? true,
      output: data.content,
      error: data.error,
      taskId: data.taskId,
      iterations: data.iterations,
      toolsUsed: data.toolsUsed,
    };
  }

  /**
   * 调用云端工具
   */
  async callCloudTool<T>(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<{ success: boolean; data?: T; error?: string }> {
    const url = `${this.config.apiEndpoint}/api/tools/${toolName}`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(input),
      });

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          error: `Tool API error: ${response.status} - ${errorText}`,
        };
      }

      const data = await response.json();
      return {
        success: true,
        data: data as T,
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 流式执行（支持实时输出）
   */
  async *executeStream(
    request: ExecutorRequest
  ): AsyncGenerator<{ type: 'text' | 'tool' | 'done' | 'error'; content?: string }> {
    const url = `${this.config.apiEndpoint}/api/agent?action=chat`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };

    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: [{ role: 'user', content: request.prompt }],
          maxTokens: 4096,
          stream: true,
        }),
      });

      if (!response.ok) {
        yield { type: 'error', content: `HTTP ${response.status}` };
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) {
        yield { type: 'error', content: 'No response body' };
        return;
      }

      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'text') {
                yield { type: 'text', content: data.content };
              } else if (data.type === 'tool_use') {
                yield { type: 'tool', content: JSON.stringify(data.toolCall) };
              } else if (data.type === 'done') {
                yield { type: 'done' };
              } else if (data.type === 'error') {
                yield { type: 'error', content: data.error };
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      }

      yield { type: 'done' };
    } catch (error) {
      yield {
        type: 'error',
        content: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 提取标题
   */
  private extractTitle(prompt: string): string {
    // 取前 50 个字符作为标题
    const firstLine = prompt.split('\n')[0];
    return firstLine.slice(0, 50) + (firstLine.length > 50 ? '...' : '');
  }

  /**
   * 发送进度事件
   */
  private emitProgress(requestId: string, progress: number, currentStep: string): void {
    const event: ExecutionProgressEvent = {
      requestId,
      progress,
      currentStep,
      location: 'cloud',
      timestamp: Date.now(),
    };
    this.emit('progress', event);
  }

  /**
   * 获取运行中的任务数
   */
  getRunningCount(): number {
    return this.runningTasks.size;
  }

  /**
   * 是否可以接受新任务
   */
  canAcceptTask(): boolean {
    return this.runningTasks.size < this.config.maxConcurrent;
  }

  /**
   * 取消任务
   */
  async cancel(requestId: string): Promise<boolean> {
    const task = this.runningTasks.get(requestId);
    if (!task) {
      return false;
    }

    this.cancelledTasks.add(requestId);

    // 尝试通知云端取消任务
    try {
      await fetch(`${this.config.apiEndpoint}/api/agent`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          ...(this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {}),
        },
        body: JSON.stringify({ taskId: task.id }),
      });
    } catch (error) {
      console.warn('[CloudExecutor] 云端取消请求失败:', error);
    }

    this.runningTasks.delete(requestId);
    this.emit('cancelled', { requestId, taskId: task.id });
    return true;
  }

  /**
   * 检查任务是否已取消
   */
  isCancelled(requestId: string): boolean {
    return this.cancelledTasks.has(requestId);
  }

  /**
   * 清理取消状态
   */
  private cleanupCancelled(requestId: string): void {
    this.cancelledTasks.delete(requestId);
  }

  /**
   * 检查云端是否可用
   */
  async checkHealth(): Promise<boolean> {
    try {
      const response = await fetch(`${this.config.apiEndpoint}/api/health`, {
        method: 'GET',
        headers: this.authToken ? { Authorization: `Bearer ${this.authToken}` } : {},
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let executorInstance: CloudExecutor | null = null;

export function getCloudExecutor(): CloudExecutor {
  if (!executorInstance) {
    executorInstance = new CloudExecutor();
  }
  return executorInstance;
}

export function initCloudExecutor(config: Partial<CloudExecutorConfig>): CloudExecutor {
  executorInstance = new CloudExecutor(config);
  return executorInstance;
}
