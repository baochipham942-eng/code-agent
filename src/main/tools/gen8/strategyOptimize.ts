// ============================================================================
// Strategy Optimize Tool - Optimize work strategies based on experience
// Gen 8: Self-Evolution capability
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import { getMemoryService } from '../../memory/MemoryService';
import { getVectorStore } from '../../memory/VectorStore';

interface Strategy {
  id: string;
  name: string;
  description: string;
  steps: string[];
  successRate: number;
  usageCount: number;
  lastUsed: number;
  tags: string[];
  createdAt: number;
}

interface StrategyFeedback {
  strategyId: string;
  success: boolean;
  duration: number;
  notes?: string;
}

// In-memory strategy store (would be persisted in production)
const strategies: Map<string, Strategy> = new Map();
const feedbackHistory: StrategyFeedback[] = [];

export const strategyOptimizeTool: Tool = {
  name: 'strategy_optimize',
  description: `Optimize and manage work strategies based on experience.

Use this tool to:
- Create new strategies for common tasks
- Record feedback on strategy effectiveness
- Get recommended strategies for a task
- Analyze and improve existing strategies

Parameters:
- action: create, feedback, recommend, analyze, list
- name: Strategy name (for create)
- description: Strategy description (for create)
- steps: Array of strategy steps (for create)
- tags: Tags for categorization (for create)
- strategyId: Target strategy (for feedback, analyze)
- success: Whether strategy worked (for feedback)
- task: Task description (for recommend)`,
  generations: ['gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'feedback', 'recommend', 'analyze', 'list', 'delete'],
        description: 'Action to perform',
      },
      name: {
        type: 'string',
        description: 'Strategy name',
      },
      description: {
        type: 'string',
        description: 'Strategy description',
      },
      steps: {
        type: 'array',
        items: { type: 'string' },
        description: 'Strategy steps',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags for categorization',
      },
      strategyId: {
        type: 'string',
        description: 'Strategy ID for operations',
      },
      success: {
        type: 'boolean',
        description: 'Whether the strategy succeeded',
      },
      duration: {
        type: 'number',
        description: 'How long the strategy took (ms)',
      },
      notes: {
        type: 'string',
        description: 'Additional notes on the outcome',
      },
      task: {
        type: 'string',
        description: 'Task to get recommendations for',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as string;

    switch (action) {
      case 'create':
        return createStrategy(params, context);

      case 'feedback':
        return recordFeedback(params);

      case 'recommend':
        return recommendStrategies(params, context);

      case 'analyze':
        return analyzeStrategy(params);

      case 'list':
        return listStrategies();

      case 'delete':
        return deleteStrategy(params);

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },
};

function createStrategy(params: Record<string, unknown>, context: ToolContext): ToolExecutionResult {
  const name = params.name as string;
  const description = params.description as string;
  const steps = params.steps as string[];
  const tags = (params.tags as string[]) || [];

  if (!name || !description || !steps || steps.length === 0) {
    return {
      success: false,
      error: 'name, description, and steps are required for create action',
    };
  }

  const id = `strategy_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  const strategy: Strategy = {
    id,
    name,
    description,
    steps,
    successRate: 0,
    usageCount: 0,
    lastUsed: 0,
    tags,
    createdAt: Date.now(),
  };

  strategies.set(id, strategy);

  // Also store in vector store for semantic search
  try {
    const vectorStore = getVectorStore();
    const content = `Strategy: ${name}\nDescription: ${description}\nSteps:\n${steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}`;
    vectorStore.addKnowledge(content, 'strategy', context.workingDirectory);
  } catch (error) {
    console.error('Failed to store strategy in vector store:', error);
  }

  return {
    success: true,
    output: `Strategy created successfully:
- ID: ${id}
- Name: ${name}
- Steps: ${steps.length}
- Tags: ${tags.join(', ') || 'none'}

Use this strategy ID with 'feedback' action to improve it over time.`,
  };
}

function recordFeedback(params: Record<string, unknown>): ToolExecutionResult {
  const strategyId = params.strategyId as string;
  const success = params.success as boolean;
  const duration = (params.duration as number) || 0;
  const notes = params.notes as string | undefined;

  if (!strategyId || success === undefined) {
    return {
      success: false,
      error: 'strategyId and success are required for feedback action',
    };
  }

  const strategy = strategies.get(strategyId);
  if (!strategy) {
    return {
      success: false,
      error: `Strategy not found: ${strategyId}`,
    };
  }

  // Record feedback
  feedbackHistory.push({
    strategyId,
    success,
    duration,
    notes,
  });

  // Update strategy metrics
  strategy.usageCount++;
  strategy.lastUsed = Date.now();

  // Recalculate success rate
  const strategyFeedback = feedbackHistory.filter((f) => f.strategyId === strategyId);
  const successCount = strategyFeedback.filter((f) => f.success).length;
  strategy.successRate = (successCount / strategyFeedback.length) * 100;

  // Store feedback in memory for learning
  try {
    const memoryService = getMemoryService();
    memoryService.saveProjectKnowledge(
      `strategy_feedback_${strategyId}_${Date.now()}`,
      {
        strategy: strategy.name,
        success,
        notes,
        timestamp: Date.now(),
      },
      'learned',
      success ? 0.8 : 0.6
    );
  } catch (error) {
    console.error('Failed to store feedback in memory:', error);
  }

  return {
    success: true,
    output: `Feedback recorded for "${strategy.name}":
- Outcome: ${success ? '✅ Success' : '❌ Failed'}
- Updated success rate: ${strategy.successRate.toFixed(1)}%
- Total uses: ${strategy.usageCount}
${notes ? `- Notes: ${notes}` : ''}`,
  };
}

function recommendStrategies(
  params: Record<string, unknown>,
  context: ToolContext
): ToolExecutionResult {
  const task = params.task as string;

  if (!task) {
    return {
      success: false,
      error: 'task is required for recommend action',
    };
  }

  // Get all strategies
  const allStrategies = Array.from(strategies.values());

  if (allStrategies.length === 0) {
    return {
      success: true,
      output: `No strategies found. Create some strategies first using action='create'.

Suggested initial strategies for common tasks:
- Bug fixing workflow
- Code review process
- Feature development steps
- Refactoring approach`,
    };
  }

  // Simple keyword matching for now (would use vector search in production)
  const taskLower = task.toLowerCase();
  const scored = allStrategies.map((strategy) => {
    let score = 0;

    // Tag matching
    for (const tag of strategy.tags) {
      if (taskLower.includes(tag.toLowerCase())) {
        score += 20;
      }
    }

    // Name/description matching
    if (taskLower.includes(strategy.name.toLowerCase())) {
      score += 30;
    }
    if (strategy.description.toLowerCase().includes(taskLower)) {
      score += 10;
    }

    // Success rate bonus
    score += strategy.successRate * 0.3;

    // Recency bonus (used in last 24h)
    if (strategy.lastUsed > Date.now() - 24 * 60 * 60 * 1000) {
      score += 10;
    }

    return { strategy, score };
  });

  // Sort by score
  scored.sort((a, b) => b.score - a.score);

  // Take top 3
  const recommendations = scored.slice(0, 3).filter((s) => s.score > 0);

  if (recommendations.length === 0) {
    return {
      success: true,
      output: `No matching strategies found for: "${task}"

Consider creating a new strategy for this type of task.`,
    };
  }

  const output = recommendations.map((r, i) => {
    const s = r.strategy;
    return `### ${i + 1}. ${s.name} (Score: ${r.score.toFixed(0)})
- Success Rate: ${s.successRate.toFixed(1)}%
- Uses: ${s.usageCount}
- ID: ${s.id}

Steps:
${s.steps.map((step, j) => `  ${j + 1}. ${step}`).join('\n')}`;
  }).join('\n\n');

  return {
    success: true,
    output: `## Recommended Strategies for: "${task}"

${output}

Use the strategy ID with action='feedback' after completion to help improve recommendations.`,
  };
}

function analyzeStrategy(params: Record<string, unknown>): ToolExecutionResult {
  const strategyId = params.strategyId as string;

  if (!strategyId) {
    return {
      success: false,
      error: 'strategyId is required for analyze action',
    };
  }

  const strategy = strategies.get(strategyId);
  if (!strategy) {
    return {
      success: false,
      error: `Strategy not found: ${strategyId}`,
    };
  }

  // Get all feedback for this strategy
  const feedback = feedbackHistory.filter((f) => f.strategyId === strategyId);

  if (feedback.length === 0) {
    return {
      success: true,
      output: `## Analysis: ${strategy.name}

No usage data available yet. Use this strategy and provide feedback to see analysis.`,
    };
  }

  // Calculate statistics
  const successCount = feedback.filter((f) => f.success).length;
  const failCount = feedback.length - successCount;
  const avgDuration = feedback.reduce((sum, f) => sum + f.duration, 0) / feedback.length;

  // Find common failure notes
  const failureNotes = feedback
    .filter((f) => !f.success && f.notes)
    .map((f) => f.notes!);

  // Generate improvement suggestions
  const suggestions: string[] = [];

  if (strategy.successRate < 50) {
    suggestions.push('Consider revising the strategy steps - success rate is low');
  }
  if (failureNotes.length > 0) {
    suggestions.push(`Common failure reasons: ${failureNotes.slice(0, 3).join('; ')}`);
  }
  if (avgDuration > 300000) { // 5 minutes
    suggestions.push('Strategy takes a long time - consider breaking into smaller steps');
  }

  return {
    success: true,
    output: `## Analysis: ${strategy.name}

### Statistics
- Total Uses: ${strategy.usageCount}
- Success Rate: ${strategy.successRate.toFixed(1)}%
- Successes: ${successCount}
- Failures: ${failCount}
- Avg Duration: ${(avgDuration / 1000).toFixed(1)}s

### Current Steps
${strategy.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

### Improvement Suggestions
${suggestions.length > 0 ? suggestions.map((s) => `- ${s}`).join('\n') : '- Strategy performing well, no changes suggested'}

### Recent Feedback
${feedback.slice(-5).map((f) => `- ${f.success ? '✅' : '❌'} ${f.notes || 'No notes'}`).join('\n')}`,
  };
}

function listStrategies(): ToolExecutionResult {
  const allStrategies = Array.from(strategies.values());

  if (allStrategies.length === 0) {
    return {
      success: true,
      output: 'No strategies created yet. Use action="create" to add a strategy.',
    };
  }

  // Sort by success rate and usage
  allStrategies.sort((a, b) => {
    if (a.usageCount === 0 && b.usageCount === 0) return 0;
    if (a.usageCount === 0) return 1;
    if (b.usageCount === 0) return -1;
    return b.successRate - a.successRate;
  });

  const output = allStrategies.map((s) => {
    const rateStr = s.usageCount > 0 ? `${s.successRate.toFixed(0)}%` : 'N/A';
    return `- **${s.name}** [${s.id}]
  Rate: ${rateStr} | Uses: ${s.usageCount} | Tags: ${s.tags.join(', ') || 'none'}`;
  }).join('\n');

  return {
    success: true,
    output: `## All Strategies (${allStrategies.length})

${output}`,
  };
}

function deleteStrategy(params: Record<string, unknown>): ToolExecutionResult {
  const strategyId = params.strategyId as string;

  if (!strategyId) {
    return {
      success: false,
      error: 'strategyId is required for delete action',
    };
  }

  const strategy = strategies.get(strategyId);
  if (!strategy) {
    return {
      success: false,
      error: `Strategy not found: ${strategyId}`,
    };
  }

  strategies.delete(strategyId);

  return {
    success: true,
    output: `Strategy "${strategy.name}" deleted successfully.`,
  };
}
