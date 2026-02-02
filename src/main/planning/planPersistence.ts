// ============================================================================
// Plan Persistence - 计划持久化与快照管理
// ============================================================================
// 支持计划状态快照和回退
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import { createLogger } from '../services/infra/logger';
import type { TaskPlan } from './types';
import type { PlanSnapshot, Checkpoint } from './feasibilityChecker';

const logger = createLogger('PlanPersistence');

/**
 * 持久化配置
 */
export interface PersistenceConfig {
  workingDirectory: string;
  sessionId: string;
  maxSnapshots: number;
  autoSnapshot: boolean;
  snapshotInterval: number; // 毫秒
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: Partial<PersistenceConfig> = {
  maxSnapshots: 10,
  autoSnapshot: true,
  snapshotInterval: 5 * 60 * 1000, // 5 分钟
};

/**
 * 文件状态
 */
interface FileState {
  path: string;
  hash: string;
  size: number;
  lastModified: number;
}

/**
 * 计划持久化管理器
 */
export class PlanPersistence {
  private config: PersistenceConfig;
  private snapshots: PlanSnapshot[] = [];
  private checkpoints: Map<string, Checkpoint> = new Map();
  private lastSnapshotTime: number = 0;
  private snapshotDir: string;

  constructor(config: PersistenceConfig) {
    this.config = { ...DEFAULT_CONFIG, ...config } as PersistenceConfig;
    this.snapshotDir = path.join(
      config.workingDirectory,
      '.code-agent',
      'snapshots',
      config.sessionId
    );
  }

  /**
   * 初始化持久化服务
   */
  async initialize(): Promise<void> {
    await fs.mkdir(this.snapshotDir, { recursive: true });
    await this.loadSnapshots();
    logger.info('计划持久化服务初始化完成', { snapshotDir: this.snapshotDir });
  }

  /**
   * 创建计划快照
   */
  async createSnapshot(
    plan: TaskPlan,
    description: string,
    affectedFiles?: string[]
  ): Promise<PlanSnapshot> {
    const fileStates = new Map<string, string>();

    // 记录受影响文件的状态
    if (affectedFiles) {
      for (const filePath of affectedFiles) {
        try {
          const hash = await this.hashFile(filePath);
          fileStates.set(filePath, hash);
        } catch (error) {
          // 文件可能不存在
          logger.debug(`无法获取文件哈希: ${filePath}`);
        }
      }
    }

    const snapshot: PlanSnapshot = {
      id: this.generateId(),
      planState: JSON.parse(JSON.stringify(plan)), // 深拷贝
      fileStates,
      createdAt: Date.now(),
      description,
    };

    this.snapshots.push(snapshot);
    this.lastSnapshotTime = Date.now();

    // 清理旧快照
    while (this.snapshots.length > this.config.maxSnapshots) {
      const removed = this.snapshots.shift();
      if (removed) {
        await this.deleteSnapshotFile(removed.id);
      }
    }

    // 持久化快照
    await this.saveSnapshot(snapshot);

    logger.info('创建计划快照', { snapshotId: snapshot.id, description });
    return snapshot;
  }

  /**
   * 检查是否应该自动创建快照
   */
  shouldAutoSnapshot(): boolean {
    if (!this.config.autoSnapshot) return false;

    const timeSinceLastSnapshot = Date.now() - this.lastSnapshotTime;
    return timeSinceLastSnapshot >= this.config.snapshotInterval;
  }

  /**
   * 回退到指定快照
   */
  async rollbackToSnapshot(snapshotId: string): Promise<TaskPlan | null> {
    const snapshot = this.snapshots.find((s) => s.id === snapshotId);
    if (!snapshot) {
      logger.error('快照不存在', { snapshotId });
      return null;
    }

    logger.info('回退到快照', { snapshotId, description: snapshot.description });
    return snapshot.planState;
  }

  /**
   * 获取可用于回退的快照列表
   */
  getAvailableSnapshots(): Array<{
    id: string;
    description: string;
    createdAt: number;
    planProgress: number;
  }> {
    return this.snapshots.map((s) => ({
      id: s.id,
      description: s.description,
      createdAt: s.createdAt,
      planProgress: s.planState.metadata.completedSteps / s.planState.metadata.totalSteps * 100,
    }));
  }

  /**
   * 创建检查点
   */
  createCheckpoint(
    phaseId: string,
    stepId: string,
    description: string,
    validation: () => Promise<boolean>
  ): Checkpoint {
    const checkpoint: Checkpoint = {
      id: this.generateId(),
      phaseId,
      stepId,
      description,
      validation,
      createdAt: Date.now(),
    };

    this.checkpoints.set(checkpoint.id, checkpoint);
    logger.info('创建检查点', { checkpointId: checkpoint.id, description });

    return checkpoint;
  }

  /**
   * 验证检查点
   */
  async validateCheckpoint(checkpointId: string): Promise<boolean> {
    const checkpoint = this.checkpoints.get(checkpointId);
    if (!checkpoint) {
      logger.error('检查点不存在', { checkpointId });
      return false;
    }

    try {
      const result = await checkpoint.validation();
      logger.info('检查点验证结果', { checkpointId, passed: result });
      return result;
    } catch (error) {
      logger.error('检查点验证失败', { checkpointId, error });
      return false;
    }
  }

  /**
   * 获取步骤的检查点
   */
  getCheckpointsForStep(phaseId: string, stepId: string): Checkpoint[] {
    return Array.from(this.checkpoints.values()).filter(
      (cp) => cp.phaseId === phaseId && cp.stepId === stepId
    );
  }

  /**
   * 比较两个快照之间的差异
   */
  async compareSnapshots(
    snapshotId1: string,
    snapshotId2: string
  ): Promise<{
    planDiffs: Array<{ field: string; before: unknown; after: unknown }>;
    fileDiffs: Array<{ file: string; status: 'added' | 'removed' | 'modified' }>;
  }> {
    const snapshot1 = this.snapshots.find((s) => s.id === snapshotId1);
    const snapshot2 = this.snapshots.find((s) => s.id === snapshotId2);

    if (!snapshot1 || !snapshot2) {
      throw new Error('快照不存在');
    }

    const planDiffs: Array<{ field: string; before: unknown; after: unknown }> = [];

    // 比较计划元数据
    if (snapshot1.planState.metadata.completedSteps !== snapshot2.planState.metadata.completedSteps) {
      planDiffs.push({
        field: 'completedSteps',
        before: snapshot1.planState.metadata.completedSteps,
        after: snapshot2.planState.metadata.completedSteps,
      });
    }

    // 比较文件状态
    const fileDiffs: Array<{ file: string; status: 'added' | 'removed' | 'modified' }> = [];

    // 检查新增和修改的文件
    for (const [file, hash] of snapshot2.fileStates) {
      const oldHash = snapshot1.fileStates.get(file);
      if (!oldHash) {
        fileDiffs.push({ file, status: 'added' });
      } else if (oldHash !== hash) {
        fileDiffs.push({ file, status: 'modified' });
      }
    }

    // 检查删除的文件
    for (const [file] of snapshot1.fileStates) {
      if (!snapshot2.fileStates.has(file)) {
        fileDiffs.push({ file, status: 'removed' });
      }
    }

    return { planDiffs, fileDiffs };
  }

  /**
   * 导出计划和快照
   */
  async exportPlan(
    plan: TaskPlan,
    outputPath: string
  ): Promise<void> {
    const exportData = {
      plan,
      snapshots: this.snapshots.map((s) => ({
        id: s.id,
        description: s.description,
        createdAt: s.createdAt,
        planProgress: s.planState.metadata.completedSteps,
      })),
      exportedAt: Date.now(),
    };

    await fs.writeFile(outputPath, JSON.stringify(exportData, null, 2), 'utf-8');
    logger.info('导出计划', { outputPath });
  }

  /**
   * 导入计划
   */
  async importPlan(inputPath: string): Promise<TaskPlan> {
    const content = await fs.readFile(inputPath, 'utf-8');
    const data = JSON.parse(content);
    logger.info('导入计划', { inputPath });
    return data.plan;
  }

  // --------------------------------------------------------------------------
  // Private Methods
  // --------------------------------------------------------------------------

  private async hashFile(filePath: string): Promise<string> {
    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.join(this.config.workingDirectory, filePath);

    const content = await fs.readFile(absolutePath);
    return createHash('md5').update(content).digest('hex');
  }

  private async saveSnapshot(snapshot: PlanSnapshot): Promise<void> {
    const snapshotPath = path.join(this.snapshotDir, `${snapshot.id}.json`);

    // 序列化 Map 为对象
    const serializable = {
      ...snapshot,
      fileStates: Object.fromEntries(snapshot.fileStates),
    };

    await fs.writeFile(snapshotPath, JSON.stringify(serializable, null, 2), 'utf-8');
  }

  private async loadSnapshots(): Promise<void> {
    try {
      const files = await fs.readdir(this.snapshotDir);
      const snapshotFiles = files.filter((f) => f.endsWith('.json'));

      for (const file of snapshotFiles) {
        try {
          const content = await fs.readFile(
            path.join(this.snapshotDir, file),
            'utf-8'
          );
          const data = JSON.parse(content);

          // 反序列化 fileStates
          const snapshot: PlanSnapshot = {
            ...data,
            fileStates: new Map(Object.entries(data.fileStates || {})),
          };

          this.snapshots.push(snapshot);
        } catch (error) {
          logger.warn(`加载快照失败: ${file}`, error);
        }
      }

      // 按时间排序
      this.snapshots.sort((a, b) => a.createdAt - b.createdAt);
      logger.info(`加载了 ${this.snapshots.length} 个快照`);
    } catch (error) {
      // 目录可能不存在
      logger.debug('没有已保存的快照');
    }
  }

  private async deleteSnapshotFile(snapshotId: string): Promise<void> {
    try {
      const snapshotPath = path.join(this.snapshotDir, `${snapshotId}.json`);
      await fs.unlink(snapshotPath);
    } catch (error) {
      // 忽略删除失败
    }
  }

  private generateId(): string {
    return `snap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  /**
   * 清理所有快照
   */
  async clearAllSnapshots(): Promise<void> {
    for (const snapshot of this.snapshots) {
      await this.deleteSnapshotFile(snapshot.id);
    }
    this.snapshots = [];
    this.checkpoints.clear();
    logger.info('清理所有快照');
  }

  /**
   * 获取存储统计
   */
  async getStorageStats(): Promise<{
    snapshotCount: number;
    checkpointCount: number;
    totalSize: number;
  }> {
    let totalSize = 0;

    try {
      const files = await fs.readdir(this.snapshotDir);
      for (const file of files) {
        const stats = await fs.stat(path.join(this.snapshotDir, file));
        totalSize += stats.size;
      }
    } catch {
      // 目录可能不存在
    }

    return {
      snapshotCount: this.snapshots.length,
      checkpointCount: this.checkpoints.size,
      totalSize,
    };
  }
}

// ----------------------------------------------------------------------------
// Factory Function
// ----------------------------------------------------------------------------

export async function createPlanPersistence(
  config: PersistenceConfig
): Promise<PlanPersistence> {
  const persistence = new PlanPersistence(config);
  await persistence.initialize();
  return persistence;
}
