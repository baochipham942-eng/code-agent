// ============================================================================
// Log Collector - 统一收集 Code Agent 各模块的日志
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

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
  persistenceEnabled: boolean;
  logFilePath?: string;
}

export interface LogCollectorOptions {
  /** 是否启用文件持久化 */
  enablePersistence?: boolean;
  /** 最大日志文件大小 (MB) */
  maxFileSizeMB?: number;
  /** 保留的旧日志文件数量 */
  maxBackupFiles?: number;
}

// ----------------------------------------------------------------------------
// Log Collector Class
// ----------------------------------------------------------------------------

class LogCollector {
  private browserLogs: LogEntry[] = [];
  private agentLogs: LogEntry[] = [];
  private toolLogs: LogEntry[] = [];
  private maxLogsPerSource: number = 200;

  // 持久化相关
  private persistenceEnabled: boolean = false;
  private logDir: string = '';
  private logFilePath: string = '';
  private writeStream: fs.WriteStream | null = null;
  private maxFileSizeMB: number = 10;
  private maxBackupFiles: number = 5;
  private currentFileSize: number = 0;

  constructor(options?: LogCollectorOptions) {
    console.log('[LogCollector] Initialized');

    if (options?.enablePersistence) {
      this.enablePersistence(options);
    }
  }

  /**
   * 启用日志文件持久化
   */
  private enablePersistence(options: LogCollectorOptions): void {
    try {
      this.maxFileSizeMB = options.maxFileSizeMB ?? 10;
      this.maxBackupFiles = options.maxBackupFiles ?? 5;

      // 获取用户数据目录
      const userDataPath = app.getPath('userData');
      this.logDir = path.join(userDataPath, 'logs');

      // 确保日志目录存在
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }

      // 创建日志文件路径
      const today = new Date().toISOString().split('T')[0];
      this.logFilePath = path.join(this.logDir, `app-${today}.log`);

      // 获取当前文件大小
      if (fs.existsSync(this.logFilePath)) {
        const stats = fs.statSync(this.logFilePath);
        this.currentFileSize = stats.size;
      }

      // 打开写入流
      this.writeStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
      this.persistenceEnabled = true;

      console.log(`[LogCollector] Persistence enabled: ${this.logFilePath}`);

      // 清理旧日志文件
      this.cleanupOldLogFiles();
    } catch (error) {
      console.error('[LogCollector] Failed to enable persistence:', error);
    }
  }

  /**
   * 清理旧日志文件
   */
  private cleanupOldLogFiles(): void {
    try {
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith('app-') && f.endsWith('.log'))
        .sort()
        .reverse();

      // 保留最新的 N 个文件
      const filesToDelete = files.slice(this.maxBackupFiles);
      for (const file of filesToDelete) {
        const filePath = path.join(this.logDir, file);
        fs.unlinkSync(filePath);
        console.log(`[LogCollector] Deleted old log file: ${file}`);
      }
    } catch (error) {
      console.error('[LogCollector] Failed to cleanup old log files:', error);
    }
  }

  /**
   * 检查并轮转日志文件
   */
  private checkAndRotate(): void {
    if (!this.persistenceEnabled) return;

    const maxBytes = this.maxFileSizeMB * 1024 * 1024;
    if (this.currentFileSize < maxBytes) return;

    try {
      // 关闭当前写入流
      if (this.writeStream) {
        this.writeStream.end();
      }

      // 创建新文件名（带时间戳）
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const newPath = path.join(this.logDir, `app-${timestamp}.log`);

      // 重命名当前文件
      fs.renameSync(this.logFilePath, newPath);

      // 创建新的写入流
      this.writeStream = fs.createWriteStream(this.logFilePath, { flags: 'a' });
      this.currentFileSize = 0;

      console.log(`[LogCollector] Log rotated: ${newPath}`);

      // 清理旧文件
      this.cleanupOldLogFiles();
    } catch (error) {
      console.error('[LogCollector] Failed to rotate log file:', error);
    }
  }

  /**
   * 写入日志到文件
   */
  private writeToFile(entry: LogEntry): void {
    if (!this.persistenceEnabled || !this.writeStream) return;

    try {
      const line = JSON.stringify({
        timestamp: entry.timestamp.toISOString(),
        source: entry.source,
        level: entry.level,
        message: entry.message,
        metadata: entry.metadata,
      }) + '\n';

      this.writeStream.write(line);
      this.currentFileSize += Buffer.byteLength(line, 'utf8');

      this.checkAndRotate();
    } catch (error) {
      console.error('[LogCollector] Failed to write to log file:', error);
    }
  }

  /**
   * 关闭日志收集器
   */
  close(): void {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
    this.persistenceEnabled = false;
    console.log('[LogCollector] Closed');
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

    // 写入文件（如果启用了持久化）
    this.writeToFile(entry);

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
      persistenceEnabled: this.persistenceEnabled,
      logFilePath: this.persistenceEnabled ? this.logFilePath : undefined,
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

// 默认启用持久化，保留 5 天日志，每个文件最大 10MB
export const logCollector = new LogCollector({
  enablePersistence: true,
  maxFileSizeMB: 10,
  maxBackupFiles: 5,
});

/**
 * 创建带自定义配置的 LogCollector
 */
export function createLogCollector(options?: LogCollectorOptions): LogCollector {
  return new LogCollector(options);
}
