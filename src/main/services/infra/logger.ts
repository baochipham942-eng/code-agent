/**
 * 统一日志服务
 * 替代 console.log，提供日志级别、上下文和敏感信息脱敏
 */

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

class Logger {
  private level: LogLevel;
  private context?: string;

  constructor(context?: string) {
    this.context = context;
    this.level =
      process.env.NODE_ENV === 'production' ? LogLevel.INFO : LogLevel.DEBUG;
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
    const timestamp = new Date().toISOString();
    const ctx = this.context ? `[${this.context}]` : '';

    const logFn =
      level === 'ERROR'
        ? console.error
        : level === 'WARN'
          ? console.warn
          : console.log;

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
