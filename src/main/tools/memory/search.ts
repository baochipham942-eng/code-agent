// ============================================================================
// memory_search Tool - Search through stored memories and knowledge
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getMemoryService } from '../../memory/memoryService';

export const memorySearchTool: Tool = {
  name: 'memory_search',
  description: `Search through stored memories and knowledge base.

Use this tool to:
- Recall previous solutions to similar problems
- Find relevant code patterns
- Retrieve user preferences
- Access project-specific knowledge
- Search past conversations

Parameters:
- query (required): Natural language search query
- category (optional): Filter by category
- source (optional): Filter by source type ('knowledge', 'conversation', 'file', 'all')
- limit (optional): Maximum number of results (default: 5)`,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Natural language search query',
      },
      category: {
        type: 'string',
        enum: ['preference', 'pattern', 'decision', 'context', 'insight', 'error_solution'],
        description: 'Filter results by category',
      },
      source: {
        type: 'string',
        enum: ['knowledge', 'conversation', 'file', 'all'],
        description: 'Filter by source type',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of results',
      },
    },
    required: ['query'],
  },

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const query = params.query as string;
    const category = params.category as string | undefined;
    const source = (params.source as string) || 'all';
    const limit = (params.limit as number) || 5;

    if (!query || query.trim().length === 0) {
      return {
        success: false,
        error: 'Query is required and cannot be empty',
      };
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
        return {
          success: true,
          output: `No memories found matching: "${query}"`,
        };
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
  },
};
