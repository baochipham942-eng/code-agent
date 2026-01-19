/**
 * Renderer 进程日志服务
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

class Logger {
  private context?: string;

  constructor(context?: string) {
    this.context = context;
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('DEBUG', message, meta);
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('INFO', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('WARN', message, meta);
  }

  error(message: string, error?: Error | unknown, meta?: Record<string, unknown>): void {
    const errorInfo =
      error instanceof Error
        ? { errorMessage: error.message, stack: error.stack }
        : error
          ? { errorMessage: String(error) }
          : {};
    this.log('ERROR', message, { ...meta, ...errorInfo });
  }

  private log(level: string, message: string, meta?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const ctx = this.context ? `[${this.context}]` : '';

    const logFn =
      level === 'ERROR' ? console.error : level === 'WARN' ? console.warn : console.log;

    if (meta && Object.keys(meta).length > 0) {
      logFn(`${timestamp} ${level} ${ctx} ${message}`, meta);
    } else {
      logFn(`${timestamp} ${level} ${ctx} ${message}`);
    }
  }
}

export function createLogger(context: string): Logger {
  return new Logger(context);
}

export const logger = new Logger();
