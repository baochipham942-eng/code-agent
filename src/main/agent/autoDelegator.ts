// ============================================================================
// Auto Delegator - Automatically matches tasks to appropriate agents
// ============================================================================

import { createLogger } from '../services/infra/logger';
import {
  getAgentRegistry,
  type AgentDefinition,
  type AgentCapability,
  type AgentPriority,
} from './types';

const logger = createLogger('AutoDelegator');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Task analysis result
 */
export interface TaskAnalysis {
  /** Detected task type */
  taskType: TaskType;
  /** Extracted keywords */
  keywords: string[];
  /** Required capabilities */
  requiredCapabilities: AgentCapability[];
  /** Estimated complexity */
  complexity: 'simple' | 'moderate' | 'complex';
  /** Needs user interaction */
  needsInteraction: boolean;
  /** Involves file operations */
  involvesFiles: boolean;
  /** Involves code execution */
  involvesExecution: boolean;
  /** Involves web/network */
  involvesNetwork: boolean;
}

/**
 * Task types for classification
 */
export type TaskType =
  | 'explore'        // Finding/searching files
  | 'read'           // Reading/understanding code
  | 'write'          // Writing/creating code
  | 'edit'           // Modifying existing code
  | 'execute'        // Running commands
  | 'test'           // Running tests
  | 'build'          // Building/compiling
  | 'review'         // Code review
  | 'plan'           // Planning/architecture
  | 'research'       // Research/learning
  | 'complex'        // Multi-step complex task
  | 'unknown';       // Cannot determine

/**
 * Delegation suggestion
 */
export interface DelegationSuggestion {
  /** Recommended agent */
  agent: AgentDefinition;
  /** Confidence score (0-1) */
  confidence: number;
  /** Reason for suggestion */
  reason: string;
  /** Alternative agents */
  alternatives: Array<{
    agent: AgentDefinition;
    confidence: number;
    reason: string;
  }>;
  /** Task analysis */
  analysis: TaskAnalysis;
}

/**
 * Delegation result
 */
export interface DelegationResult {
  /** Whether delegation is recommended */
  shouldDelegate: boolean;
  /** Primary suggestion (if any) */
  suggestion?: DelegationSuggestion;
  /** Reason if not delegating */
  reason?: string;
}

// ----------------------------------------------------------------------------
// Task Patterns
// ----------------------------------------------------------------------------

const TASK_PATTERNS: Array<{
  pattern: RegExp;
  type: TaskType;
  capabilities: AgentCapability[];
  keywords: string[];
}> = [
  // Explore patterns
  {
    pattern: /\b(find|locate|search|where|look for|show me)\b.*\b(file|code|function|class|method|import)\b/i,
    type: 'explore',
    capabilities: ['file_operations', 'code_analysis'],
    keywords: ['find', 'search', 'locate'],
  },
  {
    pattern: /\b(what|which)\b.*\b(files?|modules?|components?)\b/i,
    type: 'explore',
    capabilities: ['file_operations'],
    keywords: ['explore', 'understand'],
  },

  // Read patterns
  {
    pattern: /\b(read|explain|understand|analyze|show)\b.*\b(code|file|function|implementation)\b/i,
    type: 'read',
    capabilities: ['file_operations', 'code_analysis'],
    keywords: ['read', 'explain', 'understand'],
  },

  // Write patterns
  {
    pattern: /\b(write|create|add|implement|make)\b.*\b(file|function|class|component|feature)\b/i,
    type: 'write',
    capabilities: ['file_operations'],
    keywords: ['write', 'create', 'implement'],
  },

  // Edit patterns
  {
    pattern: /\b(edit|modify|update|change|fix|refactor)\b/i,
    type: 'edit',
    capabilities: ['file_operations'],
    keywords: ['edit', 'modify', 'fix'],
  },

  // Execute patterns
  {
    pattern: /\b(run|execute|start|launch)\b.*\b(command|script|program)\b/i,
    type: 'execute',
    capabilities: ['code_execution'],
    keywords: ['run', 'execute'],
  },

  // Test patterns
  {
    pattern: /\b(test|spec|unit test|integration test|e2e)\b/i,
    type: 'test',
    capabilities: ['code_execution'],
    keywords: ['test', 'spec'],
  },
  {
    pattern: /\b(npm|yarn|pnpm)\s+(test|run test)/i,
    type: 'test',
    capabilities: ['code_execution'],
    keywords: ['test', 'npm'],
  },

  // Build patterns
  {
    pattern: /\b(build|compile|bundle|package)\b/i,
    type: 'build',
    capabilities: ['code_execution'],
    keywords: ['build', 'compile'],
  },
  {
    pattern: /\b(npm|yarn|pnpm)\s+(run\s+)?(build|dist)/i,
    type: 'build',
    capabilities: ['code_execution'],
    keywords: ['build', 'npm'],
  },

  // Review patterns
  {
    pattern: /\b(review|check|audit|inspect)\b.*\b(code|security|quality)\b/i,
    type: 'review',
    capabilities: ['code_analysis'],
    keywords: ['review', 'check', 'audit'],
  },
  {
    pattern: /\b(bug|issue|problem|error|vulnerability)\b/i,
    type: 'review',
    capabilities: ['code_analysis'],
    keywords: ['bug', 'issue', 'debug'],
  },

  // Plan patterns
  {
    pattern: /\b(plan|design|architect|strategy|roadmap)\b/i,
    type: 'plan',
    capabilities: ['planning'],
    keywords: ['plan', 'design', 'architect'],
  },
  {
    pattern: /\bhow (to|should|would|can)\b.*\b(implement|build|create)\b/i,
    type: 'plan',
    capabilities: ['planning'],
    keywords: ['plan', 'how'],
  },

  // Research patterns
  {
    pattern: /\b(research|investigate|study|learn about|what is)\b/i,
    type: 'research',
    capabilities: ['research', 'web_access'],
    keywords: ['research', 'investigate', 'learn'],
  },
];

// ----------------------------------------------------------------------------
// Auto Delegator Class
// ----------------------------------------------------------------------------

/**
 * Auto Delegator
 *
 * Analyzes task descriptions and suggests appropriate agents for delegation.
 * Uses keyword matching, pattern recognition, and capability analysis.
 */
export class AutoDelegator {
  private currentGeneration: number = 4;

  /**
   * Set the current generation level
   */
  setGeneration(generation: number): void {
    this.currentGeneration = generation;
  }

  /**
   * Analyze a task description
   */
  analyzeTask(taskDescription: string): TaskAnalysis {
    const lowerDesc = taskDescription.toLowerCase();
    const keywords: string[] = [];
    const requiredCapabilities: Set<AgentCapability> = new Set();
    let taskType: TaskType = 'unknown';
    let complexity: 'simple' | 'moderate' | 'complex' = 'simple';

    // Match against patterns
    for (const pattern of TASK_PATTERNS) {
      if (pattern.pattern.test(taskDescription)) {
        if (taskType === 'unknown') {
          taskType = pattern.type;
        }
        keywords.push(...pattern.keywords);
        pattern.capabilities.forEach(c => requiredCapabilities.add(c));
      }
    }

    // Detect complexity indicators
    const complexityIndicators = [
      /\band\b.*\band\b/i,           // Multiple "and"s
      /\bthen\b/i,                    // Sequential steps
      /\bafter\b/i,                   // Dependencies
      /\bmultiple\b|\bseveral\b/i,   // Multiple items
      /\ball\b.*\bfiles?\b/i,        // All files
    ];

    const complexIndicatorCount = complexityIndicators.filter(p => p.test(taskDescription)).length;
    if (complexIndicatorCount >= 2) {
      complexity = 'complex';
      taskType = 'complex';
    } else if (complexIndicatorCount === 1 || taskDescription.length > 200) {
      complexity = 'moderate';
    }

    // Detect specific operations
    const involvesFiles = /\b(file|read|write|edit|create|delete|move)\b/i.test(lowerDesc);
    const involvesExecution = /\b(run|execute|command|bash|shell|npm|yarn|test|build)\b/i.test(lowerDesc);
    const involvesNetwork = /\b(fetch|download|api|http|url|web|search online)\b/i.test(lowerDesc);
    const needsInteraction = /\b(ask|confirm|choose|select|approve)\b/i.test(lowerDesc);

    // Add capabilities based on detected operations
    if (involvesFiles) requiredCapabilities.add('file_operations');
    if (involvesExecution) requiredCapabilities.add('code_execution');
    if (involvesNetwork) requiredCapabilities.add('web_access');

    return {
      taskType,
      keywords: [...new Set(keywords)],
      requiredCapabilities: Array.from(requiredCapabilities),
      complexity,
      needsInteraction,
      involvesFiles,
      involvesExecution,
      involvesNetwork,
    };
  }

  /**
   * Suggest an agent for a task
   */
  suggest(taskDescription: string): DelegationResult {
    const analysis = this.analyzeTask(taskDescription);
    const registry = getAgentRegistry();

    // Get all agents available for current generation
    const availableAgents = registry.findByGeneration(this.currentGeneration);

    if (availableAgents.length === 0) {
      return {
        shouldDelegate: false,
        reason: 'No agents available for current generation',
      };
    }

    // Score each agent
    const scoredAgents = availableAgents.map(agent => ({
      agent,
      score: this.scoreAgent(agent, analysis),
    }));

    // Sort by score (highest first)
    scoredAgents.sort((a, b) => b.score - a.score);

    // Check if best agent has a reasonable score
    const best = scoredAgents[0];
    if (best.score < 0.3) {
      return {
        shouldDelegate: false,
        reason: 'No suitable agent found for this task',
      };
    }

    // Build suggestion
    const suggestion: DelegationSuggestion = {
      agent: best.agent,
      confidence: best.score,
      reason: this.getReasonForAgent(best.agent, analysis),
      alternatives: scoredAgents
        .slice(1, 4)
        .filter(s => s.score >= 0.2)
        .map(s => ({
          agent: s.agent,
          confidence: s.score,
          reason: this.getReasonForAgent(s.agent, analysis),
        })),
      analysis,
    };

    logger.debug('Delegation suggestion', {
      task: taskDescription.substring(0, 100),
      agent: suggestion.agent.id,
      confidence: suggestion.confidence,
      alternatives: suggestion.alternatives.length,
    });

    return {
      shouldDelegate: true,
      suggestion,
    };
  }

  /**
   * Score an agent for a given task analysis
   */
  private scoreAgent(agent: AgentDefinition, analysis: TaskAnalysis): number {
    let score = 0;
    const weights = {
      capability: 0.4,
      keyword: 0.25,
      taskType: 0.2,
      priority: 0.1,
      complexity: 0.05,
    };

    // Capability match
    const requiredCaps = analysis.requiredCapabilities;
    const agentCaps = agent.capabilities;
    if (requiredCaps.length > 0) {
      const matchedCaps = requiredCaps.filter(c => agentCaps.includes(c)).length;
      score += (matchedCaps / requiredCaps.length) * weights.capability;
    }

    // Keyword match
    const taskKeywords = analysis.keywords;
    const agentKeywords = agent.keywords;
    if (taskKeywords.length > 0) {
      const matchedKeywords = taskKeywords.filter(k =>
        agentKeywords.some(ak => ak.toLowerCase().includes(k.toLowerCase()))
      ).length;
      score += (matchedKeywords / taskKeywords.length) * weights.keyword;
    }

    // Task type match
    const typeToAgentMap: Record<TaskType, string[]> = {
      explore: ['explore'],
      read: ['explore', 'code-review'],
      write: ['orchestrator'],
      edit: ['orchestrator'],
      execute: ['bash'],
      test: ['bash'],
      build: ['bash'],
      review: ['code-review'],
      plan: ['plan'],
      research: ['researcher'],
      complex: ['orchestrator'],
      unknown: [],
    };

    const matchingAgents = typeToAgentMap[analysis.taskType] || [];
    if (matchingAgents.includes(agent.id)) {
      score += weights.taskType;
    }

    // Priority bonus
    const priorityBonus: Record<AgentPriority, number> = {
      critical: 0.1,
      high: 0.07,
      normal: 0.05,
      low: 0.02,
    };
    score += priorityBonus[agent.priority] * weights.priority;

    // Complexity match
    if (analysis.complexity === 'complex' && agent.canDelegate) {
      score += weights.complexity;
    } else if (analysis.complexity === 'simple' && !agent.canDelegate) {
      score += weights.complexity;
    }

    // Penalties
    // Penalize if agent can't handle execution but task needs it
    if (analysis.involvesExecution && !agent.capabilities.includes('code_execution')) {
      score *= 0.7;
    }

    // Penalize if agent can't handle network but task needs it
    if (analysis.involvesNetwork && !agent.capabilities.includes('web_access')) {
      score *= 0.7;
    }

    return Math.min(1, Math.max(0, score));
  }

  /**
   * Get a human-readable reason for suggesting an agent
   */
  private getReasonForAgent(agent: AgentDefinition, analysis: TaskAnalysis): string {
    const reasons: string[] = [];

    // Capability match
    const matchedCaps = analysis.requiredCapabilities.filter(c =>
      agent.capabilities.includes(c)
    );
    if (matchedCaps.length > 0) {
      reasons.push(`Supports ${matchedCaps.join(', ')}`);
    }

    // Keyword match
    const matchedKeywords = analysis.keywords.filter(k =>
      agent.keywords.some(ak => ak.toLowerCase().includes(k.toLowerCase()))
    );
    if (matchedKeywords.length > 0) {
      reasons.push(`Matches keywords: ${matchedKeywords.join(', ')}`);
    }

    // Task type
    if (analysis.taskType !== 'unknown') {
      reasons.push(`Suitable for ${analysis.taskType} tasks`);
    }

    // Delegation capability
    if (analysis.complexity === 'complex' && agent.canDelegate) {
      reasons.push('Can delegate sub-tasks');
    }

    return reasons.length > 0 ? reasons.join('; ') : agent.description;
  }

  /**
   * Get the best agent for a specific task type
   */
  getBestAgentForType(taskType: TaskType): AgentDefinition | undefined {
    const registry = getAgentRegistry();
    const typeToAgent: Record<TaskType, string> = {
      explore: 'explore',
      read: 'explore',
      write: 'orchestrator',
      edit: 'orchestrator',
      execute: 'bash',
      test: 'bash',
      build: 'bash',
      review: 'code-review',
      plan: 'plan',
      research: 'researcher',
      complex: 'orchestrator',
      unknown: 'orchestrator',
    };

    return registry.get(typeToAgent[taskType]);
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let autoDelegatorInstance: AutoDelegator | null = null;

/**
 * Get or create auto delegator instance
 */
export function getAutoDelegator(): AutoDelegator {
  if (!autoDelegatorInstance) {
    autoDelegatorInstance = new AutoDelegator();
  }
  return autoDelegatorInstance;
}

/**
 * Reset auto delegator instance (for testing)
 */
export function resetAutoDelegator(): void {
  autoDelegatorInstance = null;
}

/**
 * Convenience function to suggest delegation
 */
export function suggestDelegation(taskDescription: string): DelegationResult {
  return getAutoDelegator().suggest(taskDescription);
}
