// ============================================================================
// memory_store Tool - Store information in long-term memory
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getMemoryService } from '../../memory/memoryService';
import { getVectorStore } from '../../memory/vectorStore';
import { notifyMemoryLearned } from '../../memory/memoryNotification';

export const memoryStoreTool: Tool = {
  name: 'memory_store',
  description: `Store important information in long-term memory for future sessions.

Use this tool to save:
- User preferences and coding style
- Project architecture decisions
- Recurring patterns and solutions
- Important context that should persist across sessions

Parameters:
- content (required): The information to store
- category (required): Category for organizing memories
- key (optional): A unique key for easy retrieval
- confidence (optional): Confidence level 0-1 (default: 1.0)`,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'The information to store in memory',
      },
      category: {
        type: 'string',
        enum: ['preference', 'pattern', 'decision', 'context', 'insight', 'error_solution'],
        description: 'Category for organizing the memory',
      },
      key: {
        type: 'string',
        description: 'Optional unique key for easy retrieval',
      },
      confidence: {
        type: 'number',
        description: 'Confidence level for this memory (0-1)',
      },
    },
    required: ['content', 'category'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const content = params.content as string;
    const category = params.category as string;
    const key = params.key as string | undefined;
    const confidence = (params.confidence as number) ?? 1.0;

    if (!content || content.trim().length === 0) {
      return {
        success: false,
        error: 'Content is required and cannot be empty',
      };
    }

    // Security check: Don't store sensitive information
    const sensitivePatterns = [
      /api[_-]?key/i,
      /password/i,
      /secret/i,
      /token/i,
      /credential/i,
      /private[_-]?key/i,
    ];

    for (const pattern of sensitivePatterns) {
      if (pattern.test(content)) {
        return {
          success: false,
          error: 'Cannot store potentially sensitive information (API keys, passwords, tokens, etc.)',
        };
      }
    }

    try {
      const memoryService = getMemoryService();
      const vectorStore = getVectorStore();

      // Store in vector store for semantic search
      await vectorStore.addKnowledge(content, category, context.workingDirectory);

      // If key provided, also store as project knowledge for direct retrieval
      if (key) {
        memoryService.saveProjectKnowledge(key, content, 'explicit', confidence);
      }

      // Phase 3: 发送学习通知到前端
      // memory_store 通常是显式存储，使用高置信度
      notifyMemoryLearned(content, mapCategoryToNew(category), 'memory_store', confidence);

      const output = `Memory stored successfully:
- Category: ${category}
- Key: ${key || '(auto-generated)'}
- Confidence: ${confidence}
- Content preview: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`;

      return {
        success: true,
        output,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to store memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};

// ----------------------------------------------------------------------------
// Helper Functions
// ----------------------------------------------------------------------------

/**
 * 映射旧分类到新分类（Phase 2 定义的用户友好分类）
 */
function mapCategoryToNew(category: string): string {
  switch (category) {
    case 'preference':
      return 'preference';
    case 'pattern':
    case 'decision':
    case 'insight':
    case 'error_solution':
      return 'learned';
    case 'context':
      return 'frequent_info';
    default:
      return 'learned';
  }
}
