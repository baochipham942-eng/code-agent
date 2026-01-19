// ============================================================================
// code_index Tool - Index and search code patterns across the codebase
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getMemoryService } from '../../memory/memoryService';
import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';

// Track indexing stats
const indexStats = {
  totalFiles: 0,
  indexedFiles: 0,
  lastIndexTime: 0,
  patterns: new Set<string>(),
};

export const codeIndexTool: Tool = {
  name: 'code_index',
  description: `Index and search code patterns across the codebase.

Use this tool to:
- Build semantic understanding of the codebase
- Find related code across files
- Identify patterns and anti-patterns
- Search for similar implementations

Actions:
- "index": Index files matching a pattern
- "search": Search indexed code semantically
- "status": Check indexing status

Parameters:
- action (required): 'index', 'search', or 'status'
- pattern (optional): Glob pattern for files to index
- query (optional): Search query for finding code
- limit (optional): Maximum search results (default: 5)`,
  generations: ['gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['index', 'search', 'status'],
        description: 'Action to perform',
      },
      pattern: {
        type: 'string',
        description: 'Glob pattern for files to index',
      },
      query: {
        type: 'string',
        description: 'Search query for finding code',
      },
      limit: {
        type: 'number',
        description: 'Maximum search results',
      },
    },
    required: ['action'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as string;
    const pattern = params.pattern as string | undefined;
    const query = params.query as string | undefined;
    const limit = (params.limit as number) || 5;
    const workDir = context.workingDirectory;

    try {
      switch (action) {
        case 'index':
          return await indexFiles(workDir, pattern || '**/*.{ts,tsx,js,jsx,py,go,rs}');

        case 'search':
          if (!query) {
            return {
              success: false,
              error: 'Query is required for search action',
            };
          }
          return await searchCode(workDir, query, limit);

        case 'status':
          return getStatus();

        default:
          return {
            success: false,
            error: `Unknown action: ${action}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: `Code index error: ${error instanceof Error ? error.message : 'Unknown error'}`,
      };
    }
  },
};

async function indexFiles(
  workDir: string,
  pattern: string
): Promise<ToolExecutionResult> {
  const memoryService = getMemoryService();

  // Find files matching pattern
  const files = await glob(pattern, {
    cwd: workDir,
    ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**'],
    nodir: true,
  });

  indexStats.totalFiles = files.length;
  indexStats.indexedFiles = 0;
  indexStats.patterns.add(pattern);

  const errors: string[] = [];
  const maxFiles = 100; // Limit to prevent overwhelming

  for (const file of files.slice(0, maxFiles)) {
    try {
      const filePath = path.join(workDir, file);
      const content = await fs.promises.readFile(filePath, 'utf-8');

      // Skip very large files
      if (content.length > 100000) {
        continue;
      }

      await memoryService.indexCodeFile(filePath, content);
      indexStats.indexedFiles++;
    } catch (err) {
      errors.push(`Failed to index ${file}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    }
  }

  indexStats.lastIndexTime = Date.now();

  let output = `Indexed ${indexStats.indexedFiles} of ${files.length} files matching "${pattern}"`;
  if (files.length > maxFiles) {
    output += `\n(Limited to first ${maxFiles} files)`;
  }
  if (errors.length > 0) {
    output += `\n\nErrors (${errors.length}):\n${errors.slice(0, 5).join('\n')}`;
    if (errors.length > 5) {
      output += `\n... and ${errors.length - 5} more`;
    }
  }

  return {
    success: true,
    output,
  };
}

async function searchCode(
  workDir: string,
  query: string,
  limit: number
): Promise<ToolExecutionResult> {
  const memoryService = getMemoryService();

  const results = memoryService.searchRelevantCode(query, limit);

  if (results.length === 0) {
    return {
      success: true,
      output: `No indexed code found matching: "${query}"\n\nTip: Run code_index with action="index" first to index your codebase.`,
    };
  }

  const formattedResults = results.map((r, i) => {
    const filePath = (r.document.metadata as { filePath?: string })?.filePath || 'Unknown file';
    const preview = r.document.content.length > 300
      ? r.document.content.slice(0, 300) + '...'
      : r.document.content;
    return `${i + 1}. ${filePath} (score: ${r.score.toFixed(2)})
\`\`\`
${preview}
\`\`\``;
  }).join('\n\n');

  return {
    success: true,
    output: `Found ${results.length} code matches for "${query}":\n\n${formattedResults}`,
  };
}

function getStatus(): ToolExecutionResult {
  const patterns = Array.from(indexStats.patterns);
  const lastIndexed = indexStats.lastIndexTime
    ? new Date(indexStats.lastIndexTime).toISOString()
    : 'Never';

  const output = `Code Index Status:
- Total files found: ${indexStats.totalFiles}
- Files indexed: ${indexStats.indexedFiles}
- Last indexed: ${lastIndexed}
- Patterns indexed: ${patterns.length > 0 ? patterns.join(', ') : 'None'}

Use action="index" with a pattern to index files.
Use action="search" with a query to find code.`;

  return {
    success: true,
    output,
  };
}
