// ============================================================================
// Sandbox - Isolated code execution environment using isolated-vm
// Gen 8: Security boundary for dynamically created tools
// ============================================================================

import { createLogger } from '../../services/infra/logger';

// 真正的延迟加载 isolated-vm：只在首次调用 getIvm() 时加载
// 避免模块导入阶段触发原生模块加载（C++ ABI 不匹配会 SIGABRT，try-catch 接不住）
let ivm: typeof import('isolated-vm') | null = null;
let ivmLoaded = false;

function getIvm(): typeof import('isolated-vm') | null {
  if (ivmLoaded) return ivm;
  ivmLoaded = true;
  try {
    ivm = require('isolated-vm');
  } catch (error) {
    // native 模块加载失败（版本不匹配、CLI 模式等）
    // sandbox 功能将不可用，但不影响其他功能
    console.warn('[Sandbox] isolated-vm not available:', (error as Error).message?.split('\n')[0]);
  }
  return ivm;
}

const logger = createLogger('Sandbox');

export interface SandboxOptions {
  /** Memory limit in MB (default: 32) */
  memoryLimit?: number;
  /** Execution timeout in ms (default: 5000) */
  timeout?: number;
  /** Allowed global functions to expose */
  allowedGlobals?: Record<string, (...args: unknown[]) => unknown>;
}

export interface SandboxResult {
  success: boolean;
  output?: unknown;
  error?: string;
  executionTime?: number;
}

/**
 * CodeSandbox provides isolated JavaScript execution environment
 *
 * Security features:
 * - No access to require, import, process, fs, child_process
 * - Memory limit (default 32MB)
 * - Execution timeout (default 5 seconds)
 * - Isolated V8 context
 *
 * Note: This sandbox is specifically designed for Gen8 tool_create feature
 * which allows AI to dynamically create tools at runtime. The isolated-vm
 * library provides true V8 isolate-level sandboxing, not just eval().
 *
 * CLI Mode: When running in CLI mode without isolated-vm, sandbox features
 * are disabled and execute() will return an error.
 */
export class CodeSandbox {
  private isolate: import('isolated-vm').Isolate | null = null;
  private context: import('isolated-vm').Context | null = null;
  private options: Required<SandboxOptions>;
  private readonly sandboxAvailable: boolean;

  constructor(options: SandboxOptions = {}) {
    this.options = {
      memoryLimit: options.memoryLimit ?? 32,
      timeout: options.timeout ?? 5000,
      allowedGlobals: options.allowedGlobals ?? {},
    };
    this.sandboxAvailable = getIvm() !== null;
  }

  /**
   * Initialize the sandbox environment
   */
  async initialize(): Promise<void> {
    const ivmModule = getIvm();
    if (!this.sandboxAvailable || !ivmModule) {
      logger.warn('Sandbox not available (CLI mode or isolated-vm missing)');
      return;
    }

    if (this.isolate) {
      return; // Already initialized
    }

    this.isolate = new ivmModule.Isolate({ memoryLimit: this.options.memoryLimit });
    this.context = await this.isolate.createContext();

    // Set up allowed globals
    const jail = this.context.global;

    // Expose safe console methods
    await jail.set('console', new ivmModule.ExternalCopy({
      log: (...args: unknown[]) => logger.info('sandbox output', { args }),
      warn: (...args: unknown[]) => logger.warn('sandbox warning', { args }),
      error: (...args: unknown[]) => logger.error('sandbox error', new Error(String(args[0])), { args: args.slice(1) }),
    }).copyInto());

    // Expose JSON (safe)
    await jail.set('JSON', new ivmModule.ExternalCopy({
      parse: JSON.parse,
      stringify: JSON.stringify,
    }).copyInto());

    // Expose allowed custom globals
    for (const [name, fn] of Object.entries(this.options.allowedGlobals)) {
      await jail.set(name, new ivmModule.Callback(fn));
    }
  }

  /**
   * Execute code in the sandbox using isolated-vm's context.eval
   * This is NOT the dangerous global eval() - it runs in a completely
   * isolated V8 context with no access to Node.js APIs
   */
  async execute(code: string): Promise<SandboxResult> {
    // CLI 模式下沙箱不可用
    if (!this.sandboxAvailable) {
      return {
        success: false,
        error: 'Sandbox not available in CLI mode (isolated-vm not loaded)',
      };
    }

    if (!this.isolate || !this.context) {
      await this.initialize();
    }

    if (!this.context) {
      return {
        success: false,
        error: 'Failed to initialize sandbox context',
      };
    }

    const startTime = Date.now();

    try {
      // Validate code for obvious dangerous patterns
      const validation = this.validateCode(code);
      if (!validation.valid) {
        return {
          success: false,
          error: validation.error,
        };
      }

      // Execute in isolated V8 context with timeout
      // context.eval is isolated-vm's method, not global eval()
      const result = await this.context.eval(code, {
        timeout: this.options.timeout,
      });

      return {
        success: true,
        output: result,
        executionTime: Date.now() - startTime,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);

      // Check if isolate was disposed due to memory limit
      if (errorMessage.includes('disposed') || errorMessage.includes('memory')) {
        // Recreate isolate for next execution
        this.dispose();
        return {
          success: false,
          error: '内存超限，沙箱已重置',
          executionTime: Date.now() - startTime,
        };
      }

      return {
        success: false,
        error: errorMessage,
        executionTime: Date.now() - startTime,
      };
    }
  }

  /**
   * Execute code and return a specific type
   */
  async executeWithResult<T>(code: string): Promise<T | null> {
    const result = await this.execute(code);
    if (result.success) {
      return result.output as T;
    }
    return null;
  }

  /**
   * Validate code for dangerous patterns before execution
   * Additional defense layer on top of isolated-vm sandboxing
   */
  private validateCode(code: string): { valid: boolean; error?: string } {
    // Patterns that should never appear in sandboxed code
    const dangerousPatterns = [
      { pattern: /\brequire\s*\(/i, message: '禁止使用 require' },
      { pattern: /\bimport\s*\(/i, message: '禁止使用动态 import' },
      { pattern: /\bimport\s+/i, message: '禁止使用 import 语句' },
      { pattern: /\bprocess\b/i, message: '禁止访问 process' },
      { pattern: /\bglobal\b/i, message: '禁止访问 global' },
      { pattern: /\bglobalThis\b/i, message: '禁止访问 globalThis' },
      { pattern: /\b__dirname\b/i, message: '禁止访问 __dirname' },
      { pattern: /\b__filename\b/i, message: '禁止访问 __filename' },
      { pattern: /\.constructor\b/i, message: '禁止访问 constructor' },
      { pattern: /\bprototype\b/i, message: '禁止访问 prototype' },
      { pattern: /\b__proto__\b/i, message: '禁止访问 __proto__' },
    ];

    for (const { pattern, message } of dangerousPatterns) {
      if (pattern.test(code)) {
        return { valid: false, error: message };
      }
    }

    return { valid: true };
  }

  /**
   * Get memory usage stats
   */
  getMemoryUsage(): { used: number; limit: number } | null {
    if (!this.isolate) {
      return null;
    }

    try {
      const stats = this.isolate.getHeapStatisticsSync();
      return {
        used: Math.round(stats.used_heap_size / 1024 / 1024),
        limit: this.options.memoryLimit,
      };
    } catch {
      return null;
    }
  }

  /**
   * Dispose the sandbox and free resources
   */
  dispose(): void {
    if (this.context) {
      this.context.release();
      this.context = null;
    }
    if (this.isolate) {
      this.isolate.dispose();
      this.isolate = null;
    }
  }
}

// Singleton instance for tool_create
let defaultSandbox: CodeSandbox | null = null;

/**
 * Get or create the default sandbox instance
 */
export function getDefaultSandbox(): CodeSandbox {
  if (!defaultSandbox) {
    defaultSandbox = new CodeSandbox({
      memoryLimit: 32,
      timeout: 5000,
    });
  }
  return defaultSandbox;
}

/**
 * Execute code safely in an isolated environment
 * Convenience function for one-off executions
 */
export async function executeSandboxed(
  code: string,
  options?: SandboxOptions
): Promise<SandboxResult> {
  const sandbox = options ? new CodeSandbox(options) : getDefaultSandbox();

  try {
    return await sandbox.execute(code);
  } finally {
    // Only dispose if we created a new sandbox
    if (options) {
      sandbox.dispose();
    }
  }
}
