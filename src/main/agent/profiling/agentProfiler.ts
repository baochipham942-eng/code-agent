// ============================================================================
// Agent Profiler - Agent 性能画像与推荐
// ============================================================================
// 追踪每个 agent 在不同任务类型上的成功率，路由时优先匹配历史表现最佳的 agent。
// 使用 Wilson score 置信区间排名。
// ============================================================================

import { createLogger } from '../../services/infra/logger';

const logger = createLogger('AgentProfiler');

// ============================================================================
// Types
// ============================================================================

export interface AgentOutcome {
  agentId: string;
  agentName: string;
  taskType: string;
  success: boolean;
  verificationScore: number; // 0-1
  durationMs: number;
  costUSD: number;
  timestamp: number;
}

export interface AgentProfile {
  agentId: string;
  agentName: string;
  taskType: string;
  successCount: number;
  failureCount: number;
  totalExecutions: number;
  avgScore: number;
  avgDurationMs: number;
  avgCostUSD: number;
  wilsonScore: number;
  lastUpdated: number;
}

export interface AgentRecommendation {
  agentId: string;
  agentName: string;
  wilsonScore: number;
  totalExecutions: number;
  avgScore: number;
  confidence: 'high' | 'medium' | 'low';
}

// ============================================================================
// Wilson Score Calculation
// ============================================================================

/**
 * Calculate Wilson score confidence interval lower bound
 * Used for ranking agents with different sample sizes
 */
function wilsonScoreLowerBound(successes: number, total: number, z: number = 1.96): number {
  if (total === 0) return 0;

  const p = successes / total;
  const denominator = 1 + (z * z) / total;
  const center = p + (z * z) / (2 * total);
  const deviation = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);

  return (center - deviation) / denominator;
}

// ============================================================================
// Agent Profiler
// ============================================================================

/** Minimum executions before profiler starts recommending */
const MIN_EXECUTIONS_FOR_RECOMMENDATION = 3;

export class AgentProfiler {
  /** Profiles keyed by `${agentId}:${taskType}` */
  private profiles: Map<string, AgentProfile> = new Map();
  /** Recent outcomes for audit */
  private recentOutcomes: AgentOutcome[] = [];
  private readonly maxRecentOutcomes = 200;

  /**
   * Record an agent execution outcome
   */
  recordOutcome(outcome: AgentOutcome): void {
    const key = `${outcome.agentId}:${outcome.taskType}`;

    let profile = this.profiles.get(key);
    if (!profile) {
      profile = {
        agentId: outcome.agentId,
        agentName: outcome.agentName,
        taskType: outcome.taskType,
        successCount: 0,
        failureCount: 0,
        totalExecutions: 0,
        avgScore: 0,
        avgDurationMs: 0,
        avgCostUSD: 0,
        wilsonScore: 0,
        lastUpdated: Date.now(),
      };
      this.profiles.set(key, profile);
    }

    // Update counts
    profile.totalExecutions++;
    if (outcome.success) {
      profile.successCount++;
    } else {
      profile.failureCount++;
    }

    // Update running averages
    const n = profile.totalExecutions;
    profile.avgScore = profile.avgScore + (outcome.verificationScore - profile.avgScore) / n;
    profile.avgDurationMs = profile.avgDurationMs + (outcome.durationMs - profile.avgDurationMs) / n;
    profile.avgCostUSD = profile.avgCostUSD + (outcome.costUSD - profile.avgCostUSD) / n;

    // Recalculate Wilson score
    profile.wilsonScore = wilsonScoreLowerBound(
      profile.successCount,
      profile.totalExecutions
    );

    profile.lastUpdated = Date.now();

    // Store recent outcome
    this.recentOutcomes.push(outcome);
    if (this.recentOutcomes.length > this.maxRecentOutcomes) {
      this.recentOutcomes = this.recentOutcomes.slice(-Math.floor(this.maxRecentOutcomes / 2));
    }

    logger.debug(`Recorded outcome for ${outcome.agentId}:${outcome.taskType}`, {
      success: outcome.success,
      score: outcome.verificationScore,
      totalExecutions: profile.totalExecutions,
      wilsonScore: profile.wilsonScore.toFixed(3),
    });
  }

  /**
   * Recommend the best agent for a task type
   *
   * Returns null if insufficient data (cold start)
   */
  recommendAgent(taskType: string): AgentRecommendation | null {
    const candidates: AgentProfile[] = [];

    for (const profile of this.profiles.values()) {
      if (profile.taskType === taskType && profile.totalExecutions >= MIN_EXECUTIONS_FOR_RECOMMENDATION) {
        candidates.push(profile);
      }
    }

    if (candidates.length === 0) {
      logger.debug(`No recommendation for task type '${taskType}' (cold start)`);
      return null;
    }

    // Sort by Wilson score (descending)
    candidates.sort((a, b) => b.wilsonScore - a.wilsonScore);

    const best = candidates[0];

    const confidence: AgentRecommendation['confidence'] =
      best.totalExecutions >= 10 ? 'high' :
      best.totalExecutions >= 5 ? 'medium' : 'low';

    logger.info(`Recommending ${best.agentName} for ${taskType} (Wilson: ${best.wilsonScore.toFixed(3)}, n=${best.totalExecutions})`);

    return {
      agentId: best.agentId,
      agentName: best.agentName,
      wilsonScore: best.wilsonScore,
      totalExecutions: best.totalExecutions,
      avgScore: best.avgScore,
      confidence,
    };
  }

  /**
   * Get profile for a specific agent and task type
   */
  getProfile(agentId: string, taskType: string): AgentProfile | undefined {
    return this.profiles.get(`${agentId}:${taskType}`);
  }

  /**
   * Get all profiles
   */
  getAllProfiles(): AgentProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Get leaderboard for a task type
   */
  getLeaderboard(taskType: string): AgentProfile[] {
    return Array.from(this.profiles.values())
      .filter(p => p.taskType === taskType)
      .sort((a, b) => b.wilsonScore - a.wilsonScore);
  }

  /**
   * Export profiles for persistence
   */
  exportProfiles(): AgentProfile[] {
    return this.getAllProfiles();
  }

  /**
   * Import profiles from persistence
   */
  importProfiles(profiles: AgentProfile[]): void {
    for (const profile of profiles) {
      const key = `${profile.agentId}:${profile.taskType}`;
      const existing = this.profiles.get(key);
      if (!existing || profile.lastUpdated > existing.lastUpdated) {
        this.profiles.set(key, profile);
      }
    }
    logger.info(`Imported ${profiles.length} profiles`);
  }

  /**
   * Reset all profiles (for testing)
   */
  reset(): void {
    this.profiles.clear();
    this.recentOutcomes = [];
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: AgentProfiler | null = null;

export function getAgentProfiler(): AgentProfiler {
  if (!instance) {
    instance = new AgentProfiler();
  }
  return instance;
}
