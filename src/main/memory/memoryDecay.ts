// ============================================================================
// Memory Decay - 记忆衰减算法
// ============================================================================
// 基于 Ebbinghaus 遗忘曲线的记忆衰减系统
// 支持访问强化和时间衰减
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('MemoryDecay');

/**
 * 记忆记录
 */
export interface MemoryRecord {
  id: string;
  content: string;
  createdAt: number;
  lastAccessedAt: number;
  accessCount: number;
  confidence: number;
  category: string;
  metadata?: Record<string, unknown>;
}

/**
 * 衰减配置
 */
export interface DecayConfig {
  /** 基础半衰期（天）*/
  baseHalfLife: number;
  /** 访问强化系数（每次访问增加的天数）*/
  accessBoost: number;
  /** 最大半衰期（天）*/
  maxHalfLife: number;
  /** 最小置信度阈值 */
  minConfidenceThreshold: number;
  /** 清理阈值（低于此值将被清理）*/
  cleanupThreshold: number;
}

/**
 * 默认配置
 */
const DEFAULT_CONFIG: DecayConfig = {
  baseHalfLife: 7, // 7 天基础半衰期
  accessBoost: 3,  // 每次访问增加 3 天
  maxHalfLife: 90, // 最大 90 天半衰期
  minConfidenceThreshold: 0.1,
  cleanupThreshold: 0.05,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 记忆衰减管理器
 */
export class MemoryDecayManager {
  private config: DecayConfig;

  constructor(config: Partial<DecayConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * 计算衰减后的置信度
   *
   * 使用改进的 Ebbinghaus 遗忘曲线：
   * R = R0 * 0.5^(t/T)
   *
   * 其中：
   * - R0 是初始置信度
   * - t 是距离上次访问的时间
   * - T 是有效半衰期（基础 + 访问强化）
   */
  calculateDecayedConfidence(memory: MemoryRecord): number {
    const now = Date.now();
    const ageInDays = (now - memory.lastAccessedAt) / DAY_MS;

    // 计算有效半衰期
    const effectiveHalfLife = Math.min(
      this.config.baseHalfLife + memory.accessCount * this.config.accessBoost,
      this.config.maxHalfLife
    );

    // 应用遗忘曲线
    const decayedConfidence = memory.confidence * Math.pow(0.5, ageInDays / effectiveHalfLife);

    return Math.max(decayedConfidence, 0);
  }

  /**
   * 更新记忆访问（强化记忆）
   */
  recordAccess(memory: MemoryRecord): MemoryRecord {
    const now = Date.now();

    // 先计算当前衰减后的置信度
    const currentConfidence = this.calculateDecayedConfidence(memory);

    // 强化：访问会恢复部分遗忘的置信度
    const reinforcement = (memory.confidence - currentConfidence) * 0.5;
    const newConfidence = Math.min(currentConfidence + reinforcement + 0.1, 1);

    return {
      ...memory,
      lastAccessedAt: now,
      accessCount: memory.accessCount + 1,
      confidence: newConfidence,
    };
  }

  /**
   * 检查记忆是否需要清理
   */
  shouldCleanup(memory: MemoryRecord): boolean {
    const currentConfidence = this.calculateDecayedConfidence(memory);
    return currentConfidence < this.config.cleanupThreshold;
  }

  /**
   * 检查记忆是否仍然有效
   */
  isValid(memory: MemoryRecord): boolean {
    const currentConfidence = this.calculateDecayedConfidence(memory);
    return currentConfidence >= this.config.minConfidenceThreshold;
  }

  /**
   * 批量更新置信度
   */
  updateConfidences(memories: MemoryRecord[]): MemoryRecord[] {
    return memories.map((memory) => ({
      ...memory,
      confidence: this.calculateDecayedConfidence(memory),
    }));
  }

  /**
   * 过滤出有效的记忆
   */
  filterValidMemories(memories: MemoryRecord[]): MemoryRecord[] {
    return memories.filter((memory) => this.isValid(memory));
  }

  /**
   * 获取需要清理的记忆
   */
  getMemoriesToCleanup(memories: MemoryRecord[]): MemoryRecord[] {
    return memories.filter((memory) => this.shouldCleanup(memory));
  }

  /**
   * 计算记忆的相关性分数
   *
   * 结合置信度和时间因素
   */
  calculateRelevanceScore(memory: MemoryRecord, queryRelevance: number): number {
    const confidenceScore = this.calculateDecayedConfidence(memory);
    const recencyBonus = this.calculateRecencyBonus(memory);

    // 加权组合：查询相关性 60%，置信度 25%，时效性 15%
    return queryRelevance * 0.6 + confidenceScore * 0.25 + recencyBonus * 0.15;
  }

  /**
   * 计算时效性加分
   */
  private calculateRecencyBonus(memory: MemoryRecord): number {
    const now = Date.now();
    const ageInDays = (now - memory.lastAccessedAt) / DAY_MS;

    // 24 小时内访问的记忆获得满分时效性加分
    if (ageInDays < 1) return 1;
    // 7 天内访问的记忆获得线性递减的加分
    if (ageInDays < 7) return 1 - (ageInDays - 1) / 6;
    // 7 天后无时效性加分
    return 0;
  }

  /**
   * 预测记忆何时会失效
   */
  predictInvalidationTime(memory: MemoryRecord): number {
    const effectiveHalfLife = Math.min(
      this.config.baseHalfLife + memory.accessCount * this.config.accessBoost,
      this.config.maxHalfLife
    );

    // 计算需要多少天才会低于阈值
    // threshold = confidence * 0.5^(t/T)
    // t = T * log2(confidence / threshold)
    const daysUntilInvalid =
      effectiveHalfLife *
      Math.log2(memory.confidence / this.config.minConfidenceThreshold);

    return memory.lastAccessedAt + daysUntilInvalid * DAY_MS;
  }

  /**
   * 获取记忆统计
   */
  getStats(memories: MemoryRecord[]): {
    total: number;
    valid: number;
    needsCleanup: number;
    avgConfidence: number;
    avgAccessCount: number;
    byCategory: Record<string, { count: number; avgConfidence: number }>;
  } {
    const valid = memories.filter((m) => this.isValid(m));
    const needsCleanup = memories.filter((m) => this.shouldCleanup(m));

    let totalConfidence = 0;
    let totalAccessCount = 0;
    const byCategory: Record<string, { count: number; totalConfidence: number }> = {};

    for (const memory of memories) {
      const confidence = this.calculateDecayedConfidence(memory);
      totalConfidence += confidence;
      totalAccessCount += memory.accessCount;

      if (!byCategory[memory.category]) {
        byCategory[memory.category] = { count: 0, totalConfidence: 0 };
      }
      byCategory[memory.category].count++;
      byCategory[memory.category].totalConfidence += confidence;
    }

    const byCategoryWithAvg: Record<string, { count: number; avgConfidence: number }> = {};
    for (const [category, data] of Object.entries(byCategory)) {
      byCategoryWithAvg[category] = {
        count: data.count,
        avgConfidence: data.count > 0 ? data.totalConfidence / data.count : 0,
      };
    }

    return {
      total: memories.length,
      valid: valid.length,
      needsCleanup: needsCleanup.length,
      avgConfidence: memories.length > 0 ? totalConfidence / memories.length : 0,
      avgAccessCount: memories.length > 0 ? totalAccessCount / memories.length : 0,
      byCategory: byCategoryWithAvg,
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let decayManagerInstance: MemoryDecayManager | null = null;

export function getMemoryDecayManager(config?: Partial<DecayConfig>): MemoryDecayManager {
  if (!decayManagerInstance || config) {
    decayManagerInstance = new MemoryDecayManager(config);
  }
  return decayManagerInstance;
}

export function createMemoryDecayManager(config?: Partial<DecayConfig>): MemoryDecayManager {
  return new MemoryDecayManager(config);
}
