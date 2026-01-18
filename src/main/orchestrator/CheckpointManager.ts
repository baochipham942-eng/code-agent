// ============================================================================
// CheckpointManager - 断点续传管理器
// 保存和恢复任务执行状态，支持中断后恢复
// ============================================================================

import { EventEmitter } from 'events';
import * as fs from 'fs/promises';
import * as path from 'path';
import { app } from 'electron';

// ============================================================================
// 类型定义
// ============================================================================

export interface TaskCheckpoint {
  taskId: string;
  version: number;
  createdAt: string;
  updatedAt: string;

  // 执行状态
  status: 'running' | 'paused' | 'interrupted';
  progress: number;
  currentIteration: number;
  maxIterations: number;

  // 上下文
  prompt: string;
  location: 'local' | 'cloud' | 'hybrid';
  projectPath?: string;
  sessionId?: string;

  // 执行历史
  messages: CheckpointMessage[];
  toolResults: ToolResultSnapshot[];

  // 输出
  partialOutput: string;

  // 元数据
  metadata?: Record<string, unknown>;
}

export interface CheckpointMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  timestamp: number;
  toolCall?: {
    id: string;
    name: string;
    input: unknown;
  };
}

export interface ToolResultSnapshot {
  toolCallId: string;
  toolName: string;
  result: unknown;
  success: boolean;
  timestamp: number;
}

export interface CheckpointManagerConfig {
  storageDir: string;
  maxCheckpoints: number;
  autoSaveInterval: number; // 毫秒
  compressOld: boolean;
}

export interface ResumeResult {
  success: boolean;
  checkpoint?: TaskCheckpoint;
  error?: string;
}

const DEFAULT_CONFIG: CheckpointManagerConfig = {
  storageDir: path.join(app?.getPath('userData') || '.', 'checkpoints'),
  maxCheckpoints: 50,
  autoSaveInterval: 10000, // 10 秒
  compressOld: true,
};

// ============================================================================
// CheckpointManager 类
// ============================================================================

export class CheckpointManager extends EventEmitter {
  private config: CheckpointManagerConfig;
  private activeCheckpoints: Map<string, TaskCheckpoint> = new Map();
  private autoSaveTimers: Map<string, NodeJS.Timeout> = new Map();
  private initialized = false;

  constructor(config: Partial<CheckpointManagerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 初始化存储目录
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;

    try {
      await fs.mkdir(this.config.storageDir, { recursive: true });
      await this.loadActiveCheckpoints();
      this.initialized = true;
    } catch (error) {
      console.error('[CheckpointManager] Initialize failed:', error);
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // 检查点创建和更新
  // --------------------------------------------------------------------------

  /**
   * 创建新的检查点
   */
  async createCheckpoint(params: {
    taskId: string;
    prompt: string;
    location: 'local' | 'cloud' | 'hybrid';
    maxIterations: number;
    projectPath?: string;
    sessionId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<TaskCheckpoint> {
    await this.ensureInitialized();

    const checkpoint: TaskCheckpoint = {
      taskId: params.taskId,
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: 'running',
      progress: 0,
      currentIteration: 0,
      maxIterations: params.maxIterations,
      prompt: params.prompt,
      location: params.location,
      projectPath: params.projectPath,
      sessionId: params.sessionId,
      messages: [],
      toolResults: [],
      partialOutput: '',
      metadata: params.metadata,
    };

    this.activeCheckpoints.set(params.taskId, checkpoint);
    await this.saveCheckpoint(checkpoint);
    this.startAutoSave(params.taskId);

    this.emit('checkpoint:created', checkpoint);
    return checkpoint;
  }

  /**
   * 更新检查点进度
   */
  async updateProgress(
    taskId: string,
    updates: {
      progress?: number;
      currentIteration?: number;
      status?: 'running' | 'paused' | 'interrupted';
      partialOutput?: string;
    }
  ): Promise<void> {
    const checkpoint = this.activeCheckpoints.get(taskId);
    if (!checkpoint) return;

    if (updates.progress !== undefined) checkpoint.progress = updates.progress;
    if (updates.currentIteration !== undefined) checkpoint.currentIteration = updates.currentIteration;
    if (updates.status !== undefined) checkpoint.status = updates.status;
    if (updates.partialOutput !== undefined) checkpoint.partialOutput = updates.partialOutput;
    checkpoint.updatedAt = new Date().toISOString();
    checkpoint.version++;

    this.emit('checkpoint:updated', checkpoint);
  }

  /**
   * 添加消息到检查点
   */
  addMessage(taskId: string, message: Omit<CheckpointMessage, 'timestamp'>): void {
    const checkpoint = this.activeCheckpoints.get(taskId);
    if (!checkpoint) return;

    checkpoint.messages.push({
      ...message,
      timestamp: Date.now(),
    });
    checkpoint.updatedAt = new Date().toISOString();
    checkpoint.version++;
  }

  /**
   * 添加工具执行结果
   */
  addToolResult(taskId: string, result: Omit<ToolResultSnapshot, 'timestamp'>): void {
    const checkpoint = this.activeCheckpoints.get(taskId);
    if (!checkpoint) return;

    checkpoint.toolResults.push({
      ...result,
      timestamp: Date.now(),
    });
    checkpoint.updatedAt = new Date().toISOString();
    checkpoint.version++;
  }

  // --------------------------------------------------------------------------
  // 检查点恢复
  // --------------------------------------------------------------------------

  /**
   * 恢复检查点
   */
  async resumeCheckpoint(taskId: string): Promise<ResumeResult> {
    await this.ensureInitialized();

    try {
      // 先检查内存中的检查点
      let checkpoint = this.activeCheckpoints.get(taskId);

      // 如果内存中没有，从磁盘加载
      if (!checkpoint) {
        checkpoint = await this.loadCheckpointFromDisk(taskId);
      }

      if (!checkpoint) {
        return { success: false, error: 'Checkpoint not found' };
      }

      // 验证检查点状态
      if (checkpoint.status !== 'paused' && checkpoint.status !== 'interrupted') {
        return { success: false, error: `Cannot resume checkpoint in ${checkpoint.status} state` };
      }

      // 更新状态
      checkpoint.status = 'running';
      checkpoint.updatedAt = new Date().toISOString();
      checkpoint.version++;

      this.activeCheckpoints.set(taskId, checkpoint);
      this.startAutoSave(taskId);

      this.emit('checkpoint:resumed', checkpoint);
      return { success: true, checkpoint };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * 获取可恢复的检查点列表
   */
  async getResumableCheckpoints(): Promise<TaskCheckpoint[]> {
    await this.ensureInitialized();

    const checkpoints: TaskCheckpoint[] = [];

    // 从内存中获取
    for (const checkpoint of this.activeCheckpoints.values()) {
      if (checkpoint.status === 'paused' || checkpoint.status === 'interrupted') {
        checkpoints.push(checkpoint);
      }
    }

    // 从磁盘获取
    try {
      const files = await fs.readdir(this.config.storageDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;

        const taskId = file.replace('.json', '');
        if (this.activeCheckpoints.has(taskId)) continue;

        try {
          const checkpoint = await this.loadCheckpointFromDisk(taskId);
          if (checkpoint && (checkpoint.status === 'paused' || checkpoint.status === 'interrupted')) {
            checkpoints.push(checkpoint);
          }
        } catch {
          // 忽略无法加载的检查点
        }
      }
    } catch {
      // 目录不存在或无法读取
    }

    // 按更新时间排序
    return checkpoints.sort((a, b) =>
      new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    );
  }

  // --------------------------------------------------------------------------
  // 检查点完成和清理
  // --------------------------------------------------------------------------

  /**
   * 标记检查点完成
   */
  async completeCheckpoint(taskId: string, finalOutput?: string): Promise<void> {
    const checkpoint = this.activeCheckpoints.get(taskId);
    if (!checkpoint) return;

    this.stopAutoSave(taskId);

    if (finalOutput) {
      checkpoint.partialOutput = finalOutput;
    }

    // 删除检查点文件
    await this.deleteCheckpointFile(taskId);
    this.activeCheckpoints.delete(taskId);

    this.emit('checkpoint:completed', { taskId, finalOutput });
  }

  /**
   * 暂停任务（保存当前状态）
   */
  async pauseTask(taskId: string): Promise<void> {
    const checkpoint = this.activeCheckpoints.get(taskId);
    if (!checkpoint) return;

    checkpoint.status = 'paused';
    checkpoint.updatedAt = new Date().toISOString();
    checkpoint.version++;

    await this.saveCheckpoint(checkpoint);
    this.stopAutoSave(taskId);

    this.emit('checkpoint:paused', checkpoint);
  }

  /**
   * 标记任务中断（异常中断）
   */
  async markInterrupted(taskId: string, reason?: string): Promise<void> {
    const checkpoint = this.activeCheckpoints.get(taskId);
    if (!checkpoint) return;

    checkpoint.status = 'interrupted';
    checkpoint.updatedAt = new Date().toISOString();
    checkpoint.version++;
    if (reason) {
      checkpoint.metadata = { ...checkpoint.metadata, interruptReason: reason };
    }

    await this.saveCheckpoint(checkpoint);
    this.stopAutoSave(taskId);

    this.emit('checkpoint:interrupted', checkpoint);
  }

  /**
   * 删除检查点
   */
  async deleteCheckpoint(taskId: string): Promise<void> {
    this.stopAutoSave(taskId);
    this.activeCheckpoints.delete(taskId);
    await this.deleteCheckpointFile(taskId);
    this.emit('checkpoint:deleted', { taskId });
  }

  /**
   * 清理过期的检查点
   */
  async cleanupOldCheckpoints(): Promise<number> {
    await this.ensureInitialized();

    try {
      const files = await fs.readdir(this.config.storageDir);
      const checkpoints: { file: string; mtime: number }[] = [];

      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.config.storageDir, file);
        const stat = await fs.stat(filePath);
        checkpoints.push({ file, mtime: stat.mtimeMs });
      }

      // 按修改时间排序
      checkpoints.sort((a, b) => b.mtime - a.mtime);

      // 删除超出限制的检查点
      let deleted = 0;
      for (let i = this.config.maxCheckpoints; i < checkpoints.length; i++) {
        const filePath = path.join(this.config.storageDir, checkpoints[i].file);
        await fs.unlink(filePath);
        deleted++;
      }

      return deleted;
    } catch {
      return 0;
    }
  }

  // --------------------------------------------------------------------------
  // 存储操作
  // --------------------------------------------------------------------------

  /**
   * 保存检查点到磁盘
   */
  private async saveCheckpoint(checkpoint: TaskCheckpoint): Promise<void> {
    const filePath = this.getCheckpointPath(checkpoint.taskId);
    const data = JSON.stringify(checkpoint, null, 2);
    await fs.writeFile(filePath, data, 'utf-8');
  }

  /**
   * 从磁盘加载检查点
   */
  private async loadCheckpointFromDisk(taskId: string): Promise<TaskCheckpoint | null> {
    const filePath = this.getCheckpointPath(taskId);
    try {
      const data = await fs.readFile(filePath, 'utf-8');
      return JSON.parse(data) as TaskCheckpoint;
    } catch {
      return null;
    }
  }

  /**
   * 加载所有活跃的检查点
   */
  private async loadActiveCheckpoints(): Promise<void> {
    try {
      const files = await fs.readdir(this.config.storageDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const taskId = file.replace('.json', '');
        const checkpoint = await this.loadCheckpointFromDisk(taskId);
        if (checkpoint && checkpoint.status === 'running') {
          // 运行中的检查点标记为中断
          checkpoint.status = 'interrupted';
          checkpoint.metadata = { ...checkpoint.metadata, interruptReason: 'Application restart' };
          await this.saveCheckpoint(checkpoint);
        }
        if (checkpoint) {
          this.activeCheckpoints.set(taskId, checkpoint);
        }
      }
    } catch {
      // 目录不存在
    }
  }

  /**
   * 删除检查点文件
   */
  private async deleteCheckpointFile(taskId: string): Promise<void> {
    const filePath = this.getCheckpointPath(taskId);
    try {
      await fs.unlink(filePath);
    } catch {
      // 文件不存在
    }
  }

  /**
   * 获取检查点文件路径
   */
  private getCheckpointPath(taskId: string): string {
    return path.join(this.config.storageDir, `${taskId}.json`);
  }

  // --------------------------------------------------------------------------
  // 自动保存
  // --------------------------------------------------------------------------

  /**
   * 启动自动保存
   */
  private startAutoSave(taskId: string): void {
    this.stopAutoSave(taskId);

    const timer = setInterval(async () => {
      const checkpoint = this.activeCheckpoints.get(taskId);
      if (checkpoint) {
        await this.saveCheckpoint(checkpoint);
      }
    }, this.config.autoSaveInterval);

    this.autoSaveTimers.set(taskId, timer);
  }

  /**
   * 停止自动保存
   */
  private stopAutoSave(taskId: string): void {
    const timer = this.autoSaveTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.autoSaveTimers.delete(taskId);
    }
  }

  // --------------------------------------------------------------------------
  // 查询方法
  // --------------------------------------------------------------------------

  /**
   * 获取检查点
   */
  getCheckpoint(taskId: string): TaskCheckpoint | undefined {
    return this.activeCheckpoints.get(taskId);
  }

  /**
   * 检查点是否存在
   */
  hasCheckpoint(taskId: string): boolean {
    return this.activeCheckpoints.has(taskId);
  }

  /**
   * 获取活跃检查点数量
   */
  getActiveCount(): number {
    return this.activeCheckpoints.size;
  }

  // --------------------------------------------------------------------------
  // 辅助方法
  // --------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (!this.initialized) {
      await this.initialize();
    }
  }

  /**
   * 清理资源
   */
  dispose(): void {
    // 停止所有自动保存
    for (const [taskId] of this.autoSaveTimers) {
      this.stopAutoSave(taskId);
    }
    this.activeCheckpoints.clear();
    this.removeAllListeners();
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let managerInstance: CheckpointManager | null = null;

export function getCheckpointManager(): CheckpointManager {
  if (!managerInstance) {
    managerInstance = new CheckpointManager();
  }
  return managerInstance;
}

export function initCheckpointManager(config: Partial<CheckpointManagerConfig>): CheckpointManager {
  managerInstance = new CheckpointManager(config);
  return managerInstance;
}
