// ============================================================================
// LSP Tool - Language Server Protocol Operations
// ============================================================================
// Provides code intelligence features through LSP:
// - Go to Definition
// - Find References
// - Hover Information
// - Document Symbols
// - Workspace Symbols
// - Go to Implementation
// - Call Hierarchy
// ============================================================================

import * as path from 'path';
import * as fs from 'fs/promises';
import { pathToFileURL } from 'url';
import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import { getLSPManager } from '../../lsp';

// ============================================================================
// Types
// ============================================================================

type LSPOperation =
  | 'goToDefinition'
  | 'findReferences'
  | 'hover'
  | 'documentSymbol'
  | 'workspaceSymbol'
  | 'goToImplementation'
  | 'prepareCallHierarchy'
  | 'incomingCalls'
  | 'outgoingCalls';

interface NormalizedLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end?: { line: number; character: number };
  };
}

// ============================================================================
// Tool Definition
// ============================================================================

export const lspTool: Tool = {
  name: 'lsp',
  description: `Interact with Language Server Protocol (LSP) servers for code intelligence.

Supported operations:
- goToDefinition: Find where a symbol is defined
- findReferences: Find all references to a symbol
- hover: Get hover information (documentation, type info) for a symbol
- documentSymbol: Get all symbols (functions, classes, variables) in a document
- workspaceSymbol: Search for symbols across the entire workspace
- goToImplementation: Find implementations of an interface or abstract method
- prepareCallHierarchy: Get call hierarchy item at a position
- incomingCalls: Find all functions/methods that call the function at a position
- outgoingCalls: Find all functions/methods called by the function at a position

All operations require:
- filePath: The file to operate on (absolute path)
- line: The line number (1-based, as shown in editors)
- character: The character offset (1-based, as shown in editors)

Note: LSP servers must be configured and running for the file type.
Supported: TypeScript (.ts, .tsx, .js, .jsx), Python (.py)`,

  generations: ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',

  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'goToDefinition',
          'findReferences',
          'hover',
          'documentSymbol',
          'workspaceSymbol',
          'goToImplementation',
          'prepareCallHierarchy',
          'incomingCalls',
          'outgoingCalls',
        ],
        description: 'The LSP operation to perform',
      },
      file_path: {
        type: 'string',
        description: 'The absolute path to the file',
      },
      line: {
        type: 'number',
        description: 'The line number (1-based, as shown in editors)',
      },
      character: {
        type: 'number',
        description: 'The character offset (1-based, as shown in editors)',
      },
    },
    required: ['operation', 'file_path', 'line', 'character'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const operation = params.operation as LSPOperation;
    const filePath = params.file_path as string;
    const line = params.line as number;
    const character = params.character as number;

    const manager = getLSPManager();

    if (!manager) {
      return {
        success: false,
        error:
          'LSP server manager not initialized. ' +
          'LSP features require language servers to be installed and configured.',
      };
    }

    const resolvedPath = path.resolve(context.workingDirectory, filePath);
    const workingDir = context.workingDirectory;

    // Build LSP request
    const uri = pathToFileURL(resolvedPath).href;
    const position = {
      line: line - 1, // Convert to 0-based
      character: character - 1,
    };

    try {
      // Open file if not already open
      if (!manager.isFileOpen(resolvedPath)) {
        const content = await fs.readFile(resolvedPath, 'utf-8');
        await manager.openFile(resolvedPath, content);
      }

      // Build and send request
      const { method, requestParams } = buildLSPRequest(operation, uri, position);
      let result = await manager.sendRequest(resolvedPath, method, requestParams);

      if (result === undefined) {
        return {
          success: false,
          error: `No LSP server available for file type: ${path.extname(resolvedPath)}`,
        };
      }

      // Handle incoming/outgoing calls (requires second request)
      if (operation === 'incomingCalls' || operation === 'outgoingCalls') {
        const items = result;

        if (!items || items.length === 0) {
          return {
            success: true,
            output: 'No call hierarchy item found at this position',
          };
        }

        const secondMethod =
          operation === 'incomingCalls'
            ? 'callHierarchy/incomingCalls'
            : 'callHierarchy/outgoingCalls';

        result = await manager.sendRequest(resolvedPath, secondMethod, { item: items[0] });

        if (result === undefined) {
          return {
            success: false,
            error: 'LSP server did not return call hierarchy results',
          };
        }
      }

      // Format result
      const { formatted, resultCount, fileCount } = formatResult(operation, result, workingDir);

      return {
        success: true,
        output: formatted,
        metadata: {
          operation,
          filePath: resolvedPath,
          resultCount,
          fileCount,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: `Error performing ${operation}: ${message}`,
      };
    }
  },
};

// ============================================================================
// Helper Functions
// ============================================================================

function buildLSPRequest(
  operation: LSPOperation,
  uri: string,
  position: { line: number; character: number }
): { method: string; requestParams: any } {
  const textDocument = { uri };

  switch (operation) {
    case 'goToDefinition':
      return {
        method: 'textDocument/definition',
        requestParams: { textDocument, position },
      };

    case 'findReferences':
      return {
        method: 'textDocument/references',
        requestParams: { textDocument, position, context: { includeDeclaration: true } },
      };

    case 'hover':
      return {
        method: 'textDocument/hover',
        requestParams: { textDocument, position },
      };

    case 'documentSymbol':
      return {
        method: 'textDocument/documentSymbol',
        requestParams: { textDocument },
      };

    case 'workspaceSymbol':
      return {
        method: 'workspace/symbol',
        requestParams: { query: '' },
      };

    case 'goToImplementation':
      return {
        method: 'textDocument/implementation',
        requestParams: { textDocument, position },
      };

    case 'prepareCallHierarchy':
    case 'incomingCalls':
    case 'outgoingCalls':
      return {
        method: 'textDocument/prepareCallHierarchy',
        requestParams: { textDocument, position },
      };

    default:
      throw new Error(`Unsupported operation: ${operation}`);
  }
}

function formatResult(
  operation: LSPOperation,
  result: any,
  workingDir: string
): { formatted: string; resultCount: number; fileCount: number } {
  switch (operation) {
    case 'goToDefinition':
    case 'goToImplementation':
      return formatLocationResult(result, workingDir);

    case 'findReferences':
      return formatReferencesResult(result, workingDir);

    case 'hover':
      return formatHoverResult(result);

    case 'documentSymbol':
      return formatDocumentSymbolResult(result);

    case 'workspaceSymbol':
      return formatWorkspaceSymbolResult(result, workingDir);

    case 'prepareCallHierarchy':
      return formatCallHierarchyResult(result, workingDir);

    case 'incomingCalls':
    case 'outgoingCalls':
      return formatCallsResult(operation, result, workingDir);

    default:
      return {
        formatted: JSON.stringify(result, null, 2),
        resultCount: 0,
        fileCount: 0,
      };
  }
}

function formatLocationResult(
  result: any,
  workingDir: string
): { formatted: string; resultCount: number; fileCount: number } {
  const locations = Array.isArray(result) ? result : result ? [result] : [];
  const validLocations = locations.filter(isValidLocation);

  if (validLocations.length === 0) {
    return {
      formatted:
        'No definition found. The symbol may not be defined in the workspace, ' +
        'or the LSP server has not fully indexed the file.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  if (validLocations.length === 1) {
    const normalized = normalizeLocation(validLocations[0]);
    const locationStr = formatLocationString(normalized, workingDir);
    return {
      formatted: `Definition found at ${locationStr}`,
      resultCount: 1,
      fileCount: 1,
    };
  }

  const normalizedLocations = validLocations.map(normalizeLocation);
  const grouped = groupByFile(normalizedLocations, workingDir);
  const lines = [`Found ${normalizedLocations.length} definitions across ${grouped.size} files:`];

  for (const [file, locs] of grouped) {
    lines.push(`\n${file}:`);
    for (const loc of locs) {
      const line = loc.range.start.line + 1;
      const char = loc.range.start.character + 1;
      lines.push(`  Line ${line}:${char}`);
    }
  }

  return {
    formatted: lines.join('\n'),
    resultCount: normalizedLocations.length,
    fileCount: grouped.size,
  };
}

function formatReferencesResult(
  result: any,
  workingDir: string
): { formatted: string; resultCount: number; fileCount: number } {
  if (!result || result.length === 0) {
    return {
      formatted:
        'No references found. The symbol may not be used elsewhere, ' +
        'or the LSP server has not fully indexed the project.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  const validReferences = result.filter(isValidLocation);

  if (validReferences.length === 0) {
    return {
      formatted: 'No references found.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  const normalizedReferences = validReferences.map(normalizeLocation);
  const grouped = groupByFile(normalizedReferences, workingDir);
  const lines = [
    `Found ${normalizedReferences.length} reference${normalizedReferences.length === 1 ? '' : 's'} across ${grouped.size} file${grouped.size === 1 ? '' : 's'}:`,
  ];

  for (const [file, refs] of grouped) {
    lines.push(`\n${file}:`);
    for (const ref of refs) {
      const line = ref.range.start.line + 1;
      const char = ref.range.start.character + 1;
      lines.push(`  Line ${line}:${char}`);
    }
  }

  return {
    formatted: lines.join('\n'),
    resultCount: normalizedReferences.length,
    fileCount: grouped.size,
  };
}

function formatHoverResult(result: any): { formatted: string; resultCount: number; fileCount: number } {
  if (!result) {
    return {
      formatted:
        'No hover information available. The cursor may not be on a symbol, ' +
        'or the LSP server has not fully indexed the file.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  let content = '';

  if (Array.isArray(result.contents)) {
    content = result.contents
      .map((c: any) => (typeof c === 'string' ? c : c.value))
      .join('\n\n');
  } else if (typeof result.contents === 'string') {
    content = result.contents;
  } else {
    content = result.contents.value;
  }

  if (result.range) {
    const line = result.range.start.line + 1;
    const char = result.range.start.character + 1;
    content = `Hover info at ${line}:${char}:\n\n${content}`;
  }

  return {
    formatted: content,
    resultCount: 1,
    fileCount: 1,
  };
}

function formatDocumentSymbolResult(result: any): { formatted: string; resultCount: number; fileCount: number } {
  const symbols = result || [];

  if (symbols.length === 0) {
    return {
      formatted: 'No symbols found in document.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  const count = countSymbols(symbols);
  const lines = [`Found ${count} symbol${count === 1 ? '' : 's'} in document:`];

  for (const symbol of symbols) {
    const kind = symbolKindToString(symbol.kind);
    const line = symbol.range?.start?.line + 1 || symbol.location?.range?.start?.line + 1 || '?';
    let text = `  ${symbol.name} (${kind}) - Line ${line}`;

    if (symbol.containerName) {
      text += ` in ${symbol.containerName}`;
    }

    lines.push(text);
  }

  return {
    formatted: lines.join('\n'),
    resultCount: count,
    fileCount: 1,
  };
}

function formatWorkspaceSymbolResult(
  result: any,
  workingDir: string
): { formatted: string; resultCount: number; fileCount: number } {
  if (!result || result.length === 0) {
    return {
      formatted: 'No symbols found in workspace.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  const symbols = result.filter(
    (s: any) => s && s.location && s.location.uri && isValidLocation(s.location)
  );

  if (symbols.length === 0) {
    return {
      formatted: 'No symbols found in workspace.',
      resultCount: 0,
      fileCount: 0,
    };
  }

  const grouped = new Map<string, any[]>();

  for (const sym of symbols) {
    const filePath = uriToPath(sym.location.uri, workingDir);
    if (!grouped.has(filePath)) {
      grouped.set(filePath, []);
    }
    grouped.get(filePath)!.push(sym);
  }

  const lines = [`Found ${symbols.length} symbol${symbols.length === 1 ? '' : 's'} in workspace:`];

  for (const [file, syms] of grouped) {
    lines.push(`\n${file}:`);
    for (const sym of syms) {
      const kind = symbolKindToString(sym.kind);
      const line = sym.location.range.start.line + 1;
      let text = `  ${sym.name} (${kind}) - Line ${line}`;

      if (sym.containerName) {
        text += ` in ${sym.containerName}`;
      }

      lines.push(text);
    }
  }

  return {
    formatted: lines.join('\n'),
    resultCount: symbols.length,
    fileCount: grouped.size,
  };
}

function formatCallHierarchyResult(
  result: any,
  workingDir: string
): { formatted: string; resultCount: number; fileCount: number } {
  if (!result || result.length === 0) {
    return {
      formatted: 'No call hierarchy item found at this position',
      resultCount: 0,
      fileCount: 0,
    };
  }

  const items = result;

  if (items.length === 1) {
    const item = items[0];
    const filePath = uriToPath(item.uri, workingDir);
    const kind = symbolKindToString(item.kind);
    const line = item.range.start.line + 1;

    return {
      formatted: `Call hierarchy item: ${item.name} (${kind}) - ${filePath}:${line}`,
      resultCount: 1,
      fileCount: 1,
    };
  }

  const lines = [`Found ${items.length} call hierarchy items:`];
  for (const item of items) {
    const filePath = uriToPath(item.uri, workingDir);
    const kind = symbolKindToString(item.kind);
    const line = item.range.start.line + 1;
    lines.push(`  ${item.name} (${kind}) - ${filePath}:${line}`);
  }

  return {
    formatted: lines.join('\n'),
    resultCount: items.length,
    fileCount: new Set(items.map((i: any) => i.uri).filter(Boolean)).size,
  };
}

function formatCallsResult(
  operation: LSPOperation,
  result: any,
  workingDir: string
): { formatted: string; resultCount: number; fileCount: number } {
  if (!result || result.length === 0) {
    const type = operation === 'incomingCalls' ? 'incoming' : 'outgoing';
    return {
      formatted: `No ${type} calls found`,
      resultCount: 0,
      fileCount: 0,
    };
  }

  const isIncoming = operation === 'incomingCalls';
  const callItem = isIncoming ? 'from' : 'to';

  const validCalls = result.filter((call: any) => {
    const item = call[callItem];
    return item && item.uri && item.range;
  });

  if (validCalls.length === 0) {
    const type = operation === 'incomingCalls' ? 'incoming' : 'outgoing';
    return {
      formatted: `No ${type} calls found`,
      resultCount: 0,
      fileCount: 0,
    };
  }

  const label = isIncoming ? 'caller' : 'callee';
  const lines = [`Found ${validCalls.length} ${label}${validCalls.length === 1 ? '' : 's'}:`];

  const grouped = new Map<string, any[]>();

  for (const call of validCalls) {
    const item = call[callItem];
    const filePath = uriToPath(item.uri, workingDir);
    if (!grouped.has(filePath)) {
      grouped.set(filePath, []);
    }
    grouped.get(filePath)!.push(call);
  }

  for (const [file, fileCalls] of grouped) {
    lines.push(`\n${file}:`);
    for (const call of fileCalls) {
      const item = call[callItem];
      const kind = symbolKindToString(item.kind);
      const line = item.range.start.line + 1;
      lines.push(`  ${item.name} (${kind}) - Line ${line}`);
    }
  }

  return {
    formatted: lines.join('\n'),
    resultCount: validCalls.length,
    fileCount: grouped.size,
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

function isValidLocation(loc: unknown): boolean {
  if (!loc || typeof loc !== 'object') return false;
  if (!('uri' in loc) && !('targetUri' in loc) && !('location' in loc)) {
    return false;
  }
  return true;
}

function normalizeLocation(loc: any): NormalizedLocation {
  if ('targetUri' in loc) {
    return {
      uri: loc.targetUri,
      range: loc.targetSelectionRange || loc.targetRange,
    };
  }
  if ('location' in loc) {
    return {
      uri: loc.location.uri,
      range: loc.location.range,
    };
  }
  return {
    uri: loc.uri,
    range: loc.range,
  };
}

function formatLocationString(loc: NormalizedLocation, workingDir: string): string {
  const filePath = uriToPath(loc.uri, workingDir);
  const line = loc.range.start.line + 1;
  const char = loc.range.start.character + 1;
  return `${filePath}:${line}:${char}`;
}

function groupByFile(locations: NormalizedLocation[], workingDir: string): Map<string, NormalizedLocation[]> {
  const grouped = new Map<string, NormalizedLocation[]>();

  for (const loc of locations) {
    const filePath = uriToPath(loc.uri, workingDir);

    if (!grouped.has(filePath)) {
      grouped.set(filePath, []);
    }

    grouped.get(filePath)!.push(loc);
  }

  return grouped;
}

function uriToPath(uri: string, workingDir?: string): string {
  let decoded = uri.replace(/^file:\/\//, '');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    // Use undecoded path
  }

  if (workingDir) {
    const relativePath = path.relative(workingDir, decoded);
    return relativePath.startsWith('..') ? decoded : relativePath;
  }

  return decoded;
}

function countSymbols(symbols: any[]): number {
  let count = symbols.length;

  for (const sym of symbols) {
    if (sym.children && sym.children.length > 0) {
      count += countSymbols(sym.children);
    }
  }

  return count;
}

function symbolKindToString(kind: number): string {
  const kinds: Record<number, string> = {
    1: 'File',
    2: 'Module',
    3: 'Namespace',
    4: 'Package',
    5: 'Class',
    6: 'Method',
    7: 'Property',
    8: 'Field',
    9: 'Constructor',
    10: 'Enum',
    11: 'Interface',
    12: 'Function',
    13: 'Variable',
    14: 'Constant',
    15: 'String',
    16: 'Number',
    17: 'Boolean',
    18: 'Array',
    19: 'Object',
    20: 'Key',
    21: 'Null',
    22: 'EnumMember',
    23: 'Struct',
    24: 'Event',
    25: 'Operator',
    26: 'TypeParameter',
  };

  return kinds[kind] || 'Unknown';
}
