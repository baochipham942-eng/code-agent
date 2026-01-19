// ============================================================================
// CloudTaskService - 云端任务管理服务
// 负责任务的创建、查询、更新和云端交互
// ============================================================================

import { EventEmitter } from 'events';
import { getSupabase, isSupabaseInitialized } from '../services';
import { encryptForCloud, decryptFromCloud, KeyManager } from '../utils/crypto';
import { getTaskRouter } from './taskRouter';
import type {
  CloudTask,
  EncryptedCloudTask,
  CreateCloudTaskRequest,
  UpdateCloudTaskRequest,
  CloudTaskFilter,
  TaskProgressEvent,
  CloudTaskStatus,
  EncryptedPayload,
} from '../../shared/types/cloud';
import { createLogger } from '../services/infra/logger';
import { CLOUD, TASK_SYNC, AGENT } from '../../shared/constants';

const logger = createLogger('CloudTaskService');

// ============================================================================
// 类型定义
// ============================================================================

export interface CloudTaskServiceConfig {
  autoEncrypt: boolean;
  maxConcurrentTasks: number;
  defaultTimeout: number;
  syncInterval: number;
}

const DEFAULT_CONFIG: CloudTaskServiceConfig = {
  autoEncrypt: true,
  maxConcurrentTasks: 5,
  defaultTimeout: CLOUD.CLOUD_EXECUTION_TIMEOUT,
  syncInterval: TASK_SYNC.CLOUD_TASK_SYNC_INTERVAL,
};

// ============================================================================
// CloudTaskService
// ============================================================================

export class CloudTaskService extends EventEmitter {
  private config: CloudTaskServiceConfig;
  private localTasks: Map<string, CloudTask> = new Map();
  private progressListeners: Map<string, ReturnType<typeof setInterval>> = new Map();

  constructor(config: Partial<CloudTaskServiceConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // --------------------------------------------------------------------------
  // 任务创建
  // --------------------------------------------------------------------------

  /**
   * 创建新任务
   */
  async createTask(request: CreateCloudTaskRequest): Promise<CloudTask> {
    const supabase = getSupabase();
    const router = getTaskRouter();

    // 路由决策
    const routing = router.route(request);
    const location = request.location || routing.recommendedLocation;

    // 准备任务数据
    const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date().toISOString();

    // 加密敏感数据
    let encryptedPrompt: EncryptedPayload | undefined;
    let encryptionKeyId: string | undefined;

    if (this.config.autoEncrypt && request.prompt) {
      const encrypted = encryptForCloud(request.prompt);
      encryptedPrompt = encrypted.encrypted;
      encryptionKeyId = encrypted.keyId;
    }

    const task: CloudTask = {
      id: taskId,
      userId: '', // 将由 RLS 填充
      sessionId: request.sessionId,
      projectId: request.projectId,
      type: request.type,
      title: request.title,
      description: request.description,
      prompt: this.config.autoEncrypt ? '' : request.prompt, // 如果加密则不存储明文
      priority: request.priority || 'normal',
      location,
      maxIterations: request.maxIterations || 20,
      timeout: request.timeout || this.config.defaultTimeout,
      status: 'pending',
      progress: 0,
      createdAt: now,
      updatedAt: now,
      metadata: {
        ...request.metadata,
        routingDecision: routing,
      },
    };

    // 本地缓存
    this.localTasks.set(taskId, task);

    // 如果是云端任务，同步到 Supabase
    if (location === 'cloud' || location === 'hybrid') {
      try {
        const client = supabase;
        if (client) {
          const { data: user } = await client.auth.getUser();

          const insertData = {
            id: taskId,
            user_id: user.user?.id,
            session_id: request.sessionId,
            project_id: request.projectId,
            type: request.type,
            title: request.title,
            description: request.description,
            encrypted_prompt: encryptedPrompt,
            encryption_key_id: encryptionKeyId,
            priority: request.priority || 'normal',
            location,
            max_iterations: request.maxIterations || 20,
            timeout_ms: request.timeout || this.config.defaultTimeout,
            status: 'pending' as const,
            progress: 0,
            metadata: request.metadata || {},
          };

          // TODO: Supabase 类型系统限制，需要 as any 绕过 PostgrestFilterBuilder 泛型约束
          const { error } = await (client.from('cloud_tasks') as any).insert(insertData);

          if (error) {
            logger.error(' Failed to create cloud task:', error);
            // 降级到本地执行
            task.location = 'local';
            task.metadata = { ...task.metadata, cloudSyncError: error.message };
          } else {
            task.userId = user.user?.id || '';
          }
        }
      } catch (error) {
        logger.error(' Error creating cloud task:', error);
        task.location = 'local';
      }
    }

    this.emit('task:created', task);
    return task;
  }

  // --------------------------------------------------------------------------
  // 任务查询
  // --------------------------------------------------------------------------

  /**
   * 获取单个任务
   */
  async getTask(taskId: string): Promise<CloudTask | null> {
    // 先检查本地缓存
    const local = this.localTasks.get(taskId);
    if (local) return local;

    // 从云端获取
    const supabase = getSupabase();
    const client = supabase;
    if (!client) return null;

    try {
      const { data, error } = await client
        .from('cloud_tasks')
        .select('*')
        .eq('id', taskId)
        .single();

      if (error || !data) return null;

      const task = this.mapDbRowToTask(data);
      this.localTasks.set(taskId, task);
      return task;
    } catch (error) {
      logger.error(' Error getting task:', error);
      return null;
    }
  }

  /**
   * 查询任务列表
   */
  async listTasks(filter: CloudTaskFilter = {}): Promise<CloudTask[]> {
    const supabase = getSupabase();
    const client = supabase;

    // 如果没有云端连接，返回本地任务
    if (!client) {
      return this.filterLocalTasks(filter);
    }

    try {
      let query = client.from('cloud_tasks').select('*');

      // 应用过滤条件
      if (filter.status) {
        if (Array.isArray(filter.status)) {
          query = query.in('status', filter.status);
        } else {
          query = query.eq('status', filter.status);
        }
      }

      if (filter.type) {
        if (Array.isArray(filter.type)) {
          query = query.in('type', filter.type);
        } else {
          query = query.eq('type', filter.type);
        }
      }

      if (filter.location) {
        query = query.eq('location', filter.location);
      }

      if (filter.priority) {
        query = query.eq('priority', filter.priority);
      }

      if (filter.projectId) {
        query = query.eq('project_id', filter.projectId);
      }

      if (filter.sessionId) {
        query = query.eq('session_id', filter.sessionId);
      }

      if (filter.createdAfter) {
        query = query.gte('created_at', filter.createdAfter);
      }

      if (filter.createdBefore) {
        query = query.lte('created_at', filter.createdBefore);
      }

      query = query.order('created_at', { ascending: false });

      if (filter.limit) {
        query = query.limit(filter.limit);
      }

      if (filter.offset) {
        query = query.range(filter.offset, filter.offset + (filter.limit || 50) - 1);
      }

      const { data, error } = await query;

      if (error) {
        logger.error(' Error listing tasks:', error);
        return this.filterLocalTasks(filter);
      }

      const tasks = (data || []).map((row) => this.mapDbRowToTask(row));

      // 更新本地缓存
      for (const task of tasks) {
        this.localTasks.set(task.id, task);
      }

      return tasks;
    } catch (error) {
      logger.error(' Error listing tasks:', error);
      return this.filterLocalTasks(filter);
    }
  }

  // --------------------------------------------------------------------------
  // 任务更新
  // --------------------------------------------------------------------------

  /**
   * 更新任务
   */
  async updateTask(
    taskId: string,
    updates: UpdateCloudTaskRequest
  ): Promise<CloudTask | null> {
    const task = await this.getTask(taskId);
    if (!task) return null;

    const now = new Date().toISOString();
    const updatedTask: CloudTask = {
      ...task,
      ...updates,
      updatedAt: now,
    };

    // 处理完成时间
    if (updates.status === 'completed' || updates.status === 'failed') {
      updatedTask.completedAt = now;
    }

    // 处理开始时间
    if (updates.status === 'running' && !task.startedAt) {
      updatedTask.startedAt = now;
    }

    // 更新本地缓存
    this.localTasks.set(taskId, updatedTask);

    // 同步到云端
    if (task.location === 'cloud' || task.location === 'hybrid') {
      const supabase = getSupabase();
      const client = supabase;

      if (client) {
        try {
          // 加密结果
          let encryptedResult: EncryptedPayload | undefined;
          if (updates.result && this.config.autoEncrypt) {
            const encrypted = encryptForCloud(updates.result);
            encryptedResult = encrypted.encrypted;
          }

          const updateData: Record<string, unknown> = {
            status: updates.status,
            progress: updates.progress,
            current_step: updates.currentStep,
            error: updates.error,
            encrypted_result: encryptedResult,
            updated_at: now,
          };

          if (updates.status === 'completed' || updates.status === 'failed') {
            updateData.completed_at = now;
          }

          if (updates.status === 'running' && !task.startedAt) {
            updateData.started_at = now;
          }

          // TODO: Supabase 类型系统限制，需要 as any 绕过 PostgrestFilterBuilder 泛型约束
          const { error } = await (client.from('cloud_tasks') as any).update(updateData).eq('id', taskId);

          if (error) {
            logger.error(' Failed to update cloud task:', error);
          }
        } catch (error) {
          logger.error(' Error updating cloud task:', error);
        }
      }
    }

    this.emit('task:updated', updatedTask);

    if (updates.status === 'completed') {
      this.emit('task:completed', updatedTask);
    } else if (updates.status === 'failed') {
      this.emit('task:failed', updatedTask);
    }

    return updatedTask;
  }

  /**
   * 取消任务
   */
  async cancelTask(taskId: string): Promise<boolean> {
    const task = await this.updateTask(taskId, { status: 'cancelled' });
    if (task) {
      this.emit('task:cancelled', task);
      this.stopProgressPolling(taskId);
      return true;
    }
    return false;
  }

  /**
   * 删除任务
   */
  async deleteTask(taskId: string): Promise<boolean> {
    this.localTasks.delete(taskId);
    this.stopProgressPolling(taskId);

    const supabase = getSupabase();
    const client = supabase;

    if (client) {
      try {
        const { error } = await client
          .from('cloud_tasks')
          .delete()
          .eq('id', taskId);

        if (error) {
          logger.error(' Failed to delete cloud task:', error);
          return false;
        }
      } catch (error) {
        logger.error(' Error deleting cloud task:', error);
        return false;
      }
    }

    this.emit('task:deleted', taskId);
    return true;
  }

  // --------------------------------------------------------------------------
  // 任务执行控制
  // --------------------------------------------------------------------------

  /**
   * 启动任务（将其加入云端队列）
   */
  async startTask(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (!task) return false;

    if (task.status !== 'pending' && task.status !== 'paused') {
      logger.warn(`Cannot start task in ${task.status} status`);
      return false;
    }

    // 如果是云端任务，调用 enqueue 函数
    if (task.location === 'cloud' || task.location === 'hybrid') {
      const supabase = getSupabase();
      const client = supabase;

      if (client) {
        try {
          // TODO: Supabase RPC 调用没有强类型定义
          const { error } = await (client as any).rpc('enqueue_cloud_task', { p_task_id: taskId });

          if (error) {
            logger.error(' Failed to enqueue task:', error);
            return false;
          }

          // 开始轮询进度
          this.startProgressPolling(taskId);
        } catch (error) {
          logger.error(' Error enqueuing task:', error);
          return false;
        }
      }
    }

    await this.updateTask(taskId, { status: 'queued' });
    return true;
  }

  /**
   * 暂停任务
   */
  async pauseTask(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (task?.status !== 'running') return false;

    this.stopProgressPolling(taskId);
    await this.updateTask(taskId, { status: 'paused' });
    return true;
  }

  /**
   * 恢复任务
   */
  async resumeTask(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (task?.status !== 'paused') return false;

    return this.startTask(taskId);
  }

  /**
   * 重试失败的任务
   */
  async retryTask(taskId: string): Promise<boolean> {
    const task = await this.getTask(taskId);
    if (task?.status !== 'failed') return false;

    // 重置任务状态
    await this.updateTask(taskId, {
      status: 'pending',
      progress: 0,
      error: undefined,
      currentStep: undefined,
    });

    // 重新开始任务
    return this.startTask(taskId);
  }

  // --------------------------------------------------------------------------
  // 进度监控
  // --------------------------------------------------------------------------

  /**
   * 开始轮询任务进度
   */
  private startProgressPolling(taskId: string): void {
    if (this.progressListeners.has(taskId)) return;

    const interval = setInterval(async () => {
      const task = await this.fetchTaskProgress(taskId);
      if (!task) {
        this.stopProgressPolling(taskId);
        return;
      }

      const event: TaskProgressEvent = {
        taskId,
        status: task.status,
        progress: task.progress,
        currentStep: task.currentStep,
        timestamp: new Date().toISOString(),
      };

      this.emit('task:progress', event);

      // 如果任务完成或失败，停止轮询
      if (['completed', 'failed', 'cancelled'].includes(task.status)) {
        this.stopProgressPolling(taskId);
      }
    }, this.config.syncInterval);

    this.progressListeners.set(taskId, interval);
  }

  /**
   * 停止轮询任务进度
   */
  private stopProgressPolling(taskId: string): void {
    const interval = this.progressListeners.get(taskId);
    if (interval) {
      clearInterval(interval);
      this.progressListeners.delete(taskId);
    }
  }

  /**
   * 从云端获取最新进度
   */
  private async fetchTaskProgress(taskId: string): Promise<CloudTask | null> {
    const supabase = getSupabase();
    const client = supabase;
    if (!client) return null;

    try {
      // TODO: Supabase 类型系统限制，需要 as any 绕过 PostgrestFilterBuilder 泛型约束
      const { data, error } = await (client.from('cloud_tasks') as any)
        .select('status, progress, current_step, error, completed_at')
        .eq('id', taskId)
        .single();

      if (error || !data) return null;

      // 使用类型断言将 data 转为具体结构
      const progressData = data as {
        status: CloudTaskStatus;
        progress: number;
        current_step?: string;
        error?: string;
        completed_at?: string;
      };

      const task = this.localTasks.get(taskId);
      if (task) {
        task.status = progressData.status;
        task.progress = progressData.progress;
        task.currentStep = progressData.current_step;
        task.error = progressData.error;
        task.completedAt = progressData.completed_at;
        this.localTasks.set(taskId, task);
      }

      return task || null;
    } catch (error) {
      logger.error(' Error fetching progress:', error);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // 辅助方法
  // --------------------------------------------------------------------------

  /**
   * 将数据库行映射为 CloudTask
   */
  private mapDbRowToTask(row: Record<string, unknown>): CloudTask {
    // 解密 prompt
    let prompt = '';
    if (row.encrypted_prompt && row.encryption_key_id) {
      try {
        prompt = decryptFromCloud(
          row.encrypted_prompt as EncryptedPayload,
          row.encryption_key_id as string
        );
      } catch {
        // 解密失败，可能是密钥不可用
        logger.warn(' Failed to decrypt prompt');
      }
    }

    // 解密 result
    let result: string | undefined;
    if (row.encrypted_result && row.encryption_key_id) {
      try {
        result = decryptFromCloud(
          row.encrypted_result as EncryptedPayload,
          row.encryption_key_id as string
        );
      } catch {
        logger.warn(' Failed to decrypt result');
      }
    }

    return {
      id: row.id as string,
      userId: row.user_id as string,
      sessionId: row.session_id as string | undefined,
      projectId: row.project_id as string | undefined,
      type: row.type as CloudTask['type'],
      title: row.title as string,
      description: row.description as string,
      prompt,
      priority: row.priority as CloudTask['priority'],
      location: row.location as CloudTask['location'],
      maxIterations: row.max_iterations as number,
      timeout: row.timeout_ms as number,
      status: row.status as CloudTaskStatus,
      progress: row.progress as number,
      currentStep: row.current_step as string | undefined,
      result,
      error: row.error as string | undefined,
      createdAt: row.created_at as string,
      startedAt: row.started_at as string | undefined,
      completedAt: row.completed_at as string | undefined,
      updatedAt: row.updated_at as string,
      metadata: row.metadata as Record<string, unknown>,
    };
  }

  /**
   * 过滤本地任务
   */
  private filterLocalTasks(filter: CloudTaskFilter): CloudTask[] {
    let tasks = Array.from(this.localTasks.values());

    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      tasks = tasks.filter((t) => statuses.includes(t.status));
    }

    if (filter.type) {
      const types = Array.isArray(filter.type) ? filter.type : [filter.type];
      tasks = tasks.filter((t) => types.includes(t.type));
    }

    if (filter.location) {
      tasks = tasks.filter((t) => t.location === filter.location);
    }

    if (filter.priority) {
      tasks = tasks.filter((t) => t.priority === filter.priority);
    }

    if (filter.projectId) {
      tasks = tasks.filter((t) => t.projectId === filter.projectId);
    }

    if (filter.sessionId) {
      tasks = tasks.filter((t) => t.sessionId === filter.sessionId);
    }

    // 按创建时间降序排序
    tasks.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    if (filter.offset) {
      tasks = tasks.slice(filter.offset);
    }

    if (filter.limit) {
      tasks = tasks.slice(0, filter.limit);
    }

    return tasks;
  }

  /**
   * 获取同步状态
   */
  getSyncState(): import('../../shared/types/cloud').TaskSyncState {
    const tasks = Array.from(this.localTasks.values());
    const pendingTasks = tasks.filter((t) => ['pending', 'queued'].includes(t.status));
    const failedTasks = tasks.filter((t) => t.status === 'failed');

    return {
      lastSyncAt: new Date().toISOString(),
      pendingUploads: pendingTasks.length,
      pendingDownloads: 0,
      syncErrors: failedTasks.map((t) => ({
        taskId: t.id,
        error: t.error || 'Unknown error',
        timestamp: t.updatedAt,
      })),
    };
  }

  /**
   * 获取执行统计
   */
  async getStats(): Promise<import('../../shared/types/cloud').CloudExecutionStats | null> {
    const tasks = Array.from(this.localTasks.values());
    const completed = tasks.filter((t) => t.status === 'completed');
    const failed = tasks.filter((t) => t.status === 'failed');

    // 按类型分组统计
    const byType: import('../../shared/types/cloud').CloudExecutionStats['byType'] = {
      researcher: { total: 0, completed: 0, failed: 0, avgDuration: 0 },
      analyzer: { total: 0, completed: 0, failed: 0, avgDuration: 0 },
      writer: { total: 0, completed: 0, failed: 0, avgDuration: 0 },
      reviewer: { total: 0, completed: 0, failed: 0, avgDuration: 0 },
      planner: { total: 0, completed: 0, failed: 0, avgDuration: 0 },
    };

    // 按位置分组统计
    const byLocation: import('../../shared/types/cloud').CloudExecutionStats['byLocation'] = {
      local: { total: 0, completed: 0, failed: 0 },
      cloud: { total: 0, completed: 0, failed: 0 },
      hybrid: { total: 0, completed: 0, failed: 0 },
    };

    for (const task of tasks) {
      // 按类型
      if (byType[task.type]) {
        byType[task.type].total++;
        if (task.status === 'completed') byType[task.type].completed++;
        if (task.status === 'failed') byType[task.type].failed++;
      }

      // 按位置
      if (byLocation[task.location]) {
        byLocation[task.location].total++;
        if (task.status === 'completed') byLocation[task.location].completed++;
        if (task.status === 'failed') byLocation[task.location].failed++;
      }
    }

    // 计算平均时长
    let totalDuration = 0;
    let durationCount = 0;
    for (const task of completed) {
      if (task.startedAt && task.completedAt) {
        const duration = new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime();
        totalDuration += duration;
        durationCount++;
      }
    }

    return {
      totalTasks: tasks.length,
      completedTasks: completed.length,
      failedTasks: failed.length,
      averageDuration: durationCount > 0 ? totalDuration / durationCount : 0,
      byType,
      byLocation,
    };
  }

  /**
   * 清理资源
   */
  dispose(): void {
    for (const [taskId] of this.progressListeners) {
      this.stopProgressPolling(taskId);
    }
    this.localTasks.clear();
    this.removeAllListeners();
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let serviceInstance: CloudTaskService | null = null;

export function isCloudTaskServiceInitialized(): boolean {
  return serviceInstance !== null;
}

export function getCloudTaskService(): CloudTaskService {
  if (!serviceInstance) {
    serviceInstance = new CloudTaskService();
  }
  return serviceInstance;
}

export function initCloudTaskService(
  config: Partial<CloudTaskServiceConfig>
): CloudTaskService {
  serviceInstance = new CloudTaskService(config);
  return serviceInstance;
}
