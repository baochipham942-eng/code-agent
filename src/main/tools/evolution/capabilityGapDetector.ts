// ============================================================================
// Capability Gap Detector - Identify and track missing agent capabilities
// Gen 8: Self-Evolution capability
// ============================================================================

import { getEvolutionPersistence } from '../../services';
import { createLogger } from '../../services/infra/logger';
import type { ToolExecution, SessionAnalysis } from './metaLearningLoop';

const logger = createLogger('CapabilityGapDetector');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface CapabilityGap {
  id: string;
  name: string;
  description: string;
  category: GapCategory;
  severity: 'low' | 'medium' | 'high' | 'critical';
  detectedAt: number;
  lastSeenAt: number;
  occurrences: number;
  status: 'open' | 'in_progress' | 'resolved';
  resolution?: string;
  suggestedActions: string[];
  relatedErrors: string[];
  relatedTools: string[];
}

export type GapCategory =
  | 'missing_tool'      // A tool doesn't exist for this task
  | 'tool_limitation'   // Existing tool can't handle this case
  | 'knowledge_gap'     // Lacks domain knowledge
  | 'strategy_gap'      // No effective strategy for task type
  | 'integration_gap'   // Can't connect to external service
  | 'permission_gap';   // Lacks required permissions

export interface GapAnalysisResult {
  newGaps: CapabilityGap[];
  updatedGaps: CapabilityGap[];
  insights: string[];
  prioritizedActions: string[];
}

export interface GapStatistics {
  totalGaps: number;
  byCategory: Record<GapCategory, number>;
  bySeverity: Record<string, number>;
  byStatus: Record<string, number>;
  topPriorities: CapabilityGap[];
}

// ----------------------------------------------------------------------------
// Error Pattern Matchers
// ----------------------------------------------------------------------------

interface ErrorPattern {
  regex: RegExp;
  category: GapCategory;
  severity: CapabilityGap['severity'];
  name: string;
  description: string;
  suggestedActions: string[];
}

const ERROR_PATTERNS: ErrorPattern[] = [
  {
    regex: /tool\s+(not\s+found|doesn't\s+exist|unknown)/i,
    category: 'missing_tool',
    severity: 'medium',
    name: 'Missing tool requested',
    description: 'User or agent requested a tool that does not exist',
    suggestedActions: [
      'Consider creating a new tool using tool_create',
      'Find an alternative existing tool',
      'Break task into steps using existing tools',
    ],
  },
  {
    regex: /permission\s+denied|access\s+denied|unauthorized/i,
    category: 'permission_gap',
    severity: 'high',
    name: 'Permission denied',
    description: 'Operation blocked due to insufficient permissions',
    suggestedActions: [
      'Request user to grant necessary permissions',
      'Use alternative approach that works within permissions',
      'Document permission requirements for future reference',
    ],
  },
  {
    regex: /cannot\s+connect|connection\s+(failed|refused|timeout)/i,
    category: 'integration_gap',
    severity: 'medium',
    name: 'Connection failure',
    description: 'Cannot connect to external service or resource',
    suggestedActions: [
      'Check network connectivity',
      'Verify service credentials and configuration',
      'Implement retry logic or fallback',
    ],
  },
  {
    regex: /not\s+supported|unsupported|cannot\s+handle|can't\s+process/i,
    category: 'tool_limitation',
    severity: 'medium',
    name: 'Tool limitation',
    description: 'Existing tool cannot handle the specific case',
    suggestedActions: [
      'Extend tool capabilities',
      'Create a specialized tool',
      'Use workaround with multiple tools',
    ],
  },
  {
    regex: /don't\s+know|unknown|not\s+sure|unfamiliar/i,
    category: 'knowledge_gap',
    severity: 'low',
    name: 'Knowledge gap',
    description: 'Lacks knowledge about domain or technology',
    suggestedActions: [
      'Search documentation',
      'Use web_fetch to research',
      'Store learned knowledge for future use',
    ],
  },
  {
    regex: /no\s+strategy|don't\s+have\s+a\s+plan|unclear\s+how|not\s+sure\s+how/i,
    category: 'strategy_gap',
    severity: 'medium',
    name: 'Strategy gap',
    description: 'No clear strategy for completing the task',
    suggestedActions: [
      'Create a strategy using strategy_optimize',
      'Break task into smaller sub-tasks',
      'Ask user for more context or examples',
    ],
  },
];

// ----------------------------------------------------------------------------
// Capability Gap Detector Service
// ----------------------------------------------------------------------------

class CapabilityGapDetectorService {
  private gaps: Map<string, CapabilityGap> = new Map();
  private initialized = false;

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    if (this.initialized) return;

    // Load persisted gaps
    await this.loadGaps();
    this.initialized = true;

    logger.info('CapabilityGapDetector initialized', {
      gapsLoaded: this.gaps.size,
    });
  }

  // --------------------------------------------------------------------------
  // Gap Detection
  // --------------------------------------------------------------------------

  /**
   * Analyze a session for capability gaps
   */
  async analyzeSession(session: SessionAnalysis): Promise<GapAnalysisResult> {
    const result: GapAnalysisResult = {
      newGaps: [],
      updatedGaps: [],
      insights: [],
      prioritizedActions: [],
    };

    // Analyze failed tool executions
    const failures = session.toolExecutions.filter(e => !e.success);

    for (const failure of failures) {
      const gap = await this.detectGapFromFailure(failure);
      if (gap) {
        if (gap.occurrences === 1) {
          result.newGaps.push(gap);
        } else {
          result.updatedGaps.push(gap);
        }
      }
    }

    // Analyze session messages for implicit gaps
    const messageGaps = await this.analyzeMessagesForGaps(session);
    for (const gap of messageGaps) {
      if (gap.occurrences === 1) {
        result.newGaps.push(gap);
      } else {
        result.updatedGaps.push(gap);
      }
    }

    // Generate insights
    result.insights = this.generateGapInsights();

    // Prioritize actions
    result.prioritizedActions = this.getPrioritizedActions();

    logger.info('Session gap analysis completed', {
      newGaps: result.newGaps.length,
      updatedGaps: result.updatedGaps.length,
    });

    return result;
  }

  /**
   * Analyze a single tool failure for capability gaps
   */
  async detectGapFromFailure(failure: ToolExecution): Promise<CapabilityGap | null> {
    if (!failure.errorMessage) return null;

    // Match against known error patterns
    for (const pattern of ERROR_PATTERNS) {
      if (pattern.regex.test(failure.errorMessage)) {
        return this.createOrUpdateGap({
          name: `${pattern.name} - ${failure.name}`,
          description: `${pattern.description}. Error: ${failure.errorMessage.substring(0, 200)}`,
          category: pattern.category,
          severity: pattern.severity,
          suggestedActions: pattern.suggestedActions,
          relatedErrors: [failure.errorMessage.substring(0, 300)],
          relatedTools: [failure.name],
        });
      }
    }

    // Generic failure gap
    return this.createOrUpdateGap({
      name: `Tool failure - ${failure.name}`,
      description: `Unclassified error: ${failure.errorMessage.substring(0, 200)}`,
      category: 'tool_limitation',
      severity: 'low',
      suggestedActions: [
        'Review error message and investigate root cause',
        'Check tool inputs and preconditions',
        'Consider alternative approaches',
      ],
      relatedErrors: [failure.errorMessage.substring(0, 300)],
      relatedTools: [failure.name],
    });
  }

  /**
   * Analyze messages for implicit capability gaps
   */
  private async analyzeMessagesForGaps(session: SessionAnalysis): Promise<CapabilityGap[]> {
    const gaps: CapabilityGap[] = [];

    for (const msg of session.messages) {
      if (msg.role !== 'assistant' || !msg.content) continue;

      const content = msg.content.toLowerCase();

      // Check for "I can't" or "I don't know how" patterns
      if (content.includes("i can't") || content.includes("i don't know how")) {
        const gap = await this.createOrUpdateGap({
          name: 'Expressed inability',
          description: `Agent expressed inability: ${msg.content.substring(0, 200)}`,
          category: 'knowledge_gap',
          severity: 'low',
          suggestedActions: [
            'Identify the specific capability needed',
            'Research or ask for guidance',
            'Document for future improvement',
          ],
          relatedErrors: [],
          relatedTools: [],
        });
        if (gap) gaps.push(gap);
      }

      // Check for requests for tools that don't exist
      if (content.includes('need a tool') || content.includes('requires a tool')) {
        const gap = await this.createOrUpdateGap({
          name: 'Tool request identified',
          description: `Agent indicated need for tool: ${msg.content.substring(0, 200)}`,
          category: 'missing_tool',
          severity: 'medium',
          suggestedActions: [
            'Evaluate if a new tool should be created',
            'Check if existing tools can be combined',
            'Use tool_create if appropriate',
          ],
          relatedErrors: [],
          relatedTools: [],
        });
        if (gap) gaps.push(gap);
      }
    }

    return gaps;
  }

  // --------------------------------------------------------------------------
  // Gap Management
  // --------------------------------------------------------------------------

  /**
   * Create or update a capability gap
   */
  private async createOrUpdateGap(params: {
    name: string;
    description: string;
    category: GapCategory;
    severity: CapabilityGap['severity'];
    suggestedActions: string[];
    relatedErrors: string[];
    relatedTools: string[];
  }): Promise<CapabilityGap> {
    // Check for existing similar gap
    const existingGap = this.findSimilarGap(params.name, params.category);

    if (existingGap) {
      // Update existing gap
      existingGap.occurrences++;
      existingGap.lastSeenAt = Date.now();
      existingGap.relatedErrors = [
        ...new Set([...existingGap.relatedErrors, ...params.relatedErrors]),
      ].slice(-10); // Keep last 10 errors
      existingGap.relatedTools = [
        ...new Set([...existingGap.relatedTools, ...params.relatedTools]),
      ];

      // Escalate severity if recurring
      if (existingGap.occurrences >= 5 && existingGap.severity === 'low') {
        existingGap.severity = 'medium';
      }
      if (existingGap.occurrences >= 10 && existingGap.severity === 'medium') {
        existingGap.severity = 'high';
      }

      await this.saveGaps();
      return existingGap;
    }

    // Create new gap
    const gap: CapabilityGap = {
      id: `gap_${Date.now()}_${crypto.randomUUID().split('-')[0]}`,
      name: params.name,
      description: params.description,
      category: params.category,
      severity: params.severity,
      detectedAt: Date.now(),
      lastSeenAt: Date.now(),
      occurrences: 1,
      status: 'open',
      suggestedActions: params.suggestedActions,
      relatedErrors: params.relatedErrors,
      relatedTools: params.relatedTools,
    };

    this.gaps.set(gap.id, gap);
    await this.saveGaps();

    return gap;
  }

  /**
   * Find a similar existing gap
   */
  private findSimilarGap(name: string, category: GapCategory): CapabilityGap | null {
    for (const gap of this.gaps.values()) {
      if (gap.category === category && gap.status !== 'resolved') {
        // Simple similarity check - same name or category
        if (gap.name === name || gap.name.startsWith(name.split(' - ')[0])) {
          return gap;
        }
      }
    }
    return null;
  }

  /**
   * Mark a gap as resolved
   */
  async resolveGap(gapId: string, resolution: string): Promise<boolean> {
    const gap = this.gaps.get(gapId);
    if (!gap) return false;

    gap.status = 'resolved';
    gap.resolution = resolution;
    await this.saveGaps();

    logger.info('Gap resolved', { gapId, resolution });
    return true;
  }

  /**
   * Mark a gap as in progress
   */
  async startWorkingOnGap(gapId: string): Promise<boolean> {
    const gap = this.gaps.get(gapId);
    if (!gap) return false;

    gap.status = 'in_progress';
    await this.saveGaps();

    return true;
  }

  // --------------------------------------------------------------------------
  // Queries
  // --------------------------------------------------------------------------

  /**
   * Get all gaps
   */
  getAllGaps(): CapabilityGap[] {
    return Array.from(this.gaps.values());
  }

  /**
   * Get gaps by category
   */
  getGapsByCategory(category: GapCategory): CapabilityGap[] {
    return this.getAllGaps().filter(g => g.category === category);
  }

  /**
   * Get open gaps sorted by priority
   */
  getOpenGaps(): CapabilityGap[] {
    const severityOrder: Record<string, number> = {
      critical: 4,
      high: 3,
      medium: 2,
      low: 1,
    };

    return this.getAllGaps()
      .filter(g => g.status !== 'resolved')
      .sort((a, b) => {
        // Sort by severity, then by occurrences
        const severityDiff = severityOrder[b.severity] - severityOrder[a.severity];
        if (severityDiff !== 0) return severityDiff;
        return b.occurrences - a.occurrences;
      });
  }

  /**
   * Get gap statistics
   */
  getStatistics(): GapStatistics {
    const allGaps = this.getAllGaps();

    const byCategory: Record<GapCategory, number> = {
      missing_tool: 0,
      tool_limitation: 0,
      knowledge_gap: 0,
      strategy_gap: 0,
      integration_gap: 0,
      permission_gap: 0,
    };

    const bySeverity: Record<string, number> = {
      low: 0,
      medium: 0,
      high: 0,
      critical: 0,
    };

    const byStatus: Record<string, number> = {
      open: 0,
      in_progress: 0,
      resolved: 0,
    };

    for (const gap of allGaps) {
      byCategory[gap.category]++;
      bySeverity[gap.severity]++;
      byStatus[gap.status]++;
    }

    return {
      totalGaps: allGaps.length,
      byCategory,
      bySeverity,
      byStatus,
      topPriorities: this.getOpenGaps().slice(0, 5),
    };
  }

  // --------------------------------------------------------------------------
  // Insights & Actions
  // --------------------------------------------------------------------------

  /**
   * Generate insights from current gaps
   */
  private generateGapInsights(): string[] {
    const insights: string[] = [];
    const stats = this.getStatistics();

    // Category insights
    const topCategory = Object.entries(stats.byCategory)
      .sort((a, b) => b[1] - a[1])[0];

    if (topCategory && topCategory[1] > 0) {
      insights.push(`Most common gap type: ${topCategory[0]} (${topCategory[1]} gaps)`);
    }

    // Severity insights
    const criticalCount = stats.bySeverity.critical + stats.bySeverity.high;
    if (criticalCount > 0) {
      insights.push(`${criticalCount} high-priority gaps require attention`);
    }

    // Recurring gaps
    const recurringGaps = this.getAllGaps()
      .filter(g => g.occurrences >= 5 && g.status !== 'resolved');

    if (recurringGaps.length > 0) {
      insights.push(`${recurringGaps.length} recurring gaps need systematic resolution`);
    }

    // Resolution rate
    const totalHandled = stats.byStatus.resolved + stats.byStatus.in_progress;
    if (stats.totalGaps > 0) {
      const rate = (totalHandled / stats.totalGaps) * 100;
      insights.push(`Gap resolution rate: ${rate.toFixed(0)}%`);
    }

    return insights;
  }

  /**
   * Get prioritized actions for addressing gaps
   */
  private getPrioritizedActions(): string[] {
    const actions: string[] = [];
    const openGaps = this.getOpenGaps();

    // Get top priority gaps
    for (const gap of openGaps.slice(0, 3)) {
      if (gap.suggestedActions.length > 0) {
        actions.push(`[${gap.severity.toUpperCase()}] ${gap.suggestedActions[0]}`);
      }
    }

    // Add category-specific recommendations
    const stats = this.getStatistics();

    if (stats.byCategory.missing_tool > 2) {
      actions.push('Consider creating new tools to address common missing_tool gaps');
    }

    if (stats.byCategory.knowledge_gap > 3) {
      actions.push('Build knowledge base to address recurring knowledge gaps');
    }

    if (stats.byCategory.strategy_gap > 2) {
      actions.push('Create strategies for common task types');
    }

    return actions;
  }

  // --------------------------------------------------------------------------
  // Persistence
  // --------------------------------------------------------------------------

  private async loadGaps(): Promise<void> {
    try {
      const persistence = getEvolutionPersistence();
      const stored = persistence.getAllPatterns()
        .filter(p => p.type === 'failure' || p.type === 'anti_pattern');

      // Convert stored patterns to gaps (simplified)
      for (const pattern of stored) {
        if (pattern.tags.includes('capability-gap')) {
          // Reconstruct gap from pattern
          const gap: CapabilityGap = {
            id: pattern.id,
            name: pattern.name,
            description: pattern.context,
            category: (pattern.tags.find(t =>
              ['missing_tool', 'tool_limitation', 'knowledge_gap', 'strategy_gap', 'integration_gap', 'permission_gap'].includes(t)
            ) || 'tool_limitation') as GapCategory,
            severity: 'medium',
            detectedAt: pattern.createdAt,
            lastSeenAt: pattern.lastSeen,
            occurrences: pattern.occurrences,
            status: pattern.solution ? 'resolved' : 'open',
            resolution: pattern.solution,
            suggestedActions: [],
            relatedErrors: [],
            relatedTools: pattern.tags.filter(t => !['capability-gap', pattern.type].includes(t)),
          };
          this.gaps.set(gap.id, gap);
        }
      }
    } catch (error) {
      logger.error('Failed to load gaps from persistence', error);
    }
  }

  private async saveGaps(): Promise<void> {
    try {
      const persistence = getEvolutionPersistence();

      // Store gaps as patterns for persistence
      for (const gap of this.gaps.values()) {
        const existingPattern = persistence.getPattern(gap.id);

        if (existingPattern) {
          await persistence.updatePattern(gap.id, {
            context: gap.description,
            solution: gap.resolution,
            occurrences: gap.occurrences,
            lastSeen: gap.lastSeenAt,
          });
        } else {
          await persistence.createPattern({
            name: gap.name,
            type: 'failure',
            context: gap.description,
            pattern: `Category: ${gap.category}, Severity: ${gap.severity}`,
            solution: gap.resolution,
            confidence: gap.occurrences > 5 ? 0.9 : 0.6,
            occurrences: gap.occurrences,
            lastSeen: gap.lastSeenAt,
            tags: ['capability-gap', gap.category, ...gap.relatedTools],
          });
        }
      }
    } catch (error) {
      logger.error('Failed to save gaps to persistence', error);
    }
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let capabilityGapDetectorInstance: CapabilityGapDetectorService | null = null;

export function getCapabilityGapDetector(): CapabilityGapDetectorService {
  if (!capabilityGapDetectorInstance) {
    capabilityGapDetectorInstance = new CapabilityGapDetectorService();
  }
  return capabilityGapDetectorInstance;
}

export async function initCapabilityGapDetector(): Promise<CapabilityGapDetectorService> {
  const service = getCapabilityGapDetector();
  await service.initialize();
  return service;
}

// Export for testing
export { CapabilityGapDetectorService };
