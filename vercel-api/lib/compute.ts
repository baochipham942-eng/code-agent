// ============================================================================
// Compute Task Executor - 执行云端计算任务
// ============================================================================
//
// 安全实现说明：
// - 使用受限的 Function 构造函数执行用户脚本
// - 严格限制可用的全局对象
// - 超时控制防止资源滥用
// - fetch 请求限制在白名单域名
//
// ============================================================================

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

// 允许的 fetch 域名白名单
const ALLOWED_DOMAINS = [
  'api.github.com',
  'api.openai.com',
  'api.anthropic.com',
  'api.deepseek.com',
];

// 安全的 fetch 封装
async function safeFetch(url: string, options?: RequestInit): Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
}> {
  const urlObj = new URL(url);

  if (!ALLOWED_DOMAINS.some((d) => urlObj.hostname === d || urlObj.hostname.endsWith('.' + d))) {
    throw new Error(`Domain not allowed: ${urlObj.hostname}. Allowed: ${ALLOWED_DOMAINS.join(', ')}`);
  }

  // 阻止内部 IP 访问
  const hostname = urlObj.hostname;
  const blockedPatterns = [
    /^localhost$/i,
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^0\./,
    /^\[?::1\]?$/,
  ];

  if (blockedPatterns.some(pattern => pattern.test(hostname))) {
    throw new Error(`Internal IP access not allowed: ${hostname}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...options?.headers,
        'User-Agent': 'CodeAgent-Cloud/1.0',
      },
    });

    return {
      ok: response.ok,
      status: response.status,
      json: () => response.json(),
      text: () => response.text(),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

// 创建安全的沙箱环境
function createSandbox(): Record<string, unknown> {
  return {
    // 基础类型 - 只读访问
    JSON: Object.freeze({
      parse: JSON.parse,
      stringify: JSON.stringify,
    }),
    Math: Object.freeze({ ...Math }),
    Date: Date,
    Array: Array,
    Object: Object,
    String: String,
    Number: Number,
    Boolean: Boolean,
    RegExp: RegExp,
    Map: Map,
    Set: Set,
    Promise: Promise,

    // 安全的控制台
    console: Object.freeze({
      log: (...args: unknown[]) => console.log('[Sandbox]', ...args),
      error: (...args: unknown[]) => console.error('[Sandbox]', ...args),
      warn: (...args: unknown[]) => console.warn('[Sandbox]', ...args),
    }),

    // 受限的 fetch
    fetch: safeFetch,

    // 工具函数
    setTimeout: undefined,
    setInterval: undefined,
    setImmediate: undefined,
    clearTimeout: undefined,
    clearInterval: undefined,
    process: undefined,
    require: undefined,
    module: undefined,
    exports: undefined,
    __dirname: undefined,
    __filename: undefined,
    global: undefined,
    globalThis: undefined,
    eval: undefined,
    Function: undefined,
  };
}

// 脚本危险模式检测（只检测真正危险的沙箱逃逸模式）
function containsDangerousPatterns(script: string): string | null {
  const dangerousPatterns = [
    // 沙箱逃逸尝试
    { pattern: /\b__proto__\b/gi, reason: '__proto__ access is not allowed' },
    { pattern: /\bconstructor\s*\[/gi, reason: 'constructor access via bracket notation is not allowed' },
    { pattern: /\bconstructor\s*\.\s*constructor/gi, reason: 'constructor chain access is not allowed' },
    // 动态代码执行
    { pattern: /\beval\s*\(/gi, reason: 'eval() is not allowed' },
    { pattern: /\bnew\s+Function\s*\(/gi, reason: 'new Function() is not allowed' },
    // Node.js 特有的危险 API
    { pattern: /\bchild_process\b/gi, reason: 'child_process is not allowed' },
    { pattern: /\brequire\s*\(\s*['"]child_process['"]\s*\)/gi, reason: 'child_process import is not allowed' },
  ];

  for (const { pattern, reason } of dangerousPatterns) {
    if (pattern.test(script)) {
      return reason;
    }
  }

  return null;
}

// 执行脚本并设置超时
async function executeWithTimeout(
  fn: () => unknown,
  timeoutMs: number
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error(`Script execution timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    try {
      const result = fn();
      if (result instanceof Promise) {
        result
          .then((r) => {
            clearTimeout(timeoutId);
            resolve(r);
          })
          .catch((e) => {
            clearTimeout(timeoutId);
            reject(e);
          });
      } else {
        clearTimeout(timeoutId);
        resolve(result);
      }
    } catch (error) {
      clearTimeout(timeoutId);
      reject(error);
    }
  });
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

  // 脚本长度限制
  if (script.length > 50000) {
    return {
      id,
      status: 'error',
      error: 'Script too long. Maximum 50000 characters allowed.',
    };
  }

  // 检测危险模式
  const dangerousReason = containsDangerousPatterns(script);
  if (dangerousReason) {
    return {
      id,
      status: 'error',
      error: `Script contains forbidden pattern: ${dangerousReason}`,
    };
  }

  try {
    const sandbox = createSandbox();

    // 将沙箱对象作为参数传入，避免直接访问外部作用域
    const sandboxKeys = Object.keys(sandbox);
    const sandboxValues = sandboxKeys.map(key => sandbox[key]);

    // 构建一个严格模式的函数
    const wrappedScript = `
      "use strict";
      return (async () => {
        ${script}
      })();
    `;

    // 使用 Function 构造函数创建受限执行环境
    // 安全措施：
    // 1. 危险模式预检测
    // 2. 沙箱环境隔离
    // 3. 超时控制
    // 4. fetch 域名白名单
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(...sandboxKeys, wrappedScript);

    const result = await executeWithTimeout(
      () => fn(...sandboxValues),
      10000 // 10 秒超时
    );

    return {
      id,
      status: 'success',
      result,
    };
  } catch (error: unknown) {
    console.error('Compute task error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Script execution failed';
    return {
      id,
      status: 'error',
      error: errorMessage,
    };
  }
}
