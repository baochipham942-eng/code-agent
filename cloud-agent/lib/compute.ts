// ============================================================================
// Compute Task Executor - 执行云端计算任务
// ============================================================================

import { VM } from 'vm2';

interface CloudTaskRequest {
  id: string;
  type: string;
  payload: {
    script?: string;
    [key: string]: unknown;
  };
}

interface CloudTaskResponse {
  id: string;
  status: 'success' | 'error';
  result?: unknown;
  error?: string;
}

// 安全执行用户脚本
export async function executeComputeTask(
  request: CloudTaskRequest
): Promise<CloudTaskResponse> {
  const { id, payload } = request;
  const { script } = payload;

  if (!script) {
    return {
      id,
      status: 'error',
      error: 'Missing script in payload',
    };
  }

  try {
    // 使用 VM2 创建沙箱环境
    const vm = new VM({
      timeout: 10000, // 10 秒超时
      sandbox: {
        console: {
          log: (...args: any[]) => console.log('[VM]', ...args),
          error: (...args: any[]) => console.error('[VM]', ...args),
        },
        // 提供一些安全的工具函数
        JSON,
        Math,
        Date,
        Array,
        Object,
        String,
        Number,
        Boolean,
        RegExp,
        Map,
        Set,
        Promise,
        // 网络请求封装
        fetch: async (url: string, options?: RequestInit) => {
          // 限制只能访问特定域名
          const allowedDomains = [
            'api.github.com',
            'api.openai.com',
            'api.anthropic.com',
            'api.deepseek.com',
          ];

          const urlObj = new URL(url);
          if (!allowedDomains.some((d) => urlObj.hostname.includes(d))) {
            throw new Error(`Domain not allowed: ${urlObj.hostname}`);
          }

          const response = await fetch(url, {
            ...options,
            signal: AbortSignal.timeout(5000),
          });
          return {
            ok: response.ok,
            status: response.status,
            json: () => response.json(),
            text: () => response.text(),
          };
        },
      },
    });

    // 执行脚本
    const result = vm.run(script);

    // 处理 Promise 结果
    const finalResult = result instanceof Promise ? await result : result;

    return {
      id,
      status: 'success',
      result: finalResult,
    };
  } catch (error: any) {
    console.error('Compute task error:', error);
    return {
      id,
      status: 'error',
      error: error.message || 'Script execution failed',
    };
  }
}
