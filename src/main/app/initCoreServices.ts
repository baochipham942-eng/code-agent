// ============================================================================
// Phase 1: Core Services - 必须在窗口创建前完成
// ============================================================================

import { app } from '../platform';
import path from 'path';
import { createLogger } from '../services/infra/logger';
import { loadShellEnvironment } from '../services/infra/shellEnvironment';
import { ConfigService, initDatabase } from '../services';
import { initMemoryService } from '../memory/memoryService';
import { initFileCheckpointService } from '../services/checkpoint';
import { TOOL_CACHE } from '../../shared/constants';

const logger = createLogger('Bootstrap:Core');

/**
 * 核心服务初始化 - 必须在窗口创建前完成
 * 只包含 IPC handlers 依赖的最小服务集
 *
 * 性能优化：
 * 1. ConfigService 和 Database 并行初始化
 * 2. Supabase 延迟到后台服务阶段（authService 支持离线模式）
 * 3. MemoryService 在数据库就绪后初始化
 */
export async function initializeCoreServices(): Promise<ConfigService> {
  // Capture shell environment before anything else (for PATH resolution)
  loadShellEnvironment();

  const startTime = Date.now();

  // 并行初始化 ConfigService 和 Database（无依赖关系）
  const configService = new ConfigService();

  const [configResult, dbResult] = await Promise.allSettled([
    configService.initialize(),
    initDatabase(),
  ]);

  // ConfigService 是关键依赖，失败必须抛错
  if (configResult.status === 'rejected') {
    throw configResult.reason;
  }

  const userDataPath = app.getPath('userData');
  if (dbResult.status === 'rejected') {
    logger.error('Database initialization failed — DB features will be unavailable:', dbResult.reason);
  } else {
    logger.info('Config & Database initialized (parallel)', {
      path: path.join(userDataPath, 'code-agent.db'),
      elapsed: Date.now() - startTime,
    });
  }

  // Initialize memory service (depends on database)
  initMemoryService({
    maxRecentMessages: 10,
    toolCacheTTL: TOOL_CACHE.DEFAULT_TTL,
    maxSessionMessages: 100,
    maxRAGResults: 5,
    ragTokenLimit: 2000,
  });
  logger.info('Memory service initialized');

  // 初始化文件检查点服务
  initFileCheckpointService();
  logger.info('File checkpoint service initialized');

  // NOTE: Supabase 延迟到 initializeBackgroundServices() 中初始化
  // authService.initialize() 支持 Supabase 未就绪时从本地缓存读取用户

  logger.info('Core services initialized', { totalElapsed: Date.now() - startTime });
  return configService;
}
