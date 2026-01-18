// ============================================================================
// ExecutionRouter - 执行路由器
// 根据任务分析结果决定执行位置（LOCAL/CLOUD/HYBRID）
// ============================================================================

import type { TaskExecutionLocation } from '../../shared/types/cloud';
import type {
  TaskAnalysis,
  RoutingDecision,
  RoutingPriority,
  UserRoutingPreferences,
  RequiredCapability,
} from './types';
import { getTaskAnalyzer, TaskAnalyzer } from './TaskAnalyzer';

// ============================================================================
// 默认配置
// ============================================================================

const DEFAULT_PREFERENCES: UserRoutingPreferences = {
  offlineMode: false,
  powerSaveMode: false,
  sensitiveDataLocal: true,
  allowedCloudTaskTypes: ['research', 'coding', 'automation', 'data', 'general'],
};

// ============================================================================
// 路由规则
// ============================================================================

/**
 * 能力与执行位置的映射
 * - local_only: 只能本地执行
 * - cloud_preferred: 云端优先
 * - local_preferred: 本地优先
 * - any: 都可以
 */
const CAPABILITY_LOCATION_MAP: Record<RequiredCapability, 'local_only' | 'cloud_preferred' | 'local_preferred' | 'any'> = {
  file_access: 'local_only',
  shell: 'local_only',
  browser: 'local_only',
  network: 'cloud_preferred',
  memory: 'any',
  code_analysis: 'cloud_preferred',
  planning: 'cloud_preferred',
};

// ============================================================================
// ExecutionRouter 类
// ============================================================================

export class ExecutionRouter {
  private analyzer: TaskAnalyzer;
  private routingHistory: Map<string, RoutingDecision> = new Map();

  constructor() {
    this.analyzer = getTaskAnalyzer();
  }

  /**
   * 路由决策主入口
   */
  route(
    prompt: string,
    preferences: Partial<UserRoutingPreferences> = {},
    context?: { fileTree?: string[]; currentFile?: string }
  ): RoutingDecision {
    const mergedPreferences = { ...DEFAULT_PREFERENCES, ...preferences };

    // 分析任务
    const analysis = this.analyzer.analyze(prompt, context);

    // 生成决策 ID
    const decisionId = `routing_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // 应用路由规则（按优先级）
    const decision = this.applyRoutingRules(decisionId, analysis, mergedPreferences);

    // 记录历史
    this.routingHistory.set(decisionId, decision);

    return decision;
  }

  /**
   * 应用路由规则
   */
  private applyRoutingRules(
    decisionId: string,
    analysis: TaskAnalysis,
    preferences: UserRoutingPreferences
  ): RoutingDecision {
    const alternatives: RoutingDecision['alternatives'] = [];

    // P1: 安全规则（强制）
    const p1Result = this.applySecurityRules(analysis, preferences);
    if (p1Result) {
      return this.buildDecision(decisionId, p1Result.location, p1Result.reason, 'P1_SECURITY', 0.95, analysis, alternatives);
    }

    // P2: 能力约束（必须）
    const p2Result = this.applyCapabilityRules(analysis);
    if (p2Result) {
      // 添加备选方案
      if (p2Result.location === 'local') {
        alternatives.push({
          location: 'hybrid',
          reason: '可以拆分为本地和云端部分分别执行',
          confidence: 0.6,
        });
      }
      return this.buildDecision(decisionId, p2Result.location, p2Result.reason, 'P2_CAPABILITY', 0.9, analysis, alternatives);
    }

    // P3: 效率优化（建议）
    const p3Result = this.applyEfficiencyRules(analysis);
    if (p3Result) {
      // 添加备选方案
      if (p3Result.location === 'cloud') {
        alternatives.push({
          location: 'local',
          reason: '本地执行结果更可控',
          confidence: 0.7,
        });
      } else {
        alternatives.push({
          location: 'cloud',
          reason: '云端执行不阻塞本地',
          confidence: 0.7,
        });
      }
      alternatives.push({
        location: 'hybrid',
        reason: '混合执行可以平衡效率和可控性',
        confidence: 0.65,
      });
      return this.buildDecision(decisionId, p3Result.location, p3Result.reason, 'P3_EFFICIENCY', 0.8, analysis, alternatives);
    }

    // P4: 用户偏好（可配置）
    const p4Result = this.applyPreferenceRules(preferences);
    if (p4Result) {
      return this.buildDecision(decisionId, p4Result.location, p4Result.reason, 'P4_PREFERENCE', 0.7, analysis, alternatives);
    }

    // 默认：本地执行
    alternatives.push({
      location: 'cloud',
      reason: '云端执行也可行',
      confidence: 0.6,
    });
    alternatives.push({
      location: 'hybrid',
      reason: '混合执行可以平衡效率和可控性',
      confidence: 0.55,
    });

    return this.buildDecision(
      decisionId,
      'local',
      '默认在本地执行以确保安全性和可控性',
      'P4_PREFERENCE',
      0.6,
      analysis,
      alternatives
    );
  }

  /**
   * P1: 安全规则
   */
  private applySecurityRules(
    analysis: TaskAnalysis,
    preferences: UserRoutingPreferences
  ): { location: TaskExecutionLocation; reason: string } | null {
    // 敏感数据必须本地
    if (analysis.sensitivityLevel === 'sensitive' && preferences.sensitiveDataLocal) {
      return {
        location: 'local',
        reason: '任务涉及敏感数据，必须在本地执行以确保安全',
      };
    }

    // 离线模式强制本地
    if (preferences.offlineMode) {
      return {
        location: 'local',
        reason: '离线模式已启用，所有任务在本地执行',
      };
    }

    return null;
  }

  /**
   * P2: 能力约束规则
   */
  private applyCapabilityRules(
    analysis: TaskAnalysis
  ): { location: TaskExecutionLocation; reason: string } | null {
    const { requiredCapabilities } = analysis;

    // 检查是否有必须本地执行的能力
    const localOnlyCapabilities = requiredCapabilities.filter(
      (cap) => CAPABILITY_LOCATION_MAP[cap] === 'local_only'
    );

    if (localOnlyCapabilities.length > 0) {
      return {
        location: 'local',
        reason: `任务需要 ${localOnlyCapabilities.join('、')} 能力，必须在本地执行`,
      };
    }

    // 如果所有能力都是云端优先，推荐云端
    const allCloudPreferred = requiredCapabilities.every(
      (cap) => CAPABILITY_LOCATION_MAP[cap] === 'cloud_preferred' || CAPABILITY_LOCATION_MAP[cap] === 'any'
    );

    if (allCloudPreferred && requiredCapabilities.length > 0) {
      const cloudPreferredCaps = requiredCapabilities.filter(
        (cap) => CAPABILITY_LOCATION_MAP[cap] === 'cloud_preferred'
      );
      if (cloudPreferredCaps.length > 0) {
        return {
          location: 'cloud',
          reason: `任务需要 ${cloudPreferredCaps.join('、')} 能力，云端执行更高效`,
        };
      }
    }

    return null;
  }

  /**
   * P3: 效率优化规则
   */
  private applyEfficiencyRules(
    analysis: TaskAnalysis
  ): { location: TaskExecutionLocation; reason: string } | null {
    const { taskType, complexity, realtimeRequirement, estimatedDuration } = analysis;

    // 研究类任务推荐云端
    if (taskType === 'research') {
      return {
        location: 'cloud',
        reason: '研究类任务适合在云端执行，可利用更强的网络能力',
      };
    }

    // 复杂任务考虑混合执行
    if (complexity === 'complex' && estimatedDuration > 60000) {
      return {
        location: 'hybrid',
        reason: '复杂任务建议混合执行：云端规划 + 本地执行 + 云端审查',
      };
    }

    // 长时间运行的任务推荐云端
    if (realtimeRequirement === 'batch' || estimatedDuration > 120000) {
      return {
        location: 'cloud',
        reason: '长时间任务在云端执行不会阻塞本地',
      };
    }

    // 实时任务推荐本地
    if (realtimeRequirement === 'realtime') {
      return {
        location: 'local',
        reason: '实时任务在本地执行响应更快',
      };
    }

    return null;
  }

  /**
   * P4: 用户偏好规则
   */
  private applyPreferenceRules(
    preferences: UserRoutingPreferences
  ): { location: TaskExecutionLocation; reason: string } | null {
    // 省电模式优先云端
    if (preferences.powerSaveMode) {
      return {
        location: 'cloud',
        reason: '省电模式已启用，优先使用云端执行',
      };
    }

    // 用户指定默认位置
    if (preferences.defaultLocation) {
      return {
        location: preferences.defaultLocation,
        reason: `用户偏好设置为 ${preferences.defaultLocation} 执行`,
      };
    }

    return null;
  }

  /**
   * 构建决策结果
   */
  private buildDecision(
    decisionId: string,
    location: TaskExecutionLocation,
    reason: string,
    priority: RoutingPriority,
    confidence: number,
    analysis: TaskAnalysis,
    alternatives: RoutingDecision['alternatives']
  ): RoutingDecision {
    return {
      decisionId,
      recommendedLocation: location,
      reason,
      priority,
      confidence,
      alternatives,
      analysis,
    };
  }

  /**
   * 直接使用 TaskAnalysis 进行路由
   */
  routeWithAnalysis(
    analysis: TaskAnalysis,
    preferences: Partial<UserRoutingPreferences> = {}
  ): RoutingDecision {
    const mergedPreferences = { ...DEFAULT_PREFERENCES, ...preferences };
    const decisionId = `routing_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return this.applyRoutingRules(decisionId, analysis, mergedPreferences);
  }

  /**
   * 获取路由历史
   */
  getRoutingHistory(): RoutingDecision[] {
    return Array.from(this.routingHistory.values());
  }

  /**
   * 清除路由历史
   */
  clearHistory(): void {
    this.routingHistory.clear();
  }
}

// ============================================================================
// 单例实例
// ============================================================================

let routerInstance: ExecutionRouter | null = null;

export function getExecutionRouter(): ExecutionRouter {
  if (!routerInstance) {
    routerInstance = new ExecutionRouter();
  }
  return routerInstance;
}
