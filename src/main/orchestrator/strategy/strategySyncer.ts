// ============================================================================
// StrategySyncer - 策略同步器
// 负责本地和云端策略的同步
// ============================================================================

import { EventEmitter } from 'events';
import type {
  Strategy,
  StrategySyncRequest,
  StrategySyncResponse,
  StrategyConflict,
  AggregatedStrategyStats,
  CrossUserLearningConfig,
  LearningFeedback,
} from './types';
import { getStrategyManager, StrategyManager } from './strategyManager';

// ============================================================================
// 配置
// ============================================================================

export interface SyncerConfig {
  apiEndpoint: string;
  authToken?: string;
  syncInterval: number;
  autoSync: boolean;
  conflictResolution: 'local' | 'remote' | 'manual';
  crossUserLearning: CrossUserLearningConfig;
}

const DEFAULT_CONFIG: SyncerConfig = {
  apiEndpoint: process.env.CLOUD_API_ENDPOINT || 'https://code-agent-beta.vercel.app',
  syncInterval: 300000, // 5 分钟
  autoSync: true,
  conflictResolution: 'local',
  crossUserLearning: {
    enabled: false,
    minFeedbackCount: 100,
    minSuccessRate: 0.8,
    privacyLevel: 'aggregated',
    categories: ['routing', 'tool_selection'],
  },
};

// ============================================================================
// StrategySyncer 类
// ============================================================================

export class StrategySyncer extends EventEmitter {
  private config: SyncerConfig;
  private manager: StrategyManager;
  private syncTimer: NodeJS.Timeout | null = null;
  private lastSyncAt?: string;
  private isSyncing = false;
  private pendingConflicts: StrategyConflict[] = [];

  constructor(config: Partial<SyncerConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.manager = getStrategyManager();
  }

  /**
   * 启动同步
   */
  start(): void {
    if (this.config.autoSync && !this.syncTimer) {
      this.syncTimer = setInterval(() => {
        this.sync();
      }, this.config.syncInterval);

      // 启动时立即同步一次
      this.sync();
    }
  }

  /**
   * 停止同步
   */
  stop(): void {
    if (this.syncTimer) {
      clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  /**
   * 设置认证令牌
   */
  setAuthToken(token: string): void {
    this.config.authToken = token;
  }

  // --------------------------------------------------------------------------
  // 同步操作
  // --------------------------------------------------------------------------

  /**
   * 执行同步
   */
  async sync(): Promise<StrategySyncResponse> {
    if (this.isSyncing) {
      return {
        success: false,
        strategies: [],
        syncedAt: new Date().toISOString(),
      };
    }

    this.isSyncing = true;
    this.emit('sync:started');

    try {
      // 获取本地策略
      const localStrategies = this.manager.getAllStrategies().filter(
        (s) => s.source !== 'default' // 不同步内置策略
      );

      // 构建同步请求
      const request: StrategySyncRequest = {
        userId: this.getUserId(),
        localStrategies,
        lastSyncAt: this.lastSyncAt,
        includeGlobal: this.config.crossUserLearning.enabled,
      };

      // 调用同步 API
      const response = await this.callSyncApi(request);

      if (response.success) {
        // 处理同步响应
        await this.processSyncResponse(response);
        this.lastSyncAt = response.syncedAt;
        this.emit('sync:completed', response);
      } else {
        this.emit('sync:failed', 'Sync API returned failure');
      }

      return response;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      this.emit('sync:failed', errorMessage);

      return {
        success: false,
        strategies: [],
        syncedAt: new Date().toISOString(),
      };
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * 调用同步 API
   */
  private async callSyncApi(request: StrategySyncRequest): Promise<StrategySyncResponse> {
    const url = `${this.config.apiEndpoint}/api/strategy/sync`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new Error(`Sync API error: ${response.status}`);
    }

    return response.json();
  }

  /**
   * 处理同步响应
   */
  private async processSyncResponse(response: StrategySyncResponse): Promise<void> {
    // 处理冲突
    if (response.conflicts && response.conflicts.length > 0) {
      await this.handleConflicts(response.conflicts, response.strategies);
    }

    // 更新本地策略
    for (const strategy of response.strategies) {
      const local = this.manager.getStrategy(strategy.id);

      if (!local) {
        // 新策略
        await this.manager.registerStrategy(strategy);
      } else if (strategy.version > local.version) {
        // 远程版本更新
        await this.manager.updateStrategy(strategy.id, strategy);
      }
    }

    // 处理全局策略
    if (response.globalStrategies && this.config.crossUserLearning.enabled) {
      await this.processGlobalStrategies(response.globalStrategies);
    }
  }

  /**
   * 处理冲突
   */
  private async handleConflicts(
    conflicts: StrategyConflict[],
    remoteStrategies: Strategy[]
  ): Promise<void> {
    for (const conflict of conflicts) {
      const resolution = conflict.resolution || this.config.conflictResolution;

      switch (resolution) {
        case 'local':
          // 保留本地版本，不做处理
          break;

        case 'remote': {
          // 使用远程版本
          const remoteStrategy = remoteStrategies.find((s) => s.id === conflict.strategyId);
          if (remoteStrategy) {
            await this.manager.updateStrategy(conflict.strategyId, remoteStrategy);
          }
          break;
        }

        case 'manual':
          // 添加到待处理冲突
          this.pendingConflicts.push(conflict);
          this.emit('conflict:pending', conflict);
          break;
      }
    }
  }

  /**
   * 处理全局策略
   */
  private async processGlobalStrategies(globalStrategies: Strategy[]): Promise<void> {
    for (const strategy of globalStrategies) {
      // 只处理符合条件的全局策略
      if (!this.shouldApplyGlobalStrategy(strategy)) continue;

      const local = this.manager.getStrategy(strategy.id);
      if (!local) {
        // 标记为从全局学习的
        strategy.source = 'learned';
        await this.manager.registerStrategy(strategy);
      }
    }
  }

  /**
   * 判断是否应用全局策略
   */
  private shouldApplyGlobalStrategy(strategy: Strategy): boolean {
    const config = this.config.crossUserLearning;

    // 检查类别
    if (!config.categories.includes(strategy.type)) {
      return false;
    }

    // 检查性能指标
    const perf = strategy.metadata.performance;
    if (!perf) return false;

    if (perf.usageCount < config.minFeedbackCount) return false;
    if (perf.successRate < config.minSuccessRate) return false;

    return true;
  }

  // --------------------------------------------------------------------------
  // 冲突管理
  // --------------------------------------------------------------------------

  /**
   * 获取待处理冲突
   */
  getPendingConflicts(): StrategyConflict[] {
    return [...this.pendingConflicts];
  }

  /**
   * 解决冲突
   */
  async resolveConflict(
    strategyId: string,
    resolution: 'local' | 'remote'
  ): Promise<void> {
    const index = this.pendingConflicts.findIndex((c) => c.strategyId === strategyId);
    if (index === -1) return;

    const conflict = this.pendingConflicts[index];
    conflict.resolution = resolution;

    if (resolution === 'remote') {
      // 需要重新从服务器获取
      await this.fetchAndApplyRemoteStrategy(strategyId);
    }

    this.pendingConflicts.splice(index, 1);
    this.emit('conflict:resolved', { strategyId, resolution });
  }

  /**
   * 获取并应用远程策略
   */
  private async fetchAndApplyRemoteStrategy(strategyId: string): Promise<void> {
    const url = `${this.config.apiEndpoint}/api/strategy/${strategyId}`;

    const headers: Record<string, string> = {};
    if (this.config.authToken) {
      headers['Authorization'] = `Bearer ${this.config.authToken}`;
    }

    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`Failed to fetch strategy: ${response.status}`);
    }

    const strategy = await response.json();
    await this.manager.updateStrategy(strategyId, strategy);
  }

  // --------------------------------------------------------------------------
  // 跨用户学习
  // --------------------------------------------------------------------------

  /**
   * 分享策略到全局
   */
  async shareStrategy(strategyId: string): Promise<boolean> {
    if (!this.config.crossUserLearning.enabled) {
      return false;
    }

    const strategy = this.manager.getStrategy(strategyId);
    if (!strategy) return false;

    // 检查是否符合分享条件
    const perf = strategy.metadata.performance;
    if (!perf || perf.usageCount < 10 || perf.successRate < 0.7) {
      return false;
    }

    try {
      const url = `${this.config.apiEndpoint}/api/strategy/share`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.config.authToken) {
        headers['Authorization'] = `Bearer ${this.config.authToken}`;
      }

      // 根据隐私级别处理策略
      const sharedStrategy = this.prepareForSharing(strategy);

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(sharedStrategy),
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 准备分享的策略
   */
  private prepareForSharing(strategy: Strategy): Strategy {
    const shared = { ...strategy };

    // 根据隐私级别移除敏感信息
    switch (this.config.crossUserLearning.privacyLevel) {
      case 'none':
        return shared;

      case 'anonymous':
        delete shared.metadata.author;
        shared.id = `shared_${Date.now()}_${crypto.randomUUID().split('-')[0]}`;
        return shared;

      case 'aggregated':
        // 只保留规则，移除所有个人信息
        return {
          ...shared,
          id: `agg_${Date.now()}`,
          metadata: {
            tags: shared.metadata.tags,
            performance: shared.metadata.performance,
          },
        };

      default:
        return shared;
    }
  }

  /**
   * 获取全局策略统计
   */
  async getGlobalStats(): Promise<AggregatedStrategyStats[]> {
    if (!this.config.crossUserLearning.enabled) {
      return [];
    }

    try {
      const url = `${this.config.apiEndpoint}/api/strategy/stats`;
      const headers: Record<string, string> = {};
      if (this.config.authToken) {
        headers['Authorization'] = `Bearer ${this.config.authToken}`;
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        return [];
      }

      return response.json();
    } catch {
      return [];
    }
  }

  /**
   * 提交匿名反馈
   */
  async submitAnonymousFeedback(feedback: LearningFeedback): Promise<boolean> {
    if (!this.config.crossUserLearning.enabled) {
      return false;
    }

    if (this.config.crossUserLearning.privacyLevel === 'none') {
      return false;
    }

    try {
      const url = `${this.config.apiEndpoint}/api/strategy/feedback`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (this.config.authToken) {
        headers['Authorization'] = `Bearer ${this.config.authToken}`;
      }

      // 匿名化反馈
      const anonymousFeedback = {
        ...feedback,
        userId: 'anonymous',
        id: `anon_${Date.now()}`,
        context: {
          ...feedback.context,
          prompt: this.anonymizePrompt(feedback.context.prompt),
        },
      };

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(anonymousFeedback),
      });

      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * 匿名化 prompt
   */
  private anonymizePrompt(prompt: string): string {
    // 移除可能的敏感信息
    return prompt
      .replace(/\/Users\/[^\/\s]+/g, '/Users/***')
      .replace(/\/home\/[^\/\s]+/g, '/home/***')
      .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '***@***')
      .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g, '****-****-****-****')
      .slice(0, 500); // 限制长度
  }

  // --------------------------------------------------------------------------
  // 辅助方法
  // --------------------------------------------------------------------------

  /**
   * 获取用户 ID
   */
  private getUserId(): string {
    // 简单实现，实际应该从认证系统获取
    return this.config.authToken
      ? Buffer.from(this.config.authToken).toString('base64').slice(0, 16)
      : 'anonymous';
  }

  /**
   * 获取同步状态
   */
  getStatus(): {
    isSyncing: boolean;
    lastSyncAt?: string;
    pendingConflicts: number;
    autoSync: boolean;
  } {
    return {
      isSyncing: this.isSyncing,
      lastSyncAt: this.lastSyncAt,
      pendingConflicts: this.pendingConflicts.length,
      autoSync: this.config.autoSync,
    };
  }

  /**
   * 清理资源
   */
  dispose(): void {
    this.stop();
    this.pendingConflicts = [];
    this.removeAllListeners();
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let syncerInstance: StrategySyncer | null = null;

export function getStrategySyncer(): StrategySyncer {
  if (!syncerInstance) {
    syncerInstance = new StrategySyncer();
  }
  return syncerInstance;
}

export function initStrategySyncer(config: Partial<SyncerConfig>): StrategySyncer {
  syncerInstance = new StrategySyncer(config);
  return syncerInstance;
}
