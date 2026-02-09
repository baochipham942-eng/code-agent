// ============================================================================
// Cost Report - Generate usage statistics and cost reports
// ============================================================================
// Provides token usage tracking and cost estimation:
// - Per-session usage statistics
// - Aggregate reports (daily, weekly, monthly)
// - Cost estimation by model/provider
// - Usage trend analysis
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { MODEL_PRICING_PER_1M, DEFAULT_MODEL } from '../../shared/constants';
import {
  SessionLocalCache,
  CachedSession,
  CachedMessage,
  getDefaultCache,
} from './localCache';
import { estimateTokens, estimateMessageTokens, Message } from '../context/tokenEstimator';

const logger = createLogger('CostReport');

/**
 * Model pricing (per 1K tokens)
 */
export interface ModelPricing {
  /** Model identifier */
  model: string;
  /** Input token cost (per 1K) */
  inputCostPer1K: number;
  /** Output token cost (per 1K) */
  outputCostPer1K: number;
  /** Currency */
  currency: string;
}

/**
 * Default pricing for common models (derived from shared constants)
 */
export const DEFAULT_PRICING: ModelPricing[] = Object.entries(MODEL_PRICING_PER_1M)
  .filter(([k]) => k !== 'default')
  .map(([model, p]) => ({
    model,
    inputCostPer1K: p.input / 1000,
    outputCostPer1K: p.output / 1000,
    currency: 'USD' as const,
  }));

/**
 * Token usage breakdown
 */
export interface TokenUsage {
  /** Input tokens (user + system messages) */
  inputTokens: number;
  /** Output tokens (assistant messages) */
  outputTokens: number;
  /** Total tokens */
  totalTokens: number;
}

/**
 * Cost breakdown
 */
export interface CostBreakdown {
  /** Input cost */
  inputCost: number;
  /** Output cost */
  outputCost: number;
  /** Total cost */
  totalCost: number;
  /** Currency */
  currency: string;
  /** Model used for calculation */
  model: string;
}

/**
 * Session usage report
 */
export interface SessionReport {
  /** Session ID */
  sessionId: string;
  /** Session start time */
  startTime: number;
  /** Session end time (last activity) */
  endTime: number;
  /** Duration in milliseconds */
  duration: number;
  /** Number of messages */
  messageCount: number;
  /** Token usage */
  tokenUsage: TokenUsage;
  /** Estimated cost */
  cost: CostBreakdown;
  /** Messages by role */
  messagesByRole: Record<string, number>;
  /** Average tokens per message */
  avgTokensPerMessage: number;
}

/**
 * Aggregate report for time period
 */
export interface AggregateReport {
  /** Period start */
  periodStart: Date;
  /** Period end */
  periodEnd: Date;
  /** Number of sessions */
  sessionCount: number;
  /** Total messages */
  totalMessages: number;
  /** Token usage */
  tokenUsage: TokenUsage;
  /** Total cost */
  totalCost: CostBreakdown;
  /** Average per session */
  avgPerSession: {
    messages: number;
    tokens: number;
    cost: number;
  };
  /** Daily breakdown */
  dailyBreakdown?: DailyUsage[];
}

/**
 * Daily usage data
 */
export interface DailyUsage {
  /** Date string (YYYY-MM-DD) */
  date: string;
  /** Number of sessions */
  sessionCount: number;
  /** Message count */
  messageCount: number;
  /** Token usage */
  tokenUsage: TokenUsage;
  /** Cost */
  cost: number;
}

/**
 * Usage trend
 */
export interface UsageTrend {
  /** Trend direction */
  direction: 'up' | 'down' | 'stable';
  /** Percentage change */
  percentChange: number;
  /** Comparison period */
  comparisonPeriod: string;
}

/**
 * Get pricing for a model
 */
export function getModelPricing(
  model: string,
  customPricing?: ModelPricing[]
): ModelPricing | undefined {
  const allPricing = [...(customPricing || []), ...DEFAULT_PRICING];
  return allPricing.find(p =>
    model.toLowerCase().includes(p.model.toLowerCase())
  );
}

/**
 * Calculate token usage from messages
 */
export function calculateTokenUsage(messages: CachedMessage[]): TokenUsage {
  let inputTokens = 0;
  let outputTokens = 0;

  for (const msg of messages) {
    const tokens = msg.tokens || estimateTokens(msg.content);

    if (msg.role === 'assistant') {
      outputTokens += tokens;
    } else {
      inputTokens += tokens;
    }
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

/**
 * Calculate cost from token usage
 */
export function calculateCost(
  usage: TokenUsage,
  model: string,
  customPricing?: ModelPricing[]
): CostBreakdown {
  const pricing = getModelPricing(model, customPricing);

  if (!pricing) {
    // Default to GPT-4 pricing if model not found
    return {
      inputCost: (usage.inputTokens / 1000) * 0.03,
      outputCost: (usage.outputTokens / 1000) * 0.06,
      totalCost: (usage.inputTokens / 1000) * 0.03 + (usage.outputTokens / 1000) * 0.06,
      currency: 'USD',
      model: 'unknown (using gpt-4 pricing)',
    };
  }

  const inputCost = (usage.inputTokens / 1000) * pricing.inputCostPer1K;
  const outputCost = (usage.outputTokens / 1000) * pricing.outputCostPer1K;

  return {
    inputCost,
    outputCost,
    totalCost: inputCost + outputCost,
    currency: pricing.currency,
    model: pricing.model,
  };
}

/**
 * Generate report for a single session
 */
export function generateSessionReport(
  session: CachedSession,
  model: string = DEFAULT_MODEL,
  customPricing?: ModelPricing[]
): SessionReport {
  const tokenUsage = calculateTokenUsage(session.messages);
  const cost = calculateCost(tokenUsage, model, customPricing);

  // Count messages by role
  const messagesByRole: Record<string, number> = {};
  for (const msg of session.messages) {
    messagesByRole[msg.role] = (messagesByRole[msg.role] || 0) + 1;
  }

  return {
    sessionId: session.sessionId,
    startTime: session.startedAt,
    endTime: session.lastActivityAt,
    duration: session.lastActivityAt - session.startedAt,
    messageCount: session.messages.length,
    tokenUsage,
    cost,
    messagesByRole,
    avgTokensPerMessage: session.messages.length > 0
      ? tokenUsage.totalTokens / session.messages.length
      : 0,
  };
}

/**
 * Generate aggregate report for time period
 */
export function generateAggregateReport(
  sessions: CachedSession[],
  periodStart: Date,
  periodEnd: Date,
  model: string = DEFAULT_MODEL,
  options: {
    includeDailyBreakdown?: boolean;
    customPricing?: ModelPricing[];
  } = {}
): AggregateReport {
  const { includeDailyBreakdown = false, customPricing } = options;

  // Filter sessions by time period
  const periodSessions = sessions.filter(s =>
    s.startedAt >= periodStart.getTime() && s.startedAt <= periodEnd.getTime()
  );

  // Calculate totals
  let totalMessages = 0;
  const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  const dailyData: Map<string, DailyUsage> = new Map();

  for (const session of periodSessions) {
    const usage = calculateTokenUsage(session.messages);
    totalMessages += session.messages.length;
    totalUsage.inputTokens += usage.inputTokens;
    totalUsage.outputTokens += usage.outputTokens;
    totalUsage.totalTokens += usage.totalTokens;

    // Daily breakdown
    if (includeDailyBreakdown) {
      const dateStr = new Date(session.startedAt).toISOString().split('T')[0];
      const existing = dailyData.get(dateStr) || {
        date: dateStr,
        sessionCount: 0,
        messageCount: 0,
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        cost: 0,
      };

      existing.sessionCount++;
      existing.messageCount += session.messages.length;
      existing.tokenUsage.inputTokens += usage.inputTokens;
      existing.tokenUsage.outputTokens += usage.outputTokens;
      existing.tokenUsage.totalTokens += usage.totalTokens;

      const dayCost = calculateCost(usage, model, customPricing);
      existing.cost += dayCost.totalCost;

      dailyData.set(dateStr, existing);
    }
  }

  const totalCost = calculateCost(totalUsage, model, customPricing);

  return {
    periodStart,
    periodEnd,
    sessionCount: periodSessions.length,
    totalMessages,
    tokenUsage: totalUsage,
    totalCost,
    avgPerSession: {
      messages: periodSessions.length > 0 ? totalMessages / periodSessions.length : 0,
      tokens: periodSessions.length > 0 ? totalUsage.totalTokens / periodSessions.length : 0,
      cost: periodSessions.length > 0 ? totalCost.totalCost / periodSessions.length : 0,
    },
    dailyBreakdown: includeDailyBreakdown
      ? Array.from(dailyData.values()).sort((a, b) => a.date.localeCompare(b.date))
      : undefined,
  };
}

/**
 * Calculate usage trend comparing two periods
 */
export function calculateTrend(
  currentPeriod: AggregateReport,
  previousPeriod: AggregateReport
): UsageTrend {
  const currentTotal = currentPeriod.tokenUsage.totalTokens;
  const previousTotal = previousPeriod.tokenUsage.totalTokens;

  if (previousTotal === 0) {
    return {
      direction: currentTotal > 0 ? 'up' : 'stable',
      percentChange: currentTotal > 0 ? 100 : 0,
      comparisonPeriod: 'previous period (no data)',
    };
  }

  const percentChange = ((currentTotal - previousTotal) / previousTotal) * 100;

  let direction: 'up' | 'down' | 'stable';
  if (percentChange > 5) {
    direction = 'up';
  } else if (percentChange < -5) {
    direction = 'down';
  } else {
    direction = 'stable';
  }

  return {
    direction,
    percentChange: Math.round(percentChange * 10) / 10,
    comparisonPeriod: `${previousPeriod.periodStart.toLocaleDateString()} - ${previousPeriod.periodEnd.toLocaleDateString()}`,
  };
}

/**
 * Format cost for display
 */
export function formatCost(cost: CostBreakdown): string {
  const symbol = cost.currency === 'USD' ? '$' : cost.currency;
  return `${symbol}${cost.totalCost.toFixed(4)}`;
}

/**
 * Format token count for display
 */
export function formatTokens(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(2)}M`;
  } else if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
}

/**
 * Cost Report Manager class
 */
export class CostReportManager {
  private cache: SessionLocalCache;
  private defaultModel: string;
  private customPricing?: ModelPricing[];

  constructor(options: {
    cache?: SessionLocalCache;
    defaultModel?: string;
    customPricing?: ModelPricing[];
  } = {}) {
    this.cache = options.cache || getDefaultCache();
    this.defaultModel = options.defaultModel || DEFAULT_MODEL;
    this.customPricing = options.customPricing;
  }

  /**
   * Generate report for a session
   */
  sessionReport(sessionId: string): SessionReport | null {
    const session = this.cache.getSession(sessionId);
    if (!session) return null;
    return generateSessionReport(session, this.defaultModel, this.customPricing);
  }

  /**
   * Generate daily report
   */
  dailyReport(date: Date = new Date()): AggregateReport {
    const startOfDay = new Date(date);
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date(date);
    endOfDay.setHours(23, 59, 59, 999);

    const sessions = this.getAllSessions();
    return generateAggregateReport(sessions, startOfDay, endOfDay, this.defaultModel, {
      customPricing: this.customPricing,
    });
  }

  /**
   * Generate weekly report
   */
  weeklyReport(weekStart?: Date): AggregateReport {
    const start = weekStart || this.getWeekStart(new Date());
    const end = new Date(start);
    end.setDate(end.getDate() + 6);
    end.setHours(23, 59, 59, 999);

    const sessions = this.getAllSessions();
    return generateAggregateReport(sessions, start, end, this.defaultModel, {
      includeDailyBreakdown: true,
      customPricing: this.customPricing,
    });
  }

  /**
   * Generate monthly report
   */
  monthlyReport(year: number, month: number): AggregateReport {
    const start = new Date(year, month - 1, 1);
    const end = new Date(year, month, 0, 23, 59, 59, 999);

    const sessions = this.getAllSessions();
    return generateAggregateReport(sessions, start, end, this.defaultModel, {
      includeDailyBreakdown: true,
      customPricing: this.customPricing,
    });
  }

  /**
   * Get usage trend
   */
  getTrend(days: number = 7): UsageTrend {
    const now = new Date();
    const currentEnd = new Date(now);
    currentEnd.setHours(23, 59, 59, 999);

    const currentStart = new Date(currentEnd);
    currentStart.setDate(currentStart.getDate() - days + 1);
    currentStart.setHours(0, 0, 0, 0);

    const previousEnd = new Date(currentStart);
    previousEnd.setDate(previousEnd.getDate() - 1);
    previousEnd.setHours(23, 59, 59, 999);

    const previousStart = new Date(previousEnd);
    previousStart.setDate(previousStart.getDate() - days + 1);
    previousStart.setHours(0, 0, 0, 0);

    const sessions = this.getAllSessions();
    const currentReport = generateAggregateReport(sessions, currentStart, currentEnd, this.defaultModel);
    const previousReport = generateAggregateReport(sessions, previousStart, previousEnd, this.defaultModel);

    return calculateTrend(currentReport, previousReport);
  }

  /**
   * Get total usage stats
   */
  getTotalUsage(): {
    totalSessions: number;
    totalMessages: number;
    tokenUsage: TokenUsage;
    estimatedCost: CostBreakdown;
  } {
    const sessions = this.getAllSessions();
    let totalMessages = 0;
    const totalUsage: TokenUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };

    for (const session of sessions) {
      const usage = calculateTokenUsage(session.messages);
      totalMessages += session.messages.length;
      totalUsage.inputTokens += usage.inputTokens;
      totalUsage.outputTokens += usage.outputTokens;
      totalUsage.totalTokens += usage.totalTokens;
    }

    return {
      totalSessions: sessions.length,
      totalMessages,
      tokenUsage: totalUsage,
      estimatedCost: calculateCost(totalUsage, this.defaultModel, this.customPricing),
    };
  }

  /**
   * Get all sessions from cache
   */
  private getAllSessions(): CachedSession[] {
    const sessionIds = this.cache.getSessionIds();
    return sessionIds
      .map(id => this.cache.getSession(id))
      .filter((s): s is CachedSession => s !== undefined);
  }

  /**
   * Get start of week (Monday)
   */
  private getWeekStart(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Set custom pricing
   */
  setPricing(pricing: ModelPricing[]): void {
    this.customPricing = pricing;
  }

  /**
   * Set default model
   */
  setDefaultModel(model: string): void {
    this.defaultModel = model;
  }
}

/**
 * Default cost report manager instance
 */
let defaultCostReportManager: CostReportManager | null = null;

export function getDefaultCostReportManager(): CostReportManager {
  if (!defaultCostReportManager) {
    defaultCostReportManager = new CostReportManager();
  }
  return defaultCostReportManager;
}
