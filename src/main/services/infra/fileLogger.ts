// ============================================================================
// File Logger - Log file rotation and management
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

// ============================================================================
// Constants
// ============================================================================

/** 日志文件配置 */
export const LOG_CONFIG = {
  /** 单个日志文件最大大小（10MB） */
  MAX_FILE_SIZE: 10 * 1024 * 1024,
  /** 保留的日志文件数量 */
  MAX_FILES: 10,
  /** 日志目录名 */
  DIR_NAME: 'logs',
  /** 日志文件名前缀 */
  FILE_PREFIX: 'code-agent',
} as const;

// ============================================================================
// Types
// ============================================================================

export interface FileLoggerConfig {
  /** 最大文件大小（字节） */
  maxFileSize?: number;
  /** 最大文件数量 */
  maxFiles?: number;
  /** 日志目录 */
  logDir?: string;
}

// ============================================================================
// FileLogger Class
// ============================================================================

/**
 * 文件日志记录器
 *
 * 特性：
 * - 按大小轮转（单文件 10MB）
 * - 保留最近 N 个文件
 * - 按天创建新文件
 * - 异步写入，不阻塞主进程
 *
 * @example
 * ```typescript
 * const logger = new FileLogger();
 * await logger.write('Application started');
 * // ...
 * logger.close();
 * ```
 */
export class FileLogger {
  private config: Required<FileLoggerConfig>;
  private currentDate: string;
  private writeStream: fs.WriteStream | null = null;
  private currentFileSize = 0;
  private logDir: string;
  private isClosing = false;
  private writeQueue: string[] = [];
  private isWriting = false;

  constructor(config?: FileLoggerConfig) {
    this.config = {
      maxFileSize: config?.maxFileSize ?? LOG_CONFIG.MAX_FILE_SIZE,
      maxFiles: config?.maxFiles ?? LOG_CONFIG.MAX_FILES,
      logDir: config?.logDir ?? this.getDefaultLogDir(),
    };
    this.logDir = this.config.logDir;
    this.currentDate = this.getDateString();
    this.ensureLogDir();
  }

  /**
   * 获取默认日志目录
   */
  private getDefaultLogDir(): string {
    try {
      return path.join(app.getPath('userData'), LOG_CONFIG.DIR_NAME);
    } catch {
      // Fallback for non-Electron environments
      return path.join(process.env.HOME || '/tmp', '.code-agent', LOG_CONFIG.DIR_NAME);
    }
  }

  /**
   * 确保日志目录存在
   */
  private ensureLogDir(): void {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  /**
   * 获取当前日期字符串
   */
  private getDateString(): string {
    return new Date().toISOString().split('T')[0];
  }

  /**
   * 获取当前日志文件路径
   */
  private getCurrentLogPath(): string {
    return path.join(this.logDir, `${LOG_CONFIG.FILE_PREFIX}-${this.currentDate}.log`);
  }

  /**
   * 获取轮转后的日志文件路径
   */
  private getRotatedLogPath(index: number): string {
    return path.join(this.logDir, `${LOG_CONFIG.FILE_PREFIX}-${this.currentDate}.${index}.log`);
  }

  /**
   * 获取或创建写入流
   */
  private getWriteStream(): fs.WriteStream | null {
    if (this.isClosing) {
      return null;
    }

    const today = this.getDateString();

    // 日期变化，关闭旧流并创建新流
    if (today !== this.currentDate) {
      this.closeStream();
      this.currentDate = today;
      this.currentFileSize = 0;
    }

    // 文件大小超限，执行轮转
    if (this.currentFileSize >= this.config.maxFileSize) {
      this.rotate();
    }

    if (!this.writeStream) {
      const logPath = this.getCurrentLogPath();

      // 检查现有文件大小
      try {
        const stats = fs.statSync(logPath);
        this.currentFileSize = stats.size;

        // 如果现有文件已超限，先轮转
        if (this.currentFileSize >= this.config.maxFileSize) {
          this.rotate();
        }
      } catch {
        this.currentFileSize = 0;
      }

      this.writeStream = fs.createWriteStream(logPath, { flags: 'a' });
      this.writeStream.on('error', (error) => {
        console.error('[FileLogger] Write stream error:', error);
        this.writeStream = null;
      });
    }

    return this.writeStream;
  }

  /**
   * 执行日志轮转
   */
  private rotate(): void {
    this.closeStream();

    const currentPath = this.getCurrentLogPath();

    // 找到下一个可用的轮转编号
    let rotateIndex = 1;
    while (fs.existsSync(this.getRotatedLogPath(rotateIndex))) {
      rotateIndex++;
    }

    // 重命名当前文件
    if (fs.existsSync(currentPath)) {
      try {
        fs.renameSync(currentPath, this.getRotatedLogPath(rotateIndex));
      } catch (error) {
        console.error('[FileLogger] Failed to rotate log file:', error);
      }
    }

    // 清理旧文件
    this.cleanupOldFiles();

    this.currentFileSize = 0;
  }

  /**
   * 清理超出保留数量的旧日志文件
   */
  private cleanupOldFiles(): void {
    try {
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith(LOG_CONFIG.FILE_PREFIX) && f.endsWith('.log'))
        .map(f => ({
          name: f,
          path: path.join(this.logDir, f),
          mtime: fs.statSync(path.join(this.logDir, f)).mtime.getTime(),
        }))
        .sort((a, b) => b.mtime - a.mtime); // 按修改时间降序

      // 保留最新的 N 个文件
      const toDelete = files.slice(this.config.maxFiles);
      for (const file of toDelete) {
        try {
          fs.unlinkSync(file.path);
        } catch (error) {
          console.error(`[FileLogger] Failed to delete old log file: ${file.name}`, error);
        }
      }
    } catch (error) {
      console.error('[FileLogger] Failed to cleanup old files:', error);
    }
  }

  /**
   * 关闭写入流
   */
  private closeStream(): void {
    if (this.writeStream) {
      this.writeStream.end();
      this.writeStream = null;
    }
  }

  /**
   * 写入日志消息
   *
   * @param message 日志消息
   */
  async write(message: string): Promise<void> {
    if (this.isClosing) {
      return;
    }

    // 添加到队列
    this.writeQueue.push(message);

    // 如果已在写入，返回
    if (this.isWriting) {
      return;
    }

    this.isWriting = true;

    try {
      while (this.writeQueue.length > 0) {
        const msg = this.writeQueue.shift()!;
        const stream = this.getWriteStream();
        if (stream) {
          const line = msg.endsWith('\n') ? msg : msg + '\n';
          const written = stream.write(line);
          this.currentFileSize += Buffer.byteLength(line);

          // 如果缓冲区已满，等待 drain 事件
          if (!written) {
            await new Promise<void>(resolve => stream.once('drain', resolve));
          }
        }
      }
    } finally {
      this.isWriting = false;
    }
  }

  /**
   * 同步写入（用于紧急日志）
   *
   * @param message 日志消息
   */
  writeSync(message: string): void {
    if (this.isClosing) {
      return;
    }

    try {
      const logPath = this.getCurrentLogPath();
      const line = message.endsWith('\n') ? message : message + '\n';
      fs.appendFileSync(logPath, line);
      this.currentFileSize += Buffer.byteLength(line);
    } catch (error) {
      console.error('[FileLogger] Failed to write sync:', error);
    }
  }

  /**
   * 关闭日志记录器
   */
  close(): void {
    this.isClosing = true;
    this.closeStream();
  }

  /**
   * 获取日志目录路径
   */
  getLogDir(): string {
    return this.logDir;
  }

  /**
   * 获取当前日志文件路径
   */
  getLogPath(): string {
    return this.getCurrentLogPath();
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let fileLoggerInstance: FileLogger | null = null;

/**
 * 获取文件日志记录器单例
 */
export function getFileLogger(config?: FileLoggerConfig): FileLogger {
  if (!fileLoggerInstance) {
    fileLoggerInstance = new FileLogger(config);
  }
  return fileLoggerInstance;
}

/**
 * 初始化文件日志记录器
 */
export function initFileLogger(config?: FileLoggerConfig): FileLogger {
  if (fileLoggerInstance) {
    fileLoggerInstance.close();
  }
  fileLoggerInstance = new FileLogger(config);
  return fileLoggerInstance;
}

/**
 * 关闭文件日志记录器
 */
export function closeFileLogger(): void {
  if (fileLoggerInstance) {
    fileLoggerInstance.close();
    fileLoggerInstance = null;
  }
}
