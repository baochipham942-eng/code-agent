// ============================================================================
// Log Collector - 统一收集 Code Agent 各模块的日志
// ============================================================================

export type LogLevel = 'INFO' | 'WARN' | 'ERROR' | 'DEBUG';
export type LogSource = 'browser' | 'agent' | 'tool';

export interface LogEntry {
  timestamp: Date;
  source: LogSource;
  level: LogLevel;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface LogStatus {
  browserLogs: number;
  agentLogs: number;
  toolLogs: number;
  totalLogs: number;
  oldestLog?: string;
  newestLog?: string;
}

// ----------------------------------------------------------------------------
// Log Collector Class
// ----------------------------------------------------------------------------

class LogCollector {
  private browserLogs: LogEntry[] = [];
  private agentLogs: LogEntry[] = [];
  private toolLogs: LogEntry[] = [];
  private maxLogsPerSource: number = 200;

  constructor() {
    console.log('[LogCollector] Initialized');
  }

  // --------------------------------------------------------------------------
  // Log Methods
  // --------------------------------------------------------------------------

  /**
   * Add a log entry
   */
  log(source: LogSource, level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date(),
      source,
      level,
      message,
      metadata,
    };

    const logs = this.getLogsArray(source);
    logs.push(entry);

    // Trim if exceeds max
    if (logs.length > this.maxLogsPerSource) {
      logs.splice(0, logs.length - this.maxLogsPerSource);
    }

    // Also console log for debugging
    const timeStr = entry.timestamp.toISOString().split('T')[1].split('.')[0];
    console.log(`[LogCollector][${source}][${level}] ${timeStr} - ${message}`);
  }

  /**
   * Log browser operation
   */
  browser(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    this.log('browser', level, message, metadata);
  }

  /**
   * Log agent activity
   */
  agent(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    this.log('agent', level, message, metadata);
  }

  /**
   * Log tool call
   */
  tool(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    this.log('tool', level, message, metadata);
  }

  // --------------------------------------------------------------------------
  // Retrieval Methods
  // --------------------------------------------------------------------------

  /**
   * Get logs from a specific source
   */
  getLogs(source: LogSource, count?: number): LogEntry[] {
    const logs = this.getLogsArray(source);
    return count ? logs.slice(-count) : [...logs];
  }

  /**
   * Get all logs combined, sorted by timestamp
   */
  getAllLogs(count?: number): LogEntry[] {
    const allLogs = [
      ...this.browserLogs,
      ...this.agentLogs,
      ...this.toolLogs,
    ].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

    return count ? allLogs.slice(-count) : allLogs;
  }

  /**
   * Get logs as formatted string
   */
  getLogsAsString(source: LogSource, count?: number): string {
    const logs = this.getLogs(source, count);
    return this.formatLogs(logs);
  }

  /**
   * Get all logs as formatted string
   */
  getAllLogsAsString(count?: number): string {
    const logs = this.getAllLogs(count);
    return this.formatLogs(logs);
  }

  // --------------------------------------------------------------------------
  // Status & Management
  // --------------------------------------------------------------------------

  /**
   * Get log statistics
   */
  getStatus(): LogStatus {
    const allLogs = this.getAllLogs();
    const status: LogStatus = {
      browserLogs: this.browserLogs.length,
      agentLogs: this.agentLogs.length,
      toolLogs: this.toolLogs.length,
      totalLogs: allLogs.length,
    };

    if (allLogs.length > 0) {
      status.oldestLog = allLogs[0].timestamp.toISOString();
      status.newestLog = allLogs[allLogs.length - 1].timestamp.toISOString();
    }

    return status;
  }

  /**
   * Clear logs from a specific source
   */
  clear(source: LogSource): void {
    switch (source) {
      case 'browser':
        this.browserLogs = [];
        break;
      case 'agent':
        this.agentLogs = [];
        break;
      case 'tool':
        this.toolLogs = [];
        break;
    }
    console.log(`[LogCollector] Cleared ${source} logs`);
  }

  /**
   * Clear all logs
   */
  clearAll(): void {
    this.browserLogs = [];
    this.agentLogs = [];
    this.toolLogs = [];
    console.log('[LogCollector] Cleared all logs');
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private getLogsArray(source: LogSource): LogEntry[] {
    switch (source) {
      case 'browser':
        return this.browserLogs;
      case 'agent':
        return this.agentLogs;
      case 'tool':
        return this.toolLogs;
    }
  }

  private formatLogs(logs: LogEntry[]): string {
    if (logs.length === 0) {
      return 'No logs available.';
    }

    return logs
      .map((log) => {
        const time = log.timestamp.toISOString().split('T')[1].split('.')[0];
        const source = log.source.toUpperCase().padEnd(7);
        const level = log.level.padEnd(5);
        let line = `[${time}] [${source}] [${level}] ${log.message}`;

        if (log.metadata && Object.keys(log.metadata).length > 0) {
          line += ` | ${JSON.stringify(log.metadata)}`;
        }

        return line;
      })
      .join('\n');
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

export const logCollector = new LogCollector();
