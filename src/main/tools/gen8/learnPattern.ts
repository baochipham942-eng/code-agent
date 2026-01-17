// ============================================================================
// Learn Pattern Tool - Learn and apply patterns from experience
// Gen 8: Self-Evolution capability
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../ToolRegistry';
import { getMemoryService } from '../../memory/MemoryService';
import { getVectorStore } from '../../memory/VectorStore';

interface LearnedPattern {
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
  tags: string[];
}

// Pattern storage
const patterns: Map<string, LearnedPattern> = new Map();

export const learnPatternTool: Tool = {
  name: 'learn_pattern',
  description: `Learn and apply patterns from coding experience.

Use this tool to:
- Record successful patterns to reuse
- Document failure patterns to avoid
- Find applicable patterns for current task
- Build a knowledge base of best practices

Pattern Types:
- success: Patterns that led to successful outcomes
- failure: Patterns that caused problems (anti-patterns)
- optimization: Patterns that improved performance/quality
- anti_pattern: Patterns to explicitly avoid

Parameters:
- action: learn, apply, search, list, forget
- name: Pattern name (for learn)
- type: Pattern type (for learn)
- context: When this pattern applies (for learn)
- pattern: The pattern description (for learn)
- solution: How to apply/avoid the pattern (for learn)
- tags: Categorization tags (for learn)
- query: Search query (for search/apply)`,
  generations: ['gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['learn', 'apply', 'search', 'list', 'forget', 'reinforce'],
        description: 'Action to perform',
      },
      name: {
        type: 'string',
        description: 'Pattern name',
      },
      type: {
        type: 'string',
        enum: ['success', 'failure', 'optimization', 'anti_pattern'],
        description: 'Type of pattern',
      },
      context: {
        type: 'string',
        description: 'Context where pattern applies',
      },
      pattern: {
        type: 'string',
        description: 'The pattern description',
      },
      solution: {
        type: 'string',
        description: 'How to apply or avoid the pattern',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Tags for categorization',
      },
      query: {
        type: 'string',
        description: 'Search query',
      },
      patternId: {
        type: 'string',
        description: 'Pattern ID for operations',
      },
      confidence: {
        type: 'number',
        description: 'Confidence level (0-1)',
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
      case 'learn':
        return learnNewPattern(params, context);

      case 'apply':
        return applyPatterns(params, context);

      case 'search':
        return searchPatterns(params);

      case 'list':
        return listPatterns(params);

      case 'forget':
        return forgetPattern(params);

      case 'reinforce':
        return reinforcePattern(params);

      default:
        return { success: false, error: `Unknown action: ${action}` };
    }
  },
};

async function learnNewPattern(
  params: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const name = params.name as string;
  const type = params.type as LearnedPattern['type'];
  const patternContext = params.context as string;
  const pattern = params.pattern as string;
  const solution = params.solution as string | undefined;
  const tags = (params.tags as string[]) || [];
  const confidence = (params.confidence as number) || 0.7;

  if (!name || !type || !patternContext || !pattern) {
    return {
      success: false,
      error: 'name, type, context, and pattern are required for learn action',
    };
  }

  const id = `pattern_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;

  const learnedPattern: LearnedPattern = {
    id,
    name,
    type,
    context: patternContext,
    pattern,
    solution,
    confidence: Math.max(0, Math.min(1, confidence)),
    occurrences: 1,
    lastSeen: Date.now(),
    createdAt: Date.now(),
    tags,
  };

  patterns.set(id, learnedPattern);

  // Store in vector store for semantic search
  try {
    const vectorStore = getVectorStore();
    const content = `Pattern: ${name}
Type: ${type}
Context: ${patternContext}
Pattern: ${pattern}
${solution ? `Solution: ${solution}` : ''}
Tags: ${tags.join(', ')}`;

    await vectorStore.addKnowledge(content, 'pattern', context.workingDirectory);
  } catch (error) {
    console.error('Failed to store pattern in vector store:', error);
  }

  // Also store in memory service
  try {
    const memoryService = getMemoryService();
    memoryService.saveProjectKnowledge(
      `pattern_${id}`,
      learnedPattern,
      type === 'success' || type === 'optimization' ? 'explicit' : 'learned',
      confidence
    );
  } catch (error) {
    console.error('Failed to store pattern in memory:', error);
  }

  const typeIcon = {
    success: '✅',
    failure: '❌',
    optimization: '⚡',
    anti_pattern: '🚫',
  }[type];

  return {
    success: true,
    output: `${typeIcon} Pattern learned: "${name}"

- ID: ${id}
- Type: ${type}
- Confidence: ${(confidence * 100).toFixed(0)}%
- Tags: ${tags.join(', ') || 'none'}

Context:
${patternContext}

Pattern:
${pattern}

${solution ? `Solution:\n${solution}` : ''}

Use action='apply' with relevant query to find this pattern later.`,
  };
}

async function applyPatterns(
  params: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const query = params.query as string;

  if (!query) {
    return {
      success: false,
      error: 'query is required for apply action',
    };
  }

  // Search for relevant patterns
  const allPatterns = Array.from(patterns.values());

  if (allPatterns.length === 0) {
    return {
      success: true,
      output: `No patterns learned yet. Use action='learn' to add patterns.

Suggested patterns to learn:
- Error handling best practices
- Code organization conventions
- Testing strategies
- Performance optimization techniques`,
    };
  }

  // Simple keyword matching (would use vector search in production)
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/);

  const scored = allPatterns.map((p) => {
    let score = 0;

    // Name matching
    if (p.name.toLowerCase().includes(queryLower)) {
      score += 30;
    }

    // Context matching
    for (const word of queryWords) {
      if (p.context.toLowerCase().includes(word)) {
        score += 10;
      }
    }

    // Pattern content matching
    for (const word of queryWords) {
      if (p.pattern.toLowerCase().includes(word)) {
        score += 5;
      }
    }

    // Tag matching
    for (const tag of p.tags) {
      if (queryWords.includes(tag.toLowerCase())) {
        score += 15;
      }
    }

    // Confidence and occurrence boost
    score += p.confidence * 10;
    score += Math.min(p.occurrences * 2, 10);

    return { pattern: p, score };
  });

  // Sort by score and filter relevant
  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.filter((s) => s.score > 10).slice(0, 5);

  if (relevant.length === 0) {
    return {
      success: true,
      output: `No matching patterns found for: "${query}"

Try different keywords or learn new patterns with action='learn'.`,
    };
  }

  // Update occurrence counts for matched patterns
  for (const { pattern } of relevant) {
    pattern.occurrences++;
    pattern.lastSeen = Date.now();
  }

  const output = relevant.map(({ pattern: p, score }) => {
    const typeIcon = {
      success: '✅',
      failure: '❌',
      optimization: '⚡',
      anti_pattern: '🚫',
    }[p.type];

    return `### ${typeIcon} ${p.name} (Score: ${score.toFixed(0)})
**Type:** ${p.type} | **Confidence:** ${(p.confidence * 100).toFixed(0)}%

**Context:** ${p.context}

**Pattern:**
${p.pattern}

${p.solution ? `**Solution:**\n${p.solution}` : ''}`;
  }).join('\n\n---\n\n');

  return {
    success: true,
    output: `## Applicable Patterns for: "${query}"

${output}

---
Found ${relevant.length} relevant pattern(s). Apply these insights to your current task.`,
  };
}

function searchPatterns(params: Record<string, unknown>): ToolExecutionResult {
  const query = params.query as string;
  const type = params.type as LearnedPattern['type'] | undefined;

  let allPatterns = Array.from(patterns.values());

  // Filter by type if specified
  if (type) {
    allPatterns = allPatterns.filter((p) => p.type === type);
  }

  if (allPatterns.length === 0) {
    return {
      success: true,
      output: type
        ? `No ${type} patterns found.`
        : 'No patterns learned yet.',
    };
  }

  // If query provided, filter by it
  if (query) {
    const queryLower = query.toLowerCase();
    allPatterns = allPatterns.filter((p) =>
      p.name.toLowerCase().includes(queryLower) ||
      p.context.toLowerCase().includes(queryLower) ||
      p.pattern.toLowerCase().includes(queryLower) ||
      p.tags.some((t) => t.toLowerCase().includes(queryLower))
    );
  }

  if (allPatterns.length === 0) {
    return {
      success: true,
      output: `No patterns found matching: "${query}"`,
    };
  }

  // Sort by confidence and recency
  allPatterns.sort((a, b) => {
    const scoreA = a.confidence * 50 + (a.lastSeen > Date.now() - 86400000 ? 20 : 0);
    const scoreB = b.confidence * 50 + (b.lastSeen > Date.now() - 86400000 ? 20 : 0);
    return scoreB - scoreA;
  });

  const output = allPatterns.slice(0, 10).map((p) => {
    const typeIcon = {
      success: '✅',
      failure: '❌',
      optimization: '⚡',
      anti_pattern: '🚫',
    }[p.type];

    return `${typeIcon} **${p.name}** [${p.id}]
   ${p.context.substring(0, 60)}${p.context.length > 60 ? '...' : ''}
   Confidence: ${(p.confidence * 100).toFixed(0)}% | Uses: ${p.occurrences}`;
  }).join('\n\n');

  return {
    success: true,
    output: `## Pattern Search Results

${output}

---
Showing ${Math.min(allPatterns.length, 10)} of ${allPatterns.length} patterns.`,
  };
}

function listPatterns(params: Record<string, unknown>): ToolExecutionResult {
  const type = params.type as LearnedPattern['type'] | undefined;

  let allPatterns = Array.from(patterns.values());

  if (type) {
    allPatterns = allPatterns.filter((p) => p.type === type);
  }

  if (allPatterns.length === 0) {
    return {
      success: true,
      output: 'No patterns learned yet.\n\nUse action=\'learn\' to add patterns from your experience.',
    };
  }

  // Group by type
  const byType = new Map<string, LearnedPattern[]>();
  for (const p of allPatterns) {
    const existing = byType.get(p.type) || [];
    existing.push(p);
    byType.set(p.type, existing);
  }

  const typeIcons: Record<string, string> = {
    success: '✅',
    failure: '❌',
    optimization: '⚡',
    anti_pattern: '🚫',
  };

  const sections = Array.from(byType.entries()).map(([t, pats]) => {
    const patternList = pats
      .sort((a, b) => b.confidence - a.confidence)
      .map((p) => `  - ${p.name} (${(p.confidence * 100).toFixed(0)}%) [${p.id}]`)
      .join('\n');

    return `### ${typeIcons[t]} ${t.charAt(0).toUpperCase() + t.slice(1)} Patterns (${pats.length})
${patternList}`;
  }).join('\n\n');

  return {
    success: true,
    output: `## Learned Patterns (${allPatterns.length} total)

${sections}

---
Use action='apply' with a query to find relevant patterns for your task.`,
  };
}

function forgetPattern(params: Record<string, unknown>): ToolExecutionResult {
  const patternId = params.patternId as string;

  if (!patternId) {
    return {
      success: false,
      error: 'patternId is required for forget action',
    };
  }

  const pattern = patterns.get(patternId);
  if (!pattern) {
    return {
      success: false,
      error: `Pattern not found: ${patternId}`,
    };
  }

  patterns.delete(patternId);

  return {
    success: true,
    output: `Pattern "${pattern.name}" forgotten.

Note: This pattern may still exist in long-term memory and could be rediscovered.`,
  };
}

function reinforcePattern(params: Record<string, unknown>): ToolExecutionResult {
  const patternId = params.patternId as string;
  const success = params.success as boolean;

  if (!patternId || success === undefined) {
    return {
      success: false,
      error: 'patternId and success are required for reinforce action',
    };
  }

  const pattern = patterns.get(patternId);
  if (!pattern) {
    return {
      success: false,
      error: `Pattern not found: ${patternId}`,
    };
  }

  // Update confidence based on feedback
  const adjustment = success ? 0.05 : -0.1;
  pattern.confidence = Math.max(0.1, Math.min(1, pattern.confidence + adjustment));
  pattern.occurrences++;
  pattern.lastSeen = Date.now();

  const emoji = success ? '📈' : '📉';

  return {
    success: true,
    output: `${emoji} Pattern reinforced: "${pattern.name}"

- New Confidence: ${(pattern.confidence * 100).toFixed(0)}%
- Total Occurrences: ${pattern.occurrences}
- Feedback: ${success ? 'Positive (pattern worked)' : 'Negative (pattern failed)'}

${pattern.confidence < 0.3
    ? '⚠️ Low confidence - consider reviewing or forgetting this pattern.'
    : pattern.confidence > 0.9
    ? '🌟 High confidence - this is a reliable pattern!'
    : ''}`,
  };
}

// Export patterns for other tools
export function getLearnedPatterns(): LearnedPattern[] {
  return Array.from(patterns.values());
}

// Export high-confidence patterns
export function getReliablePatterns(minConfidence = 0.7): LearnedPattern[] {
  return Array.from(patterns.values()).filter((p) => p.confidence >= minConfidence);
}
