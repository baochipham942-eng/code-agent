// ============================================================================
// Cloud Agent Client - 与 Vercel 部署的云端 Agent 通信
// ============================================================================

import type {
  CloudAgentConfig,
  CloudAgentStatus,
  CloudTaskRequest,
  CloudTaskResponse,
} from '../../shared/types';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

interface CloudHealthResponse {
  status: 'ok' | 'error';
  version?: string;
  uptime?: number;
}

type StatusChangeCallback = (status: CloudAgentStatus) => void;
type TaskProgressCallback = (progress: { taskId: string; step: string; data?: unknown }) => void;

// ----------------------------------------------------------------------------
// Cloud Agent Client
// ----------------------------------------------------------------------------

export class CloudAgentClient {
  private config: CloudAgentConfig;
  private status: CloudAgentStatus = 'idle';
  private statusCallbacks: StatusChangeCallback[] = [];
  private lastWarmupTime: number = 0;
  private warmupInterval: number = 5 * 60 * 1000; // 5 分钟保活

  constructor(config: CloudAgentConfig) {
    this.config = {
      timeout: 30000,
      warmupOnInit: true,
      ...config,
    };

    if (this.config.warmupOnInit) {
      this.warmup();
    }
  }

  // --------------------------------------------------------------------------
  // Status Management
  // --------------------------------------------------------------------------

  getStatus(): CloudAgentStatus {
    return this.status;
  }

  onStatusChange(callback: StatusChangeCallback): () => void {
    this.statusCallbacks.push(callback);
    return () => {
      const index = this.statusCallbacks.indexOf(callback);
      if (index > -1) {
        this.statusCallbacks.splice(index, 1);
      }
    };
  }

  private setStatus(status: CloudAgentStatus): void {
    if (this.status !== status) {
      this.status = status;
      this.statusCallbacks.forEach((cb) => cb(status));
    }
  }

  // --------------------------------------------------------------------------
  // Warmup / Health Check
  // --------------------------------------------------------------------------

  /**
   * 唤醒云端 Agent（触发冷启动）
   * Vercel Serverless 有冷启动延迟，提前 warmup 可以减少响应时间
   */
  async warmup(): Promise<boolean> {
    // 避免频繁 warmup
    const now = Date.now();
    if (now - this.lastWarmupTime < this.warmupInterval) {
      return this.status === 'ready';
    }

    this.setStatus('warming_up');

    try {
      const response = await fetch(`${this.config.endpoint}/api/health`, {
        method: 'GET',
        headers: this.getHeaders(),
        signal: AbortSignal.timeout(10000), // 10s timeout for warmup
      });

      if (response.ok) {
        const data: CloudHealthResponse = await response.json();
        if (data.status === 'ok') {
          this.setStatus('ready');
          this.lastWarmupTime = now;
          return true;
        }
      }

      this.setStatus('error');
      return false;
    } catch (error) {
      console.error('Cloud agent warmup failed:', error);
      this.setStatus('error');
      return false;
    }
  }

  /**
   * 检查云端是否就绪
   */
  async isReady(): Promise<boolean> {
    if (this.status === 'ready') {
      return true;
    }
    return this.warmup();
  }

  // --------------------------------------------------------------------------
  // Task Execution
  // --------------------------------------------------------------------------

  /**
   * 执行云端任务
   */
  async execute(
    request: CloudTaskRequest,
    onProgress?: TaskProgressCallback
  ): Promise<CloudTaskResponse> {
    // 确保云端就绪
    const ready = await this.isReady();
    if (!ready) {
      return {
        id: request.id,
        status: 'error',
        error: 'Cloud agent is not ready',
      };
    }

    this.setStatus('executing');

    try {
      const response = await fetch(`${this.config.endpoint}/api/task`, {
        method: 'POST',
        headers: this.getHeaders(),
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(request.timeout || this.config.timeout || 30000),
      });

      if (!response.ok) {
        const error = await response.text();
        this.setStatus('ready');
        return {
          id: request.id,
          status: 'error',
          error: `Cloud API error: ${response.status} - ${error}`,
        };
      }

      // 处理 SSE 流式响应（用于进度回调）
      if (response.headers.get('content-type')?.includes('text/event-stream')) {
        return this.handleStreamResponse(request.id, response, onProgress);
      }

      // 普通 JSON 响应
      const result = await response.json();
      this.setStatus('ready');
      return result;
    } catch (error: any) {
      console.error('Cloud task execution failed:', error);
      this.setStatus('error');

      if (error.name === 'TimeoutError' || error.name === 'AbortError') {
        return {
          id: request.id,
          status: 'timeout',
          error: 'Task execution timed out',
        };
      }

      return {
        id: request.id,
        status: 'error',
        error: error.message || 'Unknown error',
      };
    }
  }

  /**
   * 执行浏览器自动化任务
   */
  async browserTask(
    action: string,
    params: Record<string, unknown> = {}
  ): Promise<CloudTaskResponse> {
    const request: CloudTaskRequest = {
      id: `browser-${Date.now()}`,
      type: 'browser',
      payload: {
        action,
        ...params,
      },
    };
    return this.execute(request);
  }

  /**
   * 执行云端技能
   */
  async executeSkill(
    skillName: string,
    params: Record<string, unknown> = {}
  ): Promise<CloudTaskResponse> {
    const request: CloudTaskRequest = {
      id: `skill-${Date.now()}`,
      type: 'skill',
      payload: {
        skillName,
        params,
      },
    };
    return this.execute(request);
  }

  /**
   * 执行云端计算任务
   */
  async compute(script: string, timeout?: number): Promise<CloudTaskResponse> {
    const request: CloudTaskRequest = {
      id: `compute-${Date.now()}`,
      type: 'compute',
      payload: { script },
      timeout,
    };
    return this.execute(request);
  }

  // --------------------------------------------------------------------------
  // Browser Automation Shortcuts
  // --------------------------------------------------------------------------

  /**
   * 截取网页截图
   */
  async screenshot(url: string): Promise<CloudTaskResponse> {
    return this.browserTask('screenshot', { url });
  }

  /**
   * 获取网页内容
   */
  async scrape(url: string, selector?: string): Promise<CloudTaskResponse> {
    return this.browserTask('scrape', { url, selector });
  }

  /**
   * 填写表单
   */
  async fillForm(
    url: string,
    fields: Array<{ selector: string; value: string }>
  ): Promise<CloudTaskResponse> {
    return this.browserTask('fillForm', { url, fields });
  }

  /**
   * 点击元素
   */
  async click(url: string, selector: string): Promise<CloudTaskResponse> {
    return this.browserTask('click', { url, selector });
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private getHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    return headers;
  }

  private async handleStreamResponse(
    taskId: string,
    response: Response,
    onProgress?: TaskProgressCallback
  ): Promise<CloudTaskResponse> {
    const reader = response.body?.getReader();
    if (!reader) {
      return {
        id: taskId,
        status: 'error',
        error: 'No response body',
      };
    }

    const decoder = new TextDecoder();
    let result: CloudTaskResponse | null = null;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        const lines = chunk.split('\n').filter((line) => line.startsWith('data:'));

        for (const line of lines) {
          const data = line.replace('data:', '').trim();
          if (!data || data === '[DONE]') continue;

          try {
            const parsed = JSON.parse(data);

            // 进度事件
            if (parsed.type === 'progress' && onProgress) {
              onProgress({
                taskId,
                step: parsed.step,
                data: parsed.data,
              });
            }

            // 最终结果
            if (parsed.type === 'result') {
              result = parsed.data;
            }
          } catch {
            // Ignore parse errors
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    this.setStatus('ready');

    return (
      result || {
        id: taskId,
        status: 'error',
        error: 'No result received',
      }
    );
  }
}

// ----------------------------------------------------------------------------
// Factory
// ----------------------------------------------------------------------------

let cloudAgentInstance: CloudAgentClient | null = null;

export function getCloudAgent(config?: CloudAgentConfig): CloudAgentClient {
  if (!cloudAgentInstance && config) {
    cloudAgentInstance = new CloudAgentClient(config);
  }

  if (!cloudAgentInstance) {
    throw new Error('Cloud agent not initialized. Call with config first.');
  }

  return cloudAgentInstance;
}

export function initCloudAgent(config: CloudAgentConfig): CloudAgentClient {
  cloudAgentInstance = new CloudAgentClient(config);
  return cloudAgentInstance;
}
