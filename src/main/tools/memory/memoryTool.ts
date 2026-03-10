// ============================================================================
// Memory Tool - Unified store & search for long-term memory
// ============================================================================
// Merges the former memory_store and memory_search tools into a single tool
// with an `action` parameter: "store" | "search".
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { getMemoryService } from '../../memory/memoryService';
import { getVectorStore } from '../../memory/vectorStore';

export const memoryTool: Tool = {
  name: 'memory',
  description: `Stores and retrieves long-term knowledge across sessions. Use to save important patterns, decisions, or user preferences that should persist. Supports store and search operations.`,
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['store', 'search'],
        description: 'Action to perform: "store" saves information, "search" recalls it.',
      },
      // --- Store params ---
      content: {
        type: 'string',
        description: '[store] The information to store in memory.',
      },
      category: {
        type: 'string',
        enum: ['preference', 'pattern', 'decision', 'context', 'insight', 'error_solution'],
        description: '[store] Category for organizing the memory.',
      },
      key: {
        type: 'string',
        description: '[store] Optional unique key for easy retrieval.',
      },
      confidence: {
        type: 'number',
        description: '[store] Confidence level for this memory (0-1, default: 1.0).',
      },
      // --- Search params ---
      query: {
        type: 'string',
        description: '[search] Natural language search query.',
      },
      source: {
        type: 'string',
        enum: ['knowledge', 'conversation', 'file', 'all'],
        description: '[search] Filter by source type (default: "all").',
      },
      limit: {
        type: 'number',
        description: '[search] Maximum number of results (default: 5).',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as string;

    if (action === 'store') {
      return executeStore(params, context);
    } else if (action === 'search') {
      return executeSearch(params);
    } else {
      return {
        success: false,
        error: `Unknown action: "${action}". Use "store" or "search".`,
      };
    }
  },
};

// ---------------------------------------------------------------------------
// Store implementation (from former memory_store tool)
// ---------------------------------------------------------------------------
async function executeStore(
  params: Record<string, unknown>,
  context: ToolContext
): Promise<ToolExecutionResult> {
  const content = params.content as string;
  const category = params.category as string;
  const key = params.key as string | undefined;
  const confidence = (params.confidence as number) ?? 1.0;

  if (!content || content.trim().length === 0) {
    return { success: false, error: 'Content is required and cannot be empty' };
  }

  if (!category) {
    return { success: false, error: 'Category is required for store action.' };
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
    await vectorStore.save();

    // If key provided, also store as project knowledge for direct retrieval
    if (key) {
      memoryService.saveProjectKnowledge(key, content, 'explicit', confidence);
    }

    const output = `Memory stored successfully:
- Category: ${category}
- Key: ${key || '(auto-generated)'}
- Confidence: ${confidence}
- Content preview: ${content.slice(0, 100)}${content.length > 100 ? '...' : ''}`;

    return { success: true, output };
  } catch (error) {
    return {
      success: false,
      error: `Failed to store memory: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Search implementation (from former memory_search tool)
// ---------------------------------------------------------------------------
async function executeSearch(
  params: Record<string, unknown>
): Promise<ToolExecutionResult> {
  const query = params.query as string;
  const category = params.category as string | undefined;
  const source = (params.source as string) || 'all';
  const limit = (params.limit as number) || 5;

  if (!query || query.trim().length === 0) {
    return { success: false, error: 'Query is required and cannot be empty' };
  }

  try {
    const memoryService = getMemoryService();
    const results: Array<{ source: string; content: string; score: number; metadata?: unknown }> = [];

    // Search knowledge base
    if (source === 'all' || source === 'knowledge') {
      const knowledgeResults = memoryService.searchKnowledge(query, category, limit);
      for (const result of knowledgeResults) {
        results.push({
          source: 'knowledge',
          content: result.document.content,
          score: result.score,
          metadata: result.document.metadata,
        });
      }
    }

    // Search conversations
    if (source === 'all' || source === 'conversation') {
      const convResults = memoryService.searchRelevantConversations(query, limit);
      for (const result of convResults) {
        results.push({
          source: 'conversation',
          content: result.document.content,
          score: result.score,
          metadata: result.document.metadata,
        });
      }
    }

    // Search indexed code files
    if (source === 'all' || source === 'file') {
      const codeResults = memoryService.searchRelevantCode(query, limit);
      for (const result of codeResults) {
        results.push({
          source: 'file',
          content: result.document.content,
          score: result.score,
          metadata: result.document.metadata,
        });
      }
    }

    // Sort by score and limit
    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, limit);

    if (topResults.length === 0) {
      return { success: true, output: `No memories found matching: "${query}"` };
    }

    // Format results
    const formattedResults = topResults.map((r, i) => {
      const preview = r.content.length > 200
        ? r.content.slice(0, 200) + '...'
        : r.content;
      const meta = r.metadata ? ` | ${JSON.stringify(r.metadata)}` : '';
      return `${i + 1}. [${r.source}] (score: ${r.score.toFixed(2)})${meta}
   ${preview}`;
    }).join('\n\n');

    return {
      success: true,
      output: `Found ${topResults.length} relevant memories for "${query}":\n\n${formattedResults}`,
    };
  } catch (error) {
    return {
      success: false,
      error: `Failed to search memories: ${error instanceof Error ? error.message : 'Unknown error'}`,
    };
  }
}
