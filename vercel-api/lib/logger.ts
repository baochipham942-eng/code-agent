/**
 * Vercel API 日志服务
 */

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
    const errorInfo = error instanceof Error
      ? { errorMessage: error.message, stack: error.stack }
      : error ? { errorMessage: String(error) } : {};
    this.log('ERROR', message, { ...meta, ...errorInfo });
  }

  private log(level: string, message: string, meta?: Record<string, unknown>): void {
    const timestamp = new Date().toISOString();
    const ctx = this.context ? `[${this.context}]` : '';

    const output = meta && Object.keys(meta).length > 0
      ? `${timestamp} ${level} ${ctx} ${message} ${JSON.stringify(meta)}`
      : `${timestamp} ${level} ${ctx} ${message}`;

    if (level === 'ERROR') {
      console.error(output);
    } else if (level === 'WARN') {
      console.warn(output);
    } else {
      console.log(output);
    }
  }
}

export function createLogger(context: string): Logger {
  return new Logger(context);
}

export const logger = new Logger();
