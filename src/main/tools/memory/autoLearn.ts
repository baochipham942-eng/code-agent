// ============================================================================
// auto_learn Tool - Automatically learn from user interactions
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getMemoryService } from '../../memory/memoryService';

export const autoLearnTool: Tool = {
  name: 'auto_learn',
  description: `Automatically learn and save insights from user interactions.

Use this tool to learn and remember:
- User's coding style preferences (indentation, quotes, naming conventions)
- Frequently used patterns and solutions
- Project-specific conventions and rules
- Error solutions that worked

This tool helps build a personalized knowledge base that improves future assistance.

Parameters:
- type (required): Type of learning - 'code_style', 'pattern', 'preference', 'error_solution'
- content (required): The specific insight or pattern to learn
- context (optional): Additional context about when this applies
- confidence (optional): How confident we are about this learning (0-1)`,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      type: {
        type: 'string',
        enum: ['code_style', 'pattern', 'preference', 'error_solution', 'project_rule'],
        description: 'Type of learning to store',
      },
      content: {
        type: 'string',
        description: 'The insight or pattern to learn',
      },
      context: {
        type: 'string',
        description: 'When this applies or additional context',
      },
      confidence: {
        type: 'number',
        description: 'Confidence level (0-1)',
      },
    },
    required: ['type', 'content'],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const type = params.type as string;
    const content = params.content as string;
    const learnContext = params.context as string | undefined;
    const confidence = (params.confidence as number) ?? 0.8;

    if (!content || content.trim().length === 0) {
      return {
        success: false,
        error: 'Content is required and cannot be empty',
      };
    }

    try {
      const memoryService = getMemoryService();

      switch (type) {
        case 'code_style':
          await learnCodeStyle(memoryService, content);
          break;

        case 'pattern':
          await learnPattern(memoryService, content, learnContext, confidence);
          break;

        case 'preference':
          await learnPreference(memoryService, content, confidence);
          break;

        case 'error_solution':
          await learnErrorSolution(memoryService, content, learnContext, confidence);
          break;

        case 'project_rule':
          await learnProjectRule(memoryService, content, learnContext, confidence);
          break;

        default:
          return {
            success: false,
            error: `Unknown learning type: ${type}`,
          };
      }

      const output = `Learned successfully:
- Type: ${type}
- Content: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}
- Context: ${learnContext || 'N/A'}
- Confidence: ${confidence}

This insight will be used to improve future assistance.`;

      return {
        success: true,
        output,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to learn: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};

// ----------------------------------------------------------------------------
// Learning Functions
// ----------------------------------------------------------------------------

async function learnCodeStyle(
  memoryService: ReturnType<typeof getMemoryService>,
  content: string
): Promise<void> {
  // Parse code style from content
  const style: Record<string, unknown> = {};

  // Detect indentation preference
  if (content.includes('2 spaces') || content.includes('2-space')) {
    style.indent = '2spaces';
  } else if (content.includes('4 spaces') || content.includes('4-space')) {
    style.indent = '4spaces';
  } else if (content.includes('tab')) {
    style.indent = 'tab';
  }

  // Detect quote preference
  if (content.includes('single quote') || content.includes("'")) {
    style.quotes = 'single';
  } else if (content.includes('double quote') || content.includes('"')) {
    style.quotes = 'double';
  }

  // Detect semicolon preference
  if (content.includes('no semicolon') || content.includes('without semicolon')) {
    style.semicolons = false;
  } else if (content.includes('semicolon')) {
    style.semicolons = true;
  }

  // Detect naming convention
  if (content.includes('camelCase')) {
    style.namingConvention = 'camelCase';
  } else if (content.includes('snake_case')) {
    style.namingConvention = 'snake_case';
  } else if (content.includes('PascalCase')) {
    style.namingConvention = 'PascalCase';
  }

  // Save to preferences
  const currentStyle = memoryService.getUserPreference<Record<string, unknown>>('coding_style', {});
  memoryService.setUserPreference('coding_style', { ...currentStyle, ...style });

  // Also save to knowledge base
  await memoryService.addKnowledge(
    `User prefers the following code style: ${JSON.stringify(style)}`,
    'preference'
  );
}

async function learnPattern(
  memoryService: ReturnType<typeof getMemoryService>,
  content: string,
  context: string | undefined,
  confidence: number
): Promise<void> {
  const fullContent = context
    ? `Pattern: ${content}\nContext: ${context}`
    : `Pattern: ${content}`;

  await memoryService.addKnowledge(fullContent, 'pattern');
  memoryService.saveProjectKnowledge(`pattern_${Date.now()}`, content, 'learned', confidence);
}

async function learnPreference(
  memoryService: ReturnType<typeof getMemoryService>,
  content: string,
  confidence: number
): Promise<void> {
  // Try to parse preference from content
  const match = content.match(/prefer\s+(\w+):\s*(.+)/i);
  if (match) {
    const [, key, value] = match;
    memoryService.setUserPreference(key.toLowerCase(), value.trim());
  }

  await memoryService.addKnowledge(content, 'preference');
  memoryService.saveProjectKnowledge(`preference_${Date.now()}`, content, 'learned', confidence);
}

async function learnErrorSolution(
  memoryService: ReturnType<typeof getMemoryService>,
  content: string,
  context: string | undefined,
  confidence: number
): Promise<void> {
  const fullContent = context
    ? `Error: ${context}\nSolution: ${content}`
    : `Solution: ${content}`;

  await memoryService.addKnowledge(fullContent, 'error_solution');
  memoryService.saveProjectKnowledge(`error_solution_${Date.now()}`, {
    error: context,
    solution: content,
  }, 'learned', confidence);
}

async function learnProjectRule(
  memoryService: ReturnType<typeof getMemoryService>,
  content: string,
  context: string | undefined,
  confidence: number
): Promise<void> {
  const fullContent = context
    ? `Rule: ${content}\nApplies to: ${context}`
    : `Project rule: ${content}`;

  await memoryService.addKnowledge(fullContent, 'decision');
  memoryService.saveProjectKnowledge(`rule_${Date.now()}`, content, 'explicit', confidence);
}
