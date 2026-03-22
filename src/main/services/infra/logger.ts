/**
 * 统一日志服务
 * 替代 console.log，提供日志级别、上下文和敏感信息脱敏
 * 支持文件持久化（JSON 结构化日志，每日轮转，保留 7 天）
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const SENSITIVE_KEYS = [
  'apikey',
  'api_key',
  'password',
  'token',
  'secret',
  'authorization',
  'credential',
  'private',
];

// ----------------------------------------------------------------------------
// File Sink - 日志文件持久化
// ----------------------------------------------------------------------------

/** 获取日志目录 */
function getLogDir(): string {
  const { getUserDataPath } = require('../../platform/appPaths');
  return path.join(getUserDataPath(), 'logs');
}

function getDateString(date: Date = new Date()): string {
  return date.toISOString().split('T')[0]; // YYYY-MM-DD
}

let fileSinkInitialized = false;
let fileSinkEnabled = true;
let logDir = '';
let logStream: fs.WriteStream | null = null;
let logStreamDate = '';

/** 初始化日志目录并清理旧文件（best-effort） */
function initFileSink(): void {
  if (fileSinkInitialized) return;
  fileSinkInitialized = true;

  try {
    logDir = getLogDir();
    fs.mkdirSync(logDir, { recursive: true });
    cleanOldLogs();
  } catch {
    fileSinkEnabled = false;
  }
}

/** 删除超过 7 天的日志文件 */
function cleanOldLogs(): void {
  try {
    const files = fs.readdirSync(logDir);
    const now = Date.now();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

    for (const file of files) {
      if (!file.startsWith('code-agent-') || !file.endsWith('.log')) continue;
      const filePath = path.join(logDir, file);
      try {
        const stat = fs.statSync(filePath);
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(filePath);
        }
      } catch {
        // Skip files we can't stat/delete
      }
    }
  } catch {
    // Non-critical, ignore
  }
}

/** Get or create a write stream for today's log file (lazy, per-day rotation) */
function getLogStream(): fs.WriteStream | null {
  const today = getDateString();
  if (logStream && logStreamDate === today) return logStream;

  // Day changed or first call — close old stream and open new one
  if (logStream) {
    try { logStream.end(); } catch { /* best-effort */ }
    logStream = null;
  }

  try {
    const filePath = path.join(logDir, `code-agent-${today}.log`);
    logStream = fs.createWriteStream(filePath, { flags: 'a' });
    logStream.on('error', () => {
      // Silently ignore write errors — best-effort logging
      logStream = null;
    });
    logStreamDate = today;
    return logStream;
  } catch {
    return null;
  }
}

/** 写一行 JSON 日志到文件（non-blocking buffered write） */
function writeToFile(
  level: string,
  context: string | undefined,
  message: string,
  data: unknown[] | undefined,
): void {
  if (!fileSinkEnabled) return;

  try {
    initFileSink();
    if (!fileSinkEnabled) return;

    const logLine = JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      context: context || undefined,
      message,
      data: data && data.length > 0 ? data : undefined,
    });

    const stream = getLogStream();
    if (stream) {
      stream.write(logLine + '\n');
    }
  } catch {
    // File write failed — continue with console only
    // Don't disable permanently; transient errors (e.g. disk full) may resolve
  }
}

// ----------------------------------------------------------------------------
// Logger Class
// ----------------------------------------------------------------------------

class Logger {
  private level: LogLevel;
  private context?: string;

  constructor(context?: string) {
    this.context = context;
    // CLI 模式下默认只输出 ERROR，避免日志噪音污染交互界面
    // --debug 时恢复 DEBUG 级别
    if (process.env.CODE_AGENT_CLI_MODE === 'true') {
      const isDebug = process.env.DEBUG === 'true' || process.argv.includes('--debug');
      this.level = isDebug ? LogLevel.DEBUG : LogLevel.ERROR;
    } else {
      this.level =
        process.env.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.DEBUG;
    }
  }

  setLevel(level: LogLevel): void {
    this.level = level;
  }

  debug(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.DEBUG) {
      this.log('DEBUG', message, args);
    }
  }

  info(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.INFO) {
      this.log('INFO', message, args);
    }
  }

  warn(message: string, ...args: unknown[]): void {
    if (this.level <= LogLevel.WARN) {
      this.log('WARN', message, args);
    }
  }

  error(message: string, ...args: unknown[]): void {
    // 检查第一个参数是否是 Error 对象
    const firstArg = args[0];
    if (firstArg instanceof Error) {
      const errorInfo = { errorMessage: firstArg.message, stack: firstArg.stack };
      this.log('ERROR', message, [errorInfo, ...args.slice(1)]);
    } else {
      this.log('ERROR', message, args);
    }
  }

  private log(level: string, message: string, args: unknown[]): void {
    // CLI 模式下只输出 ERROR（运行时检查，防止 ESM import hoisting 导致构造时 env 未设置）
    if (process.env.CODE_AGENT_CLI_MODE === 'true' && level !== 'ERROR'
        && process.env.DEBUG !== 'true' && !process.argv.includes('--debug')) {
      // 仍然写文件，但不输出到 stderr
      if (level !== 'DEBUG') {
        writeToFile(level, this.context, message, args.length > 0 ? args : undefined);
      }
      return;
    }

    const timestamp = new Date().toISOString();
    const ctx = this.context ? `[${this.context}]` : '';

    const logFn = console.error; // All log levels → stderr

    // 处理参数，对对象类型进行脱敏
    const sanitizedArgs = args.map((arg) => {
      if (arg && typeof arg === 'object' && !Array.isArray(arg)) {
        return this.sanitize(arg as Record<string, unknown>);
      }
      return arg;
    });

    if (sanitizedArgs.length > 0) {
      logFn(`${timestamp} ${level} ${ctx} ${message}`, ...sanitizedArgs);
    } else {
      logFn(`${timestamp} ${level} ${ctx} ${message}`);
    }

    // Write to file for INFO and above (skip DEBUG in file)
    if (level !== 'DEBUG') {
      writeToFile(level, this.context, message, sanitizedArgs.length > 0 ? sanitizedArgs : undefined);
    }
  }

  private sanitize(
    obj?: Record<string, unknown>
  ): Record<string, unknown> | undefined {
    if (!obj) return undefined;

    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();
      const isSensitive = SENSITIVE_KEYS.some((sk) => lowerKey.includes(sk));

      if (isSensitive) {
        result[key] = '***REDACTED***';
      } else if (typeof value === 'object' && value !== null) {
        result[key] = this.sanitize(value as Record<string, unknown>);
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  async dispose(): Promise<void> {
    if (logStream) {
      try { logStream.end(); } catch { /* best-effort */ }
      logStream = null;
    }
  }
}

/**
 * 创建带上下文的 Logger 实例
 * @param context 日志上下文（通常是类名或模块名）
 */
export function createLogger(context: string): Logger {
  return new Logger(context);
}

/**
 * 默认 Logger 实例（无上下文）
 */
export const logger = new Logger();

// Lazy registration to avoid circular dependency (ServiceRegistry imports logger)
let loggerRegistered = false;
export function ensureLoggerRegistered(): void {
  if (loggerRegistered) return;
  loggerRegistered = true;
  // Dynamic import to break circular dependency
  const { getServiceRegistry } = require('../serviceRegistry');
  getServiceRegistry().register('Logger', logger);
}
