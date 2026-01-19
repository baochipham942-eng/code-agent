// ============================================================================
// TaskSyncService - 任务同步服务
// 负责本地和云端任务状态的双向同步
// ============================================================================

import { EventEmitter } from 'events';
import { getSupabase } from '../services';
import { getCloudTaskService, CloudTaskService } from './cloudTaskService';
import type {
  CloudTask,
  CloudTaskStatus,
  TaskSyncState,
  TaskProgressEvent,
} from '../../shared/types/cloud';
import { createLogger } from '../services/infra/logger';
import { TASK_SYNC } from '../../shared/constants';

const logger = createLogger('TaskSyncService');

// ============================================================================
// 类型定义
// ============================================================================

export interface SyncConfig {
  enabled: boolean;
  syncInterval: number; // 毫秒
  batchSize: number;
  conflictResolution: 'local-wins' | 'cloud-wins' | 'latest-wins';
  retryAttempts: number;
  retryDelay: number;
}

interface PendingSync {
  taskId: string;
  operation: 'upload' | 'download' | 'update';
  data: Partial<CloudTask>;
  attempts: number;
  lastAttempt?: number;
  error?: string;
}

interface SyncResult {
  success: boolean;
  uploaded: number;
  downloaded: number;
  updated: number;
  errors: Array<{ taskId: string; error: string }>;
  duration: number;
}

const DEFAULT_CONFIG: SyncConfig = {
  enabled: true,
  syncInterval: TASK_SYNC.SYNC_INTERVAL,
  batchSize: TASK_SYNC.BATCH_SIZE,
  conflictResolution: 'latest-wins',
  retryAttempts: TASK_SYNC.RETRY_ATTEMPTS,
  retryDelay: TASK_SYNC.RETRY_DELAY,
};

// ============================================================================
// TaskSyncService
// ============================================================================

export class TaskSyncService extends EventEmitter {
  private config: SyncConfig;
  private cloudService: CloudTaskService;
  private syncTimer: ReturnType<typeof setInterval> | null = null;
  private isSyncing = false;
  private pendingUploads: Map<string, PendingSync> = new Map();
  private pendingDownloads: Map<string, PendingSync> = new Map();
  private lastSyncAt: string | null = null;
  private syncErrors: Array<{ taskId: string; error: string; timestamp: string }> = [];
  private realtimeSubscription: unknown = null;

  constructor(config: Partial<SyncConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.cloudService = getCloudTaskService();
  }

  // --------------------------------------------------------------------------
  // 同步控制
  // --------------------------------------------------------------------------

  /**
   * 启动同步服务
   */
  start(): void {
    if (this.syncTimer) return;

    logger.info('Starting sync service');

    // 启动定时同步
    this.syncTimer = setInterval(() => {
      this.sync();
    }, this.config.syncInterval);

    // 立即执行一次同步
    this.sync();

    // 设置实时订阅
    this.setupRealtimeSubscription();
  }

  /**
   * 停止同步服务
   */
  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }

    this.teardownRealtimeSubscription();
    logger.info('Stopped sync service');
  }

  /**
   * 执行同步
   */
  async sync(): Promise<SyncResult> {
    if (this.isSyncing) {
      return {
        success: false,
        uploaded: 0,
        downloaded: 0,
        updated: 0,
        errors: [{ taskId: '', error: 'Sync already in progress' }],
        duration: 0,
      };
    }

    if (!this.config.enabled) {
      return {
        success: true,
        uploaded: 0,
        downloaded: 0,
        updated: 0,
        errors: [],
        duration: 0,
      };
    }

    this.isSyncing = true;
    const startTime = Date.now();
    const result: SyncResult = {
      success: true,
      uploaded: 0,
      downloaded: 0,
      updated: 0,
      errors: [],
      duration: 0,
    };

    try {
      this.emit('sync:start');

      // 1. 处理待上传的任务
      const uploadResult = await this.processUploads();
      result.uploaded = uploadResult.success;
      result.errors.push(...uploadResult.errors);

      // 2. 从云端下载更新
      const downloadResult = await this.processDownloads();
      result.downloaded = downloadResult.success;
      result.errors.push(...downloadResult.errors);

      // 3. 处理冲突
      const conflictResult = await this.resolveConflicts();
      result.updated = conflictResult.resolved;
      result.errors.push(...conflictResult.errors);

      this.lastSyncAt = new Date().toISOString();
      result.success = result.errors.length === 0;
    } catch (error) {
      logger.error('Sync error:', error);
      result.success = false;
      result.errors.push({
        taskId: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    } finally {
      this.isSyncing = false;
      result.duration = Date.now() - startTime;
      this.emit('sync:complete', result);
    }

    return result;
  }

  // --------------------------------------------------------------------------
  // 上传处理
  // --------------------------------------------------------------------------

  /**
   * 添加待上传任务
   */
  queueUpload(task: CloudTask): void {
    this.pendingUploads.set(task.id, {
      taskId: task.id,
      operation: 'upload',
      data: task,
      attempts: 0,
    });
    this.emit('queue:upload', task.id);
  }

  /**
   * 处理待上传任务
   */
  private async processUploads(): Promise<{
    success: number;
    errors: Array<{ taskId: string; error: string }>;
  }> {
    const errors: Array<{ taskId: string; error: string }> = [];
    let success = 0;

    const batch = Array.from(this.pendingUploads.values())
      .filter((p) => p.attempts < this.config.retryAttempts)
      .slice(0, this.config.batchSize);

    for (const pending of batch) {
      try {
        const supabase = getSupabase();
        const client = supabase;

        if (!client) {
          pending.attempts++;
          pending.error = 'No Supabase connection';
          continue;
        }

        const task = pending.data as CloudTask;
        // TODO: Supabase 类型系统限制，需要 as any 绕过 PostgrestFilterBuilder 泛型约束
        const { error } = await (client.from('cloud_tasks') as any).upsert({
            id: task.id,
            user_id: task.userId,
            session_id: task.sessionId,
            project_id: task.projectId,
            type: task.type,
            title: task.title,
            description: task.description,
            priority: task.priority,
            location: task.location,
            status: task.status,
            progress: task.progress,
            current_step: task.currentStep,
            error: task.error,
            metadata: task.metadata,
            updated_at: task.updatedAt,
          });

        if (error) {
          pending.attempts++;
          pending.error = error.message;
          pending.lastAttempt = Date.now();
          errors.push({ taskId: task.id, error: error.message });
        } else {
          this.pendingUploads.delete(task.id);
          success++;
        }
      } catch (error) {
        pending.attempts++;
        pending.error = error instanceof Error ? error.message : 'Unknown error';
        pending.lastAttempt = Date.now();
      }
    }

    // 清理超过重试次数的任务
    for (const [taskId, pending] of this.pendingUploads) {
      if (pending.attempts >= this.config.retryAttempts) {
        this.syncErrors.push({
          taskId,
          error: pending.error || 'Max retries exceeded',
          timestamp: new Date().toISOString(),
        });
        this.pendingUploads.delete(taskId);
      }
    }

    return { success, errors };
  }

  // --------------------------------------------------------------------------
  // 下载处理
  // --------------------------------------------------------------------------

  /**
   * 处理从云端下载
   */
  private async processDownloads(): Promise<{
    success: number;
    errors: Array<{ taskId: string; error: string }>;
  }> {
    const errors: Array<{ taskId: string; error: string }> = [];
    let success = 0;

    try {
      const supabase = getSupabase();
      const client = supabase;

      if (!client) {
        return { success: 0, errors: [{ taskId: '', error: 'No Supabase connection' }] };
      }

      // 获取自上次同步以来更新的任务
      // TODO: Supabase 类型系统限制，需要 as any 绕过 PostgrestFilterBuilder 泛型约束
      let query = (client.from('cloud_tasks') as any)
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(this.config.batchSize);

      if (this.lastSyncAt) {
        query = query.gt('updated_at', this.lastSyncAt);
      }

      const { data, error } = await query;

      if (error) {
        return { success: 0, errors: [{ taskId: '', error: error.message }] };
      }

      for (const row of data || []) {
        try {
          // 更新本地任务
          const task = await this.cloudService.getTask(row.id);

          if (!task) {
            // 新任务，创建本地副本
            // Note: 这里简化处理，实际应该通过 CloudTaskService
            success++;
          } else {
            // 检查冲突
            const localUpdated = new Date(task.updatedAt).getTime();
            const cloudUpdated = new Date(row.updated_at).getTime();

            if (cloudUpdated > localUpdated) {
              // 云端更新，应用到本地
              await this.cloudService.updateTask(row.id, {
                status: row.status,
                progress: row.progress,
                currentStep: row.current_step,
                error: row.error,
                metadata: row.metadata,
              });
              success++;
            }
          }
        } catch (error) {
          errors.push({
            taskId: row.id,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }
    } catch (error) {
      errors.push({
        taskId: '',
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }

    return { success, errors };
  }

  // --------------------------------------------------------------------------
  // 冲突解决
  // --------------------------------------------------------------------------

  /**
   * 解决同步冲突
   */
  private async resolveConflicts(): Promise<{
    resolved: number;
    errors: Array<{ taskId: string; error: string }>;
  }> {
    // 在当前实现中，冲突在 processDownloads 中处理
    // 这里可以添加更复杂的冲突解决逻辑
    return { resolved: 0, errors: [] };
  }

  // --------------------------------------------------------------------------
  // 实时订阅
  // --------------------------------------------------------------------------

  /**
   * 设置实时订阅
   */
  private async setupRealtimeSubscription(): Promise<void> {
    const supabase = getSupabase();
    const client = supabase;

    if (!client) return;

    try {
      const { data: user } = await client.auth.getUser();
      if (!user.user) return;

      // 订阅任务变更
      this.realtimeSubscription = client
        .channel('cloud_tasks_changes')
        .on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'cloud_tasks',
            filter: `user_id=eq.${user.user.id}`,
          },
          (payload) => {
            this.handleRealtimeChange(payload);
          }
        )
        .subscribe();

      logger.info('Realtime subscription established');
    } catch (error) {
      logger.error('Failed to setup realtime subscription:', error);
    }
  }

  /**
   * 处理实时变更
   */
  private handleRealtimeChange(payload: {
    eventType: string;
    new?: Record<string, unknown>;
    old?: Record<string, unknown>;
  }): void {
    const { eventType, new: newRecord, old: oldRecord } = payload;

    switch (eventType) {
      case 'INSERT':
        if (newRecord) {
          this.emit('task:created', newRecord);
        }
        break;

      case 'UPDATE':
        if (newRecord) {
          const event: TaskProgressEvent = {
            taskId: newRecord.id as string,
            status: newRecord.status as CloudTaskStatus,
            progress: newRecord.progress as number,
            currentStep: newRecord.current_step as string | undefined,
            timestamp: new Date().toISOString(),
          };
          this.emit('task:progress', event);

          if (newRecord.status === 'completed') {
            this.emit('task:completed', newRecord);
          } else if (newRecord.status === 'failed') {
            this.emit('task:failed', newRecord);
          }
        }
        break;

      case 'DELETE':
        if (oldRecord) {
          this.emit('task:deleted', oldRecord.id);
        }
        break;
    }
  }

  /**
   * 清理实时订阅
   */
  private async teardownRealtimeSubscription(): Promise<void> {
    if (this.realtimeSubscription) {
      const supabase = getSupabase();
      const client = supabase;
      if (client) {
        await client.removeChannel(this.realtimeSubscription as ReturnType<typeof client.channel>);
      }
      this.realtimeSubscription = null;
    }
  }

  // --------------------------------------------------------------------------
  // 状态查询
  // --------------------------------------------------------------------------

  /**
   * 获取同步状态
   */
  getSyncState(): TaskSyncState {
    return {
      lastSyncAt: this.lastSyncAt || new Date(0).toISOString(),
      pendingUploads: this.pendingUploads.size,
      pendingDownloads: this.pendingDownloads.size,
      syncErrors: this.syncErrors.slice(-10), // 只保留最近 10 个错误
    };
  }

  /**
   * 检查是否正在同步
   */
  isSyncInProgress(): boolean {
    return this.isSyncing;
  }

  /**
   * 清除同步错误
   */
  clearSyncErrors(): void {
    this.syncErrors = [];
  }

  /**
   * 强制同步特定任务
   */
  async forceSyncTask(taskId: string): Promise<boolean> {
    const task = await this.cloudService.getTask(taskId);
    if (!task) return false;

    this.queueUpload(task);
    await this.sync();

    return !this.pendingUploads.has(taskId);
  }

  /**
   * 更新配置
   */
  updateConfig(config: Partial<SyncConfig>): void {
    const wasEnabled = this.config.enabled;
    this.config = { ...this.config, ...config };

    // 如果启用状态改变，重启同步
    if (wasEnabled && !this.config.enabled) {
      this.stop();
    } else if (!wasEnabled && this.config.enabled) {
      this.start();
    }
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.stop();
    this.pendingUploads.clear();
    this.pendingDownloads.clear();
    this.syncErrors = [];
    this.removeAllListeners();
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let syncServiceInstance: TaskSyncService | null = null;

export function getTaskSyncService(): TaskSyncService {
  if (!syncServiceInstance) {
    syncServiceInstance = new TaskSyncService();
  }
  return syncServiceInstance;
}

export function initTaskSyncService(config: Partial<SyncConfig>): TaskSyncService {
  syncServiceInstance = new TaskSyncService(config);
  return syncServiceInstance;
}
