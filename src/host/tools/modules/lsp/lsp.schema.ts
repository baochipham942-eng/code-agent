// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time, so it can be
// eager-imported by modules/index.ts without inflating the dependency graph.
import type { ToolSchema } from '../../../protocol/tools';

export const LSP_DESCRIPTION = `Interact with Language Server Protocol (LSP) servers for code intelligence.

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
Supported: TypeScript (.ts, .tsx, .js, .jsx), Python (.py)`;

export const LSP_INPUT_SCHEMA = {
  type: 'object' as const,
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
};

export const lspSchema: ToolSchema = {
  name: 'lsp',
  description: LSP_DESCRIPTION,
  inputSchema: LSP_INPUT_SCHEMA,
  category: 'lsp',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
