// ============================================================================
// Code Index In-Process MCP Server
// 代码索引服务器，提供代码语义搜索和符号查找能力
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { InProcessMCPServer } from '../inProcessServer';
import { createLogger } from '../../services/infra/logger';
import { getMemoryService } from '../../memory/memoryService';
import type { ToolResult } from '../../../shared/types';

const logger = createLogger('CodeIndexServer');

// 索引统计信息
interface IndexStats {
  totalFiles: number;
  indexedFiles: number;
  lastIndexTime: number;
  indexedPatterns: string[];
  symbolCount: number;
}

// 符号类型
type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'variable' | 'const' | 'method' | 'property';

// 符号信息
interface SymbolInfo {
  name: string;
  kind: SymbolKind;
  filePath: string;
  line: number;
  column: number;
  signature?: string;
}

// 符号索引
interface SymbolIndex {
  symbols: Map<string, SymbolInfo[]>;
  fileSymbols: Map<string, string[]>;
}

/**
 * Code Index In-Process MCP Server
 *
 * 提供代码索引和语义搜索能力。
 *
 * 工具:
 * - code_index: 索引指定目录的代码文件
 * - code_search: 语义搜索代码
 * - find_symbol: 查找符号定义
 * - find_references: 查找符号引用
 * - index_status: 获取索引状态
 *
 * 资源:
 * - code://index/stats: 索引统计信息
 * - code://index/symbols: 已索引的符号列表
 */
export class CodeIndexServer extends InProcessMCPServer {
  private stats: IndexStats = {
    totalFiles: 0,
    indexedFiles: 0,
    lastIndexTime: 0,
    indexedPatterns: [],
    symbolCount: 0,
  };

  private symbolIndex: SymbolIndex = {
    symbols: new Map(),
    fileSymbols: new Map(),
  };

  constructor() {
    super('code-index');
  }

  // --------------------------------------------------------------------------
  // Symbol Extraction
  // --------------------------------------------------------------------------

  private extractSymbols(content: string, filePath: string): SymbolInfo[] {
    const symbols: SymbolInfo[] = [];
    const lines = content.split('\n');
    const ext = path.extname(filePath).toLowerCase();

    // TypeScript/JavaScript patterns
    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      this.extractTSSymbols(lines, filePath, symbols);
    }

    // Python patterns
    if (ext === '.py') {
      this.extractPySymbols(lines, filePath, symbols);
    }

    // Go patterns
    if (ext === '.go') {
      this.extractGoSymbols(lines, filePath, symbols);
    }

    // Rust patterns
    if (ext === '.rs') {
      this.extractRsSymbols(lines, filePath, symbols);
    }

    return symbols;
  }

  private extractTSSymbols(lines: string[], filePath: string, symbols: SymbolInfo[]): void {
    const funcPattern = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w+)/;
    const arrowPattern = /^(\s*)(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s*)?\(/;
    const classPattern = /^(\s*)(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/;
    const interfacePattern = /^(\s*)(?:export\s+)?interface\s+(\w+)/;
    const typePattern = /^(\s*)(?:export\s+)?type\s+(\w+)/;

    lines.forEach((line, index) => {
      let match;
      const lineNum = index + 1;

      if ((match = line.match(funcPattern))) {
        symbols.push({ name: match[2], kind: 'function', filePath, line: lineNum, column: match[1].length + 1, signature: line.trim() });
      } else if ((match = line.match(arrowPattern))) {
        symbols.push({ name: match[2], kind: 'function', filePath, line: lineNum, column: match[1].length + 1, signature: line.trim() });
      } else if ((match = line.match(classPattern))) {
        symbols.push({ name: match[2], kind: 'class', filePath, line: lineNum, column: match[1].length + 1, signature: line.trim() });
      } else if ((match = line.match(interfacePattern))) {
        symbols.push({ name: match[2], kind: 'interface', filePath, line: lineNum, column: match[1].length + 1, signature: line.trim() });
      } else if ((match = line.match(typePattern))) {
        symbols.push({ name: match[2], kind: 'type', filePath, line: lineNum, column: match[1].length + 1, signature: line.trim() });
      }
    });
  }

  private extractPySymbols(lines: string[], filePath: string, symbols: SymbolInfo[]): void {
    const defPattern = /^(\s*)(?:async\s+)?def\s+(\w+)/;
    const classPattern = /^(\s*)class\s+(\w+)/;

    lines.forEach((line, index) => {
      let match;
      const lineNum = index + 1;

      if ((match = line.match(defPattern))) {
        symbols.push({ name: match[2], kind: 'function', filePath, line: lineNum, column: match[1].length + 1, signature: line.trim() });
      } else if ((match = line.match(classPattern))) {
        symbols.push({ name: match[2], kind: 'class', filePath, line: lineNum, column: match[1].length + 1, signature: line.trim() });
      }
    });
  }

  private extractGoSymbols(lines: string[], filePath: string, symbols: SymbolInfo[]): void {
    const funcPattern = /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)/;
    const typePattern = /^type\s+(\w+)\s+(?:struct|interface)/;

    lines.forEach((line, index) => {
      let match;
      const lineNum = index + 1;

      if ((match = line.match(funcPattern))) {
        symbols.push({ name: match[1], kind: 'function', filePath, line: lineNum, column: 1, signature: line.trim() });
      } else if ((match = line.match(typePattern))) {
        symbols.push({ name: match[1], kind: line.includes('interface') ? 'interface' : 'class', filePath, line: lineNum, column: 1, signature: line.trim() });
      }
    });
  }

  private extractRsSymbols(lines: string[], filePath: string, symbols: SymbolInfo[]): void {
    const fnPattern = /^(\s*)(?:pub\s+)?(?:async\s+)?fn\s+(\w+)/;
    const structPattern = /^(\s*)(?:pub\s+)?struct\s+(\w+)/;
    const enumPattern = /^(\s*)(?:pub\s+)?enum\s+(\w+)/;
    const traitPattern = /^(\s*)(?:pub\s+)?trait\s+(\w+)/;

    lines.forEach((line, index) => {
      let match;
      const lineNum = index + 1;

      if ((match = line.match(fnPattern))) {
        symbols.push({ name: match[2], kind: 'function', filePath, line: lineNum, column: match[1].length + 1, signature: line.trim() });
      } else if ((match = line.match(structPattern))) {
        symbols.push({ name: match[2], kind: 'class', filePath, line: lineNum, column: match[1].length + 1, signature: line.trim() });
      } else if ((match = line.match(enumPattern))) {
        symbols.push({ name: match[2], kind: 'type', filePath, line: lineNum, column: match[1].length + 1, signature: line.trim() });
      } else if ((match = line.match(traitPattern))) {
        symbols.push({ name: match[2], kind: 'interface', filePath, line: lineNum, column: match[1].length + 1, signature: line.trim() });
      }
    });
  }

  private findReferences(content: string, symbolName: string): Array<{ line: number; column: number; context: string }> {
    const references: Array<{ line: number; column: number; context: string }> = [];
    const lines = content.split('\n');

    // Word boundary regex for the symbol - escape special chars
    const escapedName = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escapedName}\\b`, 'g');

    lines.forEach((line, index) => {
      let match;
      while ((match = pattern.exec(line)) !== null) {
        references.push({
          line: index + 1,
          column: match.index + 1,
          context: line.trim(),
        });
      }
    });

    return references;
  }

  // --------------------------------------------------------------------------
  // Tool Registration
  // --------------------------------------------------------------------------

  protected async registerTools(): Promise<void> {
    // code_index - 索引代码文件
    this.addTool({
      definition: {
        name: 'code_index',
        description: `Index code files in a directory for semantic search and symbol lookup.

Parameters:
- path (required): Directory path to index
- pattern (optional): Glob pattern for files (default: **/*.{ts,tsx,js,jsx,py,go,rs})
- maxFiles (optional): Maximum files to index (default: 500)`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'Directory path to index' },
            pattern: { type: 'string', description: 'Glob pattern for files' },
            maxFiles: { type: 'number', description: 'Maximum files to index' },
          },
          required: ['path'],
        },
        generations: ['gen5', 'gen6', 'gen7', 'gen8'],
        requiresPermission: false,
        permissionLevel: 'read',
      },
      handler: async (args, toolCallId): Promise<ToolResult> => {
        const { path: indexPath, pattern = '**/*.{ts,tsx,js,jsx,py,go,rs}', maxFiles = 500 } = args as { path: string; pattern?: string; maxFiles?: number };

        if (!indexPath) {
          return { toolCallId, success: false, error: 'Path is required' };
        }

        const absolutePath = path.isAbsolute(indexPath) ? indexPath : path.resolve(process.cwd(), indexPath);

        if (!fs.existsSync(absolutePath)) {
          return { toolCallId, success: false, error: `Path does not exist: ${absolutePath}` };
        }

        try {
          const files = await glob(pattern, {
            cwd: absolutePath,
            ignore: ['**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**', '**/vendor/**'],
            nodir: true,
          });

          this.stats.totalFiles = files.length;
          this.stats.indexedFiles = 0;
          this.stats.indexedPatterns.push(pattern);

          const memoryService = getMemoryService();
          const errors: string[] = [];
          const filesToIndex = files.slice(0, maxFiles);

          for (const file of filesToIndex) {
            try {
              const filePath = path.join(absolutePath, file);
              const content = await fs.promises.readFile(filePath, 'utf-8');

              if (content.length > 100000) continue;

              await memoryService.indexCodeFile(filePath, content);

              const symbols = this.extractSymbols(content, filePath);
              for (const symbol of symbols) {
                const existing = this.symbolIndex.symbols.get(symbol.name) || [];
                existing.push(symbol);
                this.symbolIndex.symbols.set(symbol.name, existing);
              }

              this.symbolIndex.fileSymbols.set(filePath, symbols.map(s => s.name));
              this.stats.indexedFiles++;
            } catch (err) {
              errors.push(`${file}: ${err instanceof Error ? err.message : 'Unknown error'}`);
            }
          }

          this.stats.lastIndexTime = Date.now();
          this.stats.symbolCount = this.symbolIndex.symbols.size;

          let output = `Indexed ${this.stats.indexedFiles} of ${files.length} files matching "${pattern}"`;
          output += `\nExtracted ${this.stats.symbolCount} unique symbols`;
          if (files.length > maxFiles) output += `\n(Limited to first ${maxFiles} files)`;
          if (errors.length > 0) {
            output += `\n\nErrors (${errors.length}):\n${errors.slice(0, 5).join('\n')}`;
            if (errors.length > 5) output += `\n... and ${errors.length - 5} more`;
          }

          return { toolCallId, success: true, output };
        } catch (error) {
          return { toolCallId, success: false, error: `Failed to index: ${error instanceof Error ? error.message : 'Unknown error'}` };
        }
      },
    });

    // code_search - 语义搜索代码
    this.addTool({
      definition: {
        name: 'code_search',
        description: `Search indexed code using semantic/natural language queries.

Parameters:
- query (required): Natural language search query
- limit (optional): Maximum results (default: 5)`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Natural language search query' },
            limit: { type: 'number', description: 'Maximum results' },
          },
          required: ['query'],
        },
        generations: ['gen5', 'gen6', 'gen7', 'gen8'],
        requiresPermission: false,
        permissionLevel: 'read',
      },
      handler: async (args, toolCallId): Promise<ToolResult> => {
        const { query, limit = 5 } = args as { query: string; limit?: number };

        if (!query) {
          return { toolCallId, success: false, error: 'Query is required' };
        }

        try {
          const memoryService = getMemoryService();
          const results = memoryService.searchRelevantCode(query, limit);

          if (results.length === 0) {
            return { toolCallId, success: true, output: `No indexed code found matching: "${query}"\n\nTip: Run code_index first to index your codebase.` };
          }

          const formattedResults = results.map((r, i) => {
            const filePath = (r.document.metadata as { filePath?: string })?.filePath || 'Unknown file';
            const preview = r.document.content.length > 300 ? r.document.content.slice(0, 300) + '...' : r.document.content;
            return `${i + 1}. ${filePath} (score: ${r.score.toFixed(2)})\n\`\`\`\n${preview}\n\`\`\``;
          }).join('\n\n');

          return { toolCallId, success: true, output: `Found ${results.length} code matches for "${query}":\n\n${formattedResults}` };
        } catch (error) {
          return { toolCallId, success: false, error: `Search failed: ${error instanceof Error ? error.message : 'Unknown error'}` };
        }
      },
    });

    // find_symbol - 查找符号定义
    this.addTool({
      definition: {
        name: 'find_symbol',
        description: `Find symbol definitions (functions, classes, interfaces, etc.) by name.

Parameters:
- name (required): Symbol name to find
- kind (optional): Filter by symbol kind (function, class, interface, type)`,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Symbol name to find' },
            kind: { type: 'string', enum: ['function', 'class', 'interface', 'type', 'variable', 'const', 'method', 'property'], description: 'Filter by symbol kind' },
          },
          required: ['name'],
        },
        generations: ['gen5', 'gen6', 'gen7', 'gen8'],
        requiresPermission: false,
        permissionLevel: 'read',
      },
      handler: async (args, toolCallId): Promise<ToolResult> => {
        const { name, kind } = args as { name: string; kind?: SymbolKind };

        if (!name) {
          return { toolCallId, success: false, error: 'Symbol name is required' };
        }

        let symbols = this.symbolIndex.symbols.get(name) || [];

        if (symbols.length === 0) {
          const allSymbols = Array.from(this.symbolIndex.symbols.entries());
          for (const [symbolName, defs] of allSymbols) {
            if (symbolName.toLowerCase().includes(name.toLowerCase())) {
              symbols.push(...defs);
            }
          }
        }

        if (kind) {
          symbols = symbols.filter(s => s.kind === kind);
        }

        if (symbols.length === 0) {
          return { toolCallId, success: true, output: `No symbols found matching "${name}"${kind ? ` of kind ${kind}` : ''}\n\nTip: Run code_index first to index your codebase.` };
        }

        const formattedResults = symbols.map((s, i) => `${i + 1}. [${s.kind}] ${s.name}\n   ${s.filePath}:${s.line}:${s.column}\n   ${s.signature || ''}`).join('\n\n');

        return { toolCallId, success: true, output: `Found ${symbols.length} symbol(s) matching "${name}":\n\n${formattedResults}` };
      },
    });

    // find_references - 查找符号引用
    this.addTool({
      definition: {
        name: 'find_references',
        description: `Find all references to a symbol across indexed files.

Parameters:
- name (required): Symbol name to find references for
- limit (optional): Maximum files to search (default: 50)`,
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Symbol name to find references for' },
            limit: { type: 'number', description: 'Maximum files to search' },
          },
          required: ['name'],
        },
        generations: ['gen5', 'gen6', 'gen7', 'gen8'],
        requiresPermission: false,
        permissionLevel: 'read',
      },
      handler: async (args, toolCallId): Promise<ToolResult> => {
        const { name, limit = 50 } = args as { name: string; limit?: number };

        if (!name) {
          return { toolCallId, success: false, error: 'Symbol name is required' };
        }

        const allFiles = Array.from(this.symbolIndex.fileSymbols.keys()).slice(0, limit);
        const allReferences: Array<{ file: string; refs: Array<{ line: number; context: string }> }> = [];

        for (const filePath of allFiles) {
          try {
            const content = await fs.promises.readFile(filePath, 'utf-8');
            const refs = this.findReferences(content, name);
            if (refs.length > 0) {
              allReferences.push({ file: filePath, refs: refs.map(r => ({ line: r.line, context: r.context })) });
            }
          } catch {
            // Skip unreadable files
          }
        }

        if (allReferences.length === 0) {
          return { toolCallId, success: true, output: `No references found for "${name}" in ${allFiles.length} indexed files.` };
        }

        const totalRefs = allReferences.reduce((sum, r) => sum + r.refs.length, 0);
        const formattedResults = allReferences.slice(0, 10).map((r) => {
          const refs = r.refs.slice(0, 3).map(ref => `   L${ref.line}: ${ref.context}`).join('\n');
          const more = r.refs.length > 3 ? `\n   ... and ${r.refs.length - 3} more` : '';
          return `${r.file}\n${refs}${more}`;
        }).join('\n\n');

        let output = `Found ${totalRefs} reference(s) to "${name}" in ${allReferences.length} file(s):\n\n${formattedResults}`;
        if (allReferences.length > 10) output += `\n\n... and ${allReferences.length - 10} more files`;

        return { toolCallId, success: true, output };
      },
    });

    // index_status - 获取索引状态
    this.addTool({
      definition: {
        name: 'index_status',
        description: 'Get the current status of the code index.',
        inputSchema: { type: 'object', properties: {} },
        generations: ['gen5', 'gen6', 'gen7', 'gen8'],
        requiresPermission: false,
        permissionLevel: 'read',
      },
      handler: async (_, toolCallId): Promise<ToolResult> => {
        const lastIndexed = this.stats.lastIndexTime ? new Date(this.stats.lastIndexTime).toISOString() : 'Never';

        const output = `Code Index Status:
- Total files found: ${this.stats.totalFiles}
- Files indexed: ${this.stats.indexedFiles}
- Unique symbols: ${this.stats.symbolCount}
- Last indexed: ${lastIndexed}
- Patterns indexed: ${this.stats.indexedPatterns.length > 0 ? this.stats.indexedPatterns.join(', ') : 'None'}

Use code_index with a path to index files.
Use code_search with a query to find code.
Use find_symbol to find symbol definitions.
Use find_references to find symbol usages.`;

        return { toolCallId, success: true, output };
      },
    });
  }

  // --------------------------------------------------------------------------
  // Resource Registration
  // --------------------------------------------------------------------------

  protected async registerResources(): Promise<void> {
    this.addResource({
      uri: 'code://index/stats',
      name: 'Code Index Statistics',
      description: 'Statistics about the code index',
      mimeType: 'application/json',
      handler: async () => JSON.stringify({
        totalFiles: this.stats.totalFiles,
        indexedFiles: this.stats.indexedFiles,
        symbolCount: this.stats.symbolCount,
        lastIndexTime: this.stats.lastIndexTime ? new Date(this.stats.lastIndexTime).toISOString() : null,
        indexedPatterns: this.stats.indexedPatterns,
      }, null, 2),
    });

    this.addResource({
      uri: 'code://index/symbols',
      name: 'Indexed Symbols',
      description: 'List of all indexed symbols',
      mimeType: 'application/json',
      handler: async () => {
        const symbols: Array<{ name: string; count: number; kinds: string[] }> = [];
        for (const [name, defs] of this.symbolIndex.symbols.entries()) {
          symbols.push({ name, count: defs.length, kinds: [...new Set(defs.map(d => d.kind))] });
        }
        symbols.sort((a, b) => a.name.localeCompare(b.name));
        return JSON.stringify({ totalSymbols: symbols.length, symbols: symbols.slice(0, 100) }, null, 2);
      },
    });
  }
}

// Factory function
export function createCodeIndexServer(): CodeIndexServer {
  return new CodeIndexServer();
}
