// ============================================================================
// Diagnostics Tool - Query LSP diagnostics for files or project
// ============================================================================

import { pathToFileURL } from 'url';
import * as path from 'path';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getLSPManager, type LSPDiagnostic } from '../../lsp';

export const diagnosticsTool: Tool = {
  name: 'diagnostics',
  description: `Query LSP diagnostics (errors/warnings) for a file or the entire project.

Use this tool to:
- Check for compilation errors after edits
- Get all project-wide errors and warnings
- Verify code correctness before committing

Parameters:
- file_path (optional): Specific file to check. If omitted, returns all project diagnostics.
- severity_filter: Filter by severity - 'error', 'warning', or 'all' (default: 'all')

Note: Requires LSP servers to be running for the relevant file types.`,

  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',

  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'Optional file path to check. If omitted, returns all project diagnostics.',
      },
      severity_filter: {
        type: 'string',
        enum: ['error', 'warning', 'all'],
        description: 'Filter diagnostics by severity. Default: all',
      },
    },
    required: [],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const filePath = params.file_path as string | undefined;
    const severityFilter = (params.severity_filter as string) || 'all';

    const manager = getLSPManager();
    if (!manager) {
      return {
        success: false,
        error: 'LSP server manager not initialized. LSP features require language servers to be installed.',
      };
    }

    let diagnostics: LSPDiagnostic[];
    let scope: string;

    if (filePath) {
      const resolvedPath = path.resolve(context.workingDirectory, filePath);
      diagnostics = manager.getFileDiagnostics(resolvedPath);
      scope = path.relative(context.workingDirectory, resolvedPath) || resolvedPath;
    } else {
      // All project diagnostics
      const allDiagnostics = manager.getDiagnostics();
      diagnostics = [];
      for (const [, fileDiags] of allDiagnostics) {
        diagnostics.push(...fileDiags);
      }
      scope = 'project';
    }

    // Apply severity filter
    if (severityFilter === 'error') {
      diagnostics = diagnostics.filter((d) => d.severity === 1);
    } else if (severityFilter === 'warning') {
      diagnostics = diagnostics.filter((d) => d.severity === 2);
    } else {
      // 'all' - keep Error (1) and Warning (2), skip hints/info
      diagnostics = diagnostics.filter((d) => d.severity === 1 || d.severity === 2);
    }

    if (diagnostics.length === 0) {
      return {
        success: true,
        output: `No diagnostics found for ${scope} (filter: ${severityFilter})`,
      };
    }

    const errorCount = diagnostics.filter((d) => d.severity === 1).length;
    const warningCount = diagnostics.filter((d) => d.severity === 2).length;

    const summary: string[] = [];
    if (errorCount > 0) summary.push(`${errorCount} error${errorCount > 1 ? 's' : ''}`);
    if (warningCount > 0) summary.push(`${warningCount} warning${warningCount > 1 ? 's' : ''}`);

    const lines = [`Diagnostics for ${scope}: ${summary.join(', ')}`];

    if (filePath) {
      // Single file - just list diagnostics
      for (const d of diagnostics) {
        const severity = d.severity === 1 ? 'Error' : 'Warning';
        const line = d.range.start.line + 1;
        const char = d.range.start.character + 1;
        const source = d.source ? ` [${d.source}]` : '';
        lines.push(`  ${severity} L${line}:${char}: ${d.message}${source}`);
      }
    } else {
      // Project-wide - group by file
      const allDiagnostics = manager.getDiagnostics();
      for (const [uri, fileDiags] of allDiagnostics) {
        const filtered = fileDiags.filter((d) => {
          if (severityFilter === 'error') return d.severity === 1;
          if (severityFilter === 'warning') return d.severity === 2;
          return d.severity === 1 || d.severity === 2;
        });
        if (filtered.length === 0) continue;

        // Convert URI to relative path
        let decodedPath = uri.replace(/^file:\/\//, '');
        try { decodedPath = decodeURIComponent(decodedPath); } catch { /* use undecoded */ }
        const relativePath = path.relative(context.workingDirectory, decodedPath);
        const displayPath = relativePath.startsWith('..') ? decodedPath : relativePath;

        lines.push(`\n${displayPath}:`);
        for (const d of filtered) {
          const severity = d.severity === 1 ? 'Error' : 'Warning';
          const line = d.range.start.line + 1;
          const char = d.range.start.character + 1;
          const source = d.source ? ` [${d.source}]` : '';
          lines.push(`  ${severity} L${line}:${char}: ${d.message}${source}`);
        }
      }
    }

    return {
      success: true,
      output: lines.join('\n'),
      metadata: {
        errorCount,
        warningCount,
        scope,
      },
    };
  },
};
