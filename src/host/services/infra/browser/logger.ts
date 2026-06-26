import { logCollector } from '../../../mcp/logCollector.js';
import { createLogger } from '../logger';

const serviceLogger = createLogger('BrowserService');

export class BrowserLogger {
  private logs: string[] = [];
  private maxLogs: number = 100;

  log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', message: string): void {
    const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
    const entry = `[${timestamp}] [${level}] ${message}`;
    this.logs.push(entry);
    serviceLogger.debug(entry);

    logCollector.browser(level, message);

    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-this.maxLogs);
    }
  }

  getLogs(count?: number): string[] {
    return count ? this.logs.slice(-count) : [...this.logs];
  }

  getLogsAsString(count?: number): string {
    return this.getLogs(count).join('\n');
  }

  clear(): void {
    this.logs = [];
  }
}
