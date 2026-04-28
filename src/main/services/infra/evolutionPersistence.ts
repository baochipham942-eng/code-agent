// ============================================================================
// Evolution Persistence Service
// Persists Gen8 self-evolution data (strategies, patterns) to local and cloud
// ============================================================================

import { getDatabase } from '../core';
import {
  getSupabase,
  isSupabaseInitialized,
} from './supabaseService';
import { getAuthService } from '../auth/authService';
import { createLogger } from './logger';

const logger = createLogger('EvolutionPersistence');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface Strategy {
  id: string;
  name: string;
  description: string;
  steps: string[];
  successRate: number;
  usageCount: number;
  lastUsed: number;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  userId?: string;
  projectPath?: string;
}

export interface StrategyFeedback {
  id: string;
  strategyId: string;
  success: boolean;
  duration: number;
  notes?: string;
  createdAt: number;
}

export interface LearnedPattern {
  id: string;
  name: string;
  type: 'success' | 'failure' | 'optimization' | 'anti_pattern';
  context: string;
  pattern: string;
  solution?: string;
  confidence: number;
  occurrences: number;
  lastSeen: number;
  createdAt: number;
  updatedAt: number;
  tags: string[];
  userId?: string;
  projectPath?: string;
}

// ----------------------------------------------------------------------------
// Evolution Persistence Service
// ----------------------------------------------------------------------------

class EvolutionPersistenceService {
  private initialized: boolean = false;
  private strategies: Map<string, Strategy> = new Map();
  private patterns: Map<string, LearnedPattern> = new Map();
  private feedbackHistory: StrategyFeedback[] = [];
  private syncInProgress: boolean = false;

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    logger.info(' Initializing...');

    // Load from local SQLite
    await this.loadFromLocal();

    // Try to sync with cloud
    await this.syncFromCloud();

    this.initialized = true;
    logger.info(
      `Initialized with ${this.strategies.size} strategies, ${this.patterns.size} patterns`
    );
  }

  // --------------------------------------------------------------------------
  // Strategy Operations
  // --------------------------------------------------------------------------

  async createStrategy(strategy: Omit<Strategy, 'id' | 'createdAt' | 'updatedAt'>): Promise<Strategy> {
    const id = `strategy_${Date.now()}_${crypto.randomUUID().split('-')[0]}`;
    const now = Date.now();

    const newStrategy: Strategy = {
      ...strategy,
      id,
      createdAt: now,
      updatedAt: now,
      userId: this.getCurrentUserId(),
    };

    this.strategies.set(id, newStrategy);

    // Persist locally
    await this.saveStrategyLocal(newStrategy);

    // Sync to cloud (non-blocking)
    this.syncStrategyToCloud(newStrategy).catch((err) =>
      logger.error(' Cloud sync failed:', err)
    );

    return newStrategy;
  }

  async updateStrategy(id: string, updates: Partial<Strategy>): Promise<Strategy | null> {
    const strategy = this.strategies.get(id);
    if (!strategy) return null;

    const updatedStrategy: Strategy = {
      ...strategy,
      ...updates,
      id, // Keep original ID
      updatedAt: Date.now(),
    };

    this.strategies.set(id, updatedStrategy);

    // Persist locally
    await this.saveStrategyLocal(updatedStrategy);

    // Sync to cloud (non-blocking)
    this.syncStrategyToCloud(updatedStrategy).catch((err) =>
      logger.error(' Cloud sync failed:', err)
    );

    return updatedStrategy;
  }

  async deleteStrategy(id: string): Promise<boolean> {
    if (!this.strategies.has(id)) return false;

    this.strategies.delete(id);

    // Delete locally
    await this.deleteStrategyLocal(id);

    // Delete from cloud (non-blocking)
    this.deleteStrategyFromCloud(id).catch((err) =>
      logger.error(' Cloud delete failed:', err)
    );

    return true;
  }

  getStrategy(id: string): Strategy | undefined {
    return this.strategies.get(id);
  }

  getAllStrategies(): Strategy[] {
    return Array.from(this.strategies.values());
  }

  getStrategiesByTags(tags: string[]): Strategy[] {
    return this.getAllStrategies().filter((s) =>
      tags.some((t) => s.tags.includes(t))
    );
  }

  // --------------------------------------------------------------------------
  // Feedback Operations
  // --------------------------------------------------------------------------

  async recordFeedback(feedback: Omit<StrategyFeedback, 'id' | 'createdAt'>): Promise<void> {
    const id = `feedback_${Date.now()}_${crypto.randomUUID().split('-')[0]}`;

    const newFeedback: StrategyFeedback = {
      ...feedback,
      id,
      createdAt: Date.now(),
    };

    this.feedbackHistory.push(newFeedback);

    // Update strategy metrics
    const strategy = this.strategies.get(feedback.strategyId);
    if (strategy) {
      strategy.usageCount++;
      strategy.lastUsed = Date.now();

      // Recalculate success rate
      const strategyFeedback = this.feedbackHistory.filter(
        (f) => f.strategyId === feedback.strategyId
      );
      const successCount = strategyFeedback.filter((f) => f.success).length;
      strategy.successRate =
        strategyFeedback.length > 0
          ? (successCount / strategyFeedback.length) * 100
          : 0;

      await this.updateStrategy(strategy.id, strategy);
    }

    // Persist feedback locally
    await this.saveFeedbackLocal(newFeedback);
  }

  getFeedbackForStrategy(strategyId: string): StrategyFeedback[] {
    return this.feedbackHistory.filter((f) => f.strategyId === strategyId);
  }

  // --------------------------------------------------------------------------
  // Pattern Operations
  // --------------------------------------------------------------------------

  async createPattern(pattern: Omit<LearnedPattern, 'id' | 'createdAt' | 'updatedAt'>): Promise<LearnedPattern> {
    const id = `pattern_${Date.now()}_${crypto.randomUUID().split('-')[0]}`;
    const now = Date.now();

    const newPattern: LearnedPattern = {
      ...pattern,
      id,
      createdAt: now,
      updatedAt: now,
      userId: this.getCurrentUserId(),
    };

    this.patterns.set(id, newPattern);

    // Persist locally
    await this.savePatternLocal(newPattern);

    // Sync to cloud (non-blocking)
    this.syncPatternToCloud(newPattern).catch((err) =>
      logger.error(' Cloud sync failed:', err)
    );

    return newPattern;
  }

  async updatePattern(id: string, updates: Partial<LearnedPattern>): Promise<LearnedPattern | null> {
    const pattern = this.patterns.get(id);
    if (!pattern) return null;

    const updatedPattern: LearnedPattern = {
      ...pattern,
      ...updates,
      id, // Keep original ID
      updatedAt: Date.now(),
    };

    this.patterns.set(id, updatedPattern);

    // Persist locally
    await this.savePatternLocal(updatedPattern);

    // Sync to cloud (non-blocking)
    this.syncPatternToCloud(updatedPattern).catch((err) =>
      logger.error(' Cloud sync failed:', err)
    );

    return updatedPattern;
  }

  async deletePattern(id: string): Promise<boolean> {
    if (!this.patterns.has(id)) return false;

    this.patterns.delete(id);

    // Delete locally
    await this.deletePatternLocal(id);

    // Delete from cloud (non-blocking)
    this.deletePatternFromCloud(id).catch((err) =>
      logger.error(' Cloud delete failed:', err)
    );

    return true;
  }

  getPattern(id: string): LearnedPattern | undefined {
    return this.patterns.get(id);
  }

  getAllPatterns(): LearnedPattern[] {
    return Array.from(this.patterns.values());
  }

  getPatternsByType(type: LearnedPattern['type']): LearnedPattern[] {
    return this.getAllPatterns().filter((p) => p.type === type);
  }

  getReliablePatterns(minConfidence = 0.7): LearnedPattern[] {
    return this.getAllPatterns().filter((p) => p.confidence >= minConfidence);
  }

  // --------------------------------------------------------------------------
  // Local Persistence (SQLite)
  // --------------------------------------------------------------------------

  private async loadFromLocal(): Promise<void> {
    const db = getDatabase();

    try {
      // Load strategies using preferences API
      const strategiesData = db.getPreference<Strategy[]>('evolution_strategies');
      if (strategiesData && Array.isArray(strategiesData)) {
        for (const strategy of strategiesData) {
          this.strategies.set(strategy.id, strategy);
        }
      }

      // Load patterns
      const patternsData = db.getPreference<LearnedPattern[]>('evolution_patterns');
      if (patternsData && Array.isArray(patternsData)) {
        for (const pattern of patternsData) {
          this.patterns.set(pattern.id, pattern);
        }
      }

      // Load feedback
      const feedbackData = db.getPreference<StrategyFeedback[]>('evolution_feedback');
      if (feedbackData && Array.isArray(feedbackData)) {
        this.feedbackHistory = feedbackData;
      }

      logger.info(' Loaded from local storage');
    } catch (error) {
      logger.error(' Failed to load from local:', error);
    }
  }

  private async saveStrategyLocal(_strategy: Strategy): Promise<void> {
    const db = getDatabase();
    try {
      const allStrategies = Array.from(this.strategies.values());
      db.setPreference('evolution_strategies', allStrategies);
    } catch (error) {
      logger.error(' Failed to save strategy locally:', error);
    }
  }

  private async deleteStrategyLocal(_id: string): Promise<void> {
    const db = getDatabase();
    try {
      const allStrategies = Array.from(this.strategies.values());
      db.setPreference('evolution_strategies', allStrategies);
    } catch (error) {
      logger.error(' Failed to delete strategy locally:', error);
    }
  }

  private async savePatternLocal(_pattern: LearnedPattern): Promise<void> {
    const db = getDatabase();
    try {
      const allPatterns = Array.from(this.patterns.values());
      db.setPreference('evolution_patterns', allPatterns);
    } catch (error) {
      logger.error(' Failed to save pattern locally:', error);
    }
  }

  private async deletePatternLocal(_id: string): Promise<void> {
    const db = getDatabase();
    try {
      const allPatterns = Array.from(this.patterns.values());
      db.setPreference('evolution_patterns', allPatterns);
    } catch (error) {
      logger.error(' Failed to delete pattern locally:', error);
    }
  }

  private async saveFeedbackLocal(_feedback: StrategyFeedback): Promise<void> {
    const db = getDatabase();
    try {
      db.setPreference('evolution_feedback', this.feedbackHistory);
    } catch (error) {
      logger.error(' Failed to save feedback locally:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Cloud Sync (Supabase)
  // --------------------------------------------------------------------------

  private getCurrentUserId(): string | undefined {
    try {
      const authService = getAuthService();
      return authService.getCurrentUser()?.id;
    } catch {
      return undefined;
    }
  }

  private async syncFromCloud(): Promise<void> {
    if (!isSupabaseInitialized()) return;

    const userId = this.getCurrentUserId();
    if (!userId) return;

    if (this.syncInProgress) return;
    this.syncInProgress = true;

    try {
      const supabase = getSupabase();

      // Sync strategies
      const { data: cloudStrategies, error: strategyError } = await supabase.from('evolution_strategies')
        .select('*')
        .eq('user_id', userId);

      if (!strategyError && cloudStrategies) {
        for (const cloudStrategy of cloudStrategies) {
          const localStrategy = this.strategies.get(cloudStrategy.id);

          // Cloud wins if newer or local doesn't exist
          // Note: cloudStrategy.updated_at is ISO string, localStrategy.updatedAt is ms number
          // (audit B5: previous `as any` masked this string-vs-number comparison bug)
          const cloudUpdatedAtMs = new Date(cloudStrategy.updated_at).getTime();
          if (!localStrategy || cloudUpdatedAtMs > localStrategy.updatedAt) {
            const strategy: Strategy = {
              id: cloudStrategy.id,
              name: cloudStrategy.name,
              description: cloudStrategy.description,
              steps: cloudStrategy.steps,
              successRate: cloudStrategy.success_rate,
              usageCount: cloudStrategy.usage_count,
              lastUsed: cloudStrategy.last_used,
              tags: cloudStrategy.tags || [],
              createdAt: new Date(cloudStrategy.created_at).getTime(),
              updatedAt: cloudUpdatedAtMs,
              userId: cloudStrategy.user_id,
              projectPath: cloudStrategy.project_path ?? undefined,
            };
            this.strategies.set(strategy.id, strategy);
          }
        }
      }

      // Sync patterns
      const { data: cloudPatterns, error: patternError } = await supabase.from('evolution_patterns')
        .select('*')
        .eq('user_id', userId);

      if (!patternError && cloudPatterns) {
        for (const cloudPattern of cloudPatterns) {
          const localPattern = this.patterns.get(cloudPattern.id);

          // (audit B5: previous `as any` masked string-vs-number comparison bug)
          const cloudUpdatedAtMs = new Date(cloudPattern.updated_at).getTime();
          if (!localPattern || cloudUpdatedAtMs > localPattern.updatedAt) {
            const pattern: LearnedPattern = {
              id: cloudPattern.id,
              name: cloudPattern.name,
              type: cloudPattern.type,
              context: cloudPattern.context,
              pattern: cloudPattern.pattern,
              solution: cloudPattern.solution ?? undefined,
              confidence: cloudPattern.confidence,
              occurrences: cloudPattern.occurrences,
              lastSeen: cloudPattern.last_seen,
              createdAt: new Date(cloudPattern.created_at).getTime(),
              updatedAt: cloudUpdatedAtMs,
              tags: cloudPattern.tags || [],
              userId: cloudPattern.user_id,
              projectPath: cloudPattern.project_path ?? undefined,
            };
            this.patterns.set(pattern.id, pattern);
          }
        }
      }

      logger.info(' Synced from cloud');
    } catch (error) {
      logger.error(' Cloud sync failed:', error);
    } finally {
      this.syncInProgress = false;
    }
  }

  private async syncStrategyToCloud(strategy: Strategy): Promise<void> {
    if (!isSupabaseInitialized()) return;

    const userId = this.getCurrentUserId();
    if (!userId) return;

    try {
      const supabase = getSupabase();

      await supabase.from('evolution_strategies').upsert({
        id: strategy.id,
        user_id: userId,
        name: strategy.name,
        description: strategy.description,
        steps: strategy.steps,
        success_rate: strategy.successRate,
        usage_count: strategy.usageCount,
        last_used: strategy.lastUsed,
        tags: strategy.tags,
        project_path: strategy.projectPath,
        created_at: new Date(strategy.createdAt).toISOString(),
        updated_at: new Date(strategy.updatedAt).toISOString(),
      });
    } catch (error) {
      logger.error(' Failed to sync strategy to cloud:', error);
    }
  }

  private async deleteStrategyFromCloud(id: string): Promise<void> {
    if (!isSupabaseInitialized()) return;

    const userId = this.getCurrentUserId();
    if (!userId) return;

    try {
      const supabase = getSupabase();

      await supabase.from('evolution_strategies').delete().eq('id', id).eq('user_id', userId);
    } catch (error) {
      logger.error(' Failed to delete strategy from cloud:', error);
    }
  }

  private async syncPatternToCloud(pattern: LearnedPattern): Promise<void> {
    if (!isSupabaseInitialized()) return;

    const userId = this.getCurrentUserId();
    if (!userId) return;

    try {
      const supabase = getSupabase();

      await supabase.from('evolution_patterns').upsert({
        id: pattern.id,
        user_id: userId,
        name: pattern.name,
        type: pattern.type,
        context: pattern.context,
        pattern: pattern.pattern,
        solution: pattern.solution,
        confidence: pattern.confidence,
        occurrences: pattern.occurrences,
        last_seen: pattern.lastSeen,
        tags: pattern.tags,
        project_path: pattern.projectPath,
        created_at: new Date(pattern.createdAt).toISOString(),
        updated_at: new Date(pattern.updatedAt).toISOString(),
      });
    } catch (error) {
      logger.error(' Failed to sync pattern to cloud:', error);
    }
  }

  private async deletePatternFromCloud(id: string): Promise<void> {
    if (!isSupabaseInitialized()) return;

    const userId = this.getCurrentUserId();
    if (!userId) return;

    try {
      const supabase = getSupabase();

      await supabase.from('evolution_patterns').delete().eq('id', id).eq('user_id', userId);
    } catch (error) {
      logger.error(' Failed to delete pattern from cloud:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Force Sync
  // --------------------------------------------------------------------------

  async forceSyncToCloud(): Promise<void> {
    if (!isSupabaseInitialized()) return;

    logger.info(' Force syncing to cloud...');

    // Sync all strategies
    for (const strategy of this.strategies.values()) {
      await this.syncStrategyToCloud(strategy);
    }

    // Sync all patterns
    for (const pattern of this.patterns.values()) {
      await this.syncPatternToCloud(pattern);
    }

    logger.info(' Force sync complete');
  }

  async forceSyncFromCloud(): Promise<void> {
    await this.syncFromCloud();
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let evolutionPersistenceInstance: EvolutionPersistenceService | null = null;

export function getEvolutionPersistence(): EvolutionPersistenceService {
  if (!evolutionPersistenceInstance) {
    evolutionPersistenceInstance = new EvolutionPersistenceService();
  }
  return evolutionPersistenceInstance;
}

export async function initEvolutionPersistence(): Promise<EvolutionPersistenceService> {
  const service = getEvolutionPersistence();
  await service.initialize();
  return service;
}
