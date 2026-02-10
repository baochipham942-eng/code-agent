// ============================================================================
// WeChat File Watcher - 微信文件夹自动监控导入
// ============================================================================

import path from 'path';
import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { createLogger } from './infra/logger';

const logger = createLogger('WeChatWatcher');

// 微信在 macOS 上的文件存储基础路径
const WECHAT_BASE_PATH = path.join(
  os.homedir(),
  'Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files',
);

// 支持的文件扩展名
const SUPPORTED_EXTENSIONS = new Set([
  '.pdf', '.docx', '.xlsx', '.csv', '.md',
  '.txt', '.html', '.htm', '.pptx',
]);

interface WatcherStatus {
  watching: boolean;
  path?: string;
  processedCount: number;
}

export class WeChatWatcher {
  private watcher: ReturnType<typeof import('chokidar')['watch']> | null = null;
  private processedPaths: Set<string> = new Set();
  private watchPath: string | null = null;
  private watching = false;

  /**
   * 启动微信文件夹监控
   */
  async start(): Promise<void> {
    if (this.watching) return;

    // 检测微信用户目录
    const userDir = await this.detectUserDirectory();
    if (!userDir) {
      logger.info('No WeChat user directory found, watcher not started');
      return;
    }

    const filePath = path.join(userDir, 'msg/file');

    // 检查 msg/file 目录是否存在
    try {
      await fs.promises.access(filePath);
    } catch {
      logger.info('WeChat file directory not found', { path: filePath });
      return;
    }

    this.watchPath = filePath;

    // 加载已处理文件集（从 DB 查询）
    await this.loadProcessedFiles();

    // 启动 chokidar
    try {
      const chokidar = await import('chokidar');
      this.watcher = chokidar.watch(filePath, {
        ignoreInitial: false, // 处理已存在的文件
        awaitWriteFinish: { stabilityThreshold: 2000 },
        depth: 5,
        ignored: /(^|[/\\])\../, // 忽略隐藏文件
      });

      this.watcher.on('add', (fp: string) => {
        this.handleNewFile(fp).catch(err => {
          logger.error('Error handling new file', { path: fp, error: err });
        });
      });

      this.watcher.on('error', (error: unknown) => {
        logger.error('Watcher error', { error: error instanceof Error ? error.message : String(error) });
      });

      this.watching = true;
      logger.info('WeChat watcher started', { path: filePath });
    } catch (error) {
      logger.error('Failed to start chokidar', { error });
    }
  }

  /**
   * 停止监控
   */
  async stop(): Promise<void> {
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    this.watching = false;
    logger.info('WeChat watcher stopped');
  }

  /**
   * 获取监控状态
   */
  getStatus(): WatcherStatus {
    return {
      watching: this.watching,
      path: this.watchPath || undefined,
      processedCount: this.processedPaths.size,
    };
  }

  /**
   * 检测微信用户目录（取最近修改的 *_* 模式目录）
   */
  private async detectUserDirectory(): Promise<string | null> {
    try {
      await fs.promises.access(WECHAT_BASE_PATH);
    } catch {
      return null;
    }

    try {
      const entries = await fs.promises.readdir(WECHAT_BASE_PATH, { withFileTypes: true });
      const userDirs = entries.filter(e => e.isDirectory() && e.name.includes('_'));

      if (userDirs.length === 0) return null;

      // 取最近修改的
      let latestDir = userDirs[0].name;
      let latestTime = 0;

      for (const dir of userDirs) {
        try {
          const stat = await fs.promises.stat(path.join(WECHAT_BASE_PATH, dir.name));
          if (stat.mtimeMs > latestTime) {
            latestTime = stat.mtimeMs;
            latestDir = dir.name;
          }
        } catch {
          // skip
        }
      }

      return path.join(WECHAT_BASE_PATH, latestDir);
    } catch {
      return null;
    }
  }

  /**
   * 从 DB 加载已处理的微信文件路径
   */
  private async loadProcessedFiles(): Promise<void> {
    try {
      const { getDatabase } = await import('./core/databaseService');
      const db = getDatabase();
      if (!db.getDb()) return;

      const items = db.listCaptures({ source: 'wechat', limit: 10000 });
      for (const item of items) {
        const fp = (item.metadata as Record<string, unknown>)?.filePath as string;
        if (fp) {
          this.processedPaths.add(fp);
        }
      }
      logger.debug('Loaded processed WeChat files', { count: this.processedPaths.size });
    } catch (error) {
      logger.warn('Failed to load processed files from DB', { error });
    }
  }

  /**
   * 尝试用系统 pdftotext 提取 PDF 文本
   */
  private extractPdfText(filePath: string): Promise<string | null> {
    return new Promise((resolve) => {
      execFile('pdftotext', [filePath, '-'], { maxBuffer: 10 * 1024 * 1024 }, (error, stdout) => {
        if (error || !stdout?.trim()) {
          resolve(null);
        } else {
          resolve(stdout.trim());
        }
      });
    });
  }

  /**
   * 处理新发现的文件
   */
  private async handleNewFile(filePath: string): Promise<void> {
    // 跳过已处理的
    if (this.processedPaths.has(filePath)) return;

    // 检查扩展名
    const ext = path.extname(filePath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) return;

    // 标记为已处理（即使导入失败也不重试，避免循环）
    this.processedPaths.add(filePath);

    try {
      const { getCaptureService } = await import('./captureService');
      const { getDocumentContextService } = await import('../context/documentContext/documentContextService');
      const service = getCaptureService();
      const docService = getDocumentContextService();
      const basename = path.basename(filePath);

      const stat = await fs.promises.stat(filePath);

      let content: string;

      if (ext === '.pdf') {
        // PDF：用系统 pdftotext 提取，失败则占位
        const text = await this.extractPdfText(filePath);
        content = text || `[PDF: ${basename}] (${stat.size} bytes)`;
      } else if (ext === '.pptx') {
        content = `[File: ${basename}] (${ext} format, ${stat.size} bytes)`;
      } else {
        const buffer = await fs.promises.readFile(filePath);
        if (docService.canParse(filePath)) {
          const doc = await docService.parse(buffer, filePath);
          content = doc ? doc.sections.map(s => s.content).join('\n\n') : buffer.toString('utf-8');
        } else {
          content = buffer.toString('utf-8');
        }
      }

      await service.capture({
        title: basename,
        content,
        source: 'wechat',
        metadata: {
          filePath,
          fileSize: stat.size,
          fileExt: ext,
        },
      });

      logger.info('WeChat file imported', { path: filePath, title: basename });
    } catch (error) {
      logger.error('Failed to import WeChat file', { path: filePath, error });
    }
  }
}

// 单例
let instance: WeChatWatcher | null = null;

export function getWeChatWatcher(): WeChatWatcher {
  if (!instance) {
    instance = new WeChatWatcher();
  }
  return instance;
}
