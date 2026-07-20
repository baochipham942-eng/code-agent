// ============================================================================
// Code Index In-Process MCP Server
// 代码索引服务器，提供代码语义搜索和符号查找能力
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import { InProcessMCPServer } from '../inProcessServer';
import type { ToolResult } from '../../../shared/contract';
import { makeEvidenceRef, type EvidenceRef } from '../../../shared/contract/evidence';

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

interface IndexedFile {
  filePath: string;
  content: string;
  lines: string[];
}

interface CodeSearchMatch {
  filePath: string;
  startLine: number;
  endLine: number;
  score: number;
  reasons: string[];
  snippet: string;
  evidenceRef: EvidenceRef;
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

  private fileIndex: Map<string, IndexedFile> = new Map();

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

  private tokenizeQuery(query: string): string[] {
    return Array.from(new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9_]+/i)
        .map((token) => token.trim())
        .filter((token) => token.length >= 2),
    ));
  }

  private scoreLine(line: string, query: string, queryTerms: string[]): { score: number; matchedTerms: string[] } {
    const lowerLine = line.toLowerCase();
    const lowerQuery = query.toLowerCase();
    let score = lowerLine.includes(lowerQuery) ? 8 : 0;
    const matchedTerms: string[] = [];

    for (const term of queryTerms) {
      const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
      const matches = lowerLine.match(pattern);
      if (matches?.length) {
        score += matches.length * 2;
        matchedTerms.push(term);
      } else if (lowerLine.includes(term)) {
        score += 1;
        matchedTerms.push(term);
      }
    }

    return { score, matchedTerms };
  }

  private buildSnippet(lines: string[], startLine: number, endLine: number): string {
    return lines
      .slice(startLine - 1, endLine)
      .map((line, index) => `${String(startLine + index).padStart(4, ' ')} | ${line}`)
      .join('\n');
  }

  private makeCandidateEvidence(filePath: string, startLine: number, endLine: number): EvidenceRef {
    return makeEvidenceRef({
      kind: 'file',
      ref: `${filePath}#L${startLine}-L${endLine}`,
      source: 'code_search',
      capturedAtMs: Date.now(),
      state: 'candidate',
      redactionStatus: 'clean',
    });
  }

  private addSearchMatch(
    matchesByRef: Map<string, CodeSearchMatch>,
    match: Omit<CodeSearchMatch, 'evidenceRef'>,
  ): void {
    const evidenceRef = this.makeCandidateEvidence(match.filePath, match.startLine, match.endLine);
    const existing = matchesByRef.get(evidenceRef.ref);
    if (!existing || match.score > existing.score) {
      matchesByRef.set(evidenceRef.ref, { ...match, evidenceRef });
    } else {
      existing.reasons = Array.from(new Set([...existing.reasons, ...match.reasons]));
    }
  }

  private searchIndexedCode(query: string, limit: number): CodeSearchMatch[] {
    const queryTerms = this.tokenizeQuery(query);
    const matchesByRef = new Map<string, CodeSearchMatch>();
    const boundedLimit = Math.max(1, Math.min(limit, 20));

    for (const file of this.fileIndex.values()) {
      file.lines.forEach((line, index) => {
        const { score, matchedTerms } = this.scoreLine(line, query, queryTerms);
        if (score <= 0) return;

        const startLine = Math.max(1, index + 1 - 2);
        const endLine = Math.min(file.lines.length, index + 1 + 2);
        this.addSearchMatch(matchesByRef, {
          filePath: file.filePath,
          startLine,
          endLine,
          score,
          reasons: [`lexical: ${matchedTerms.join(', ') || query}`],
          snippet: this.buildSnippet(file.lines, startLine, endLine),
        });
      });
    }

    const lowerQuery = query.toLowerCase();
    for (const [symbolName, symbols] of this.symbolIndex.symbols.entries()) {
      const lowerSymbol = symbolName.toLowerCase();
      const symbolMatches = lowerSymbol.includes(lowerQuery)
        || queryTerms.some((term) => lowerSymbol.includes(term));
      if (!symbolMatches) continue;

      for (const symbol of symbols) {
        const file = this.fileIndex.get(symbol.filePath);
        if (!file) continue;
        const startLine = Math.max(1, symbol.line - 2);
        const endLine = Math.min(file.lines.length, symbol.line + 2);
        const exactBoost = lowerSymbol === lowerQuery ? 12 : 6;
        this.addSearchMatch(matchesByRef, {
          filePath: symbol.filePath,
          startLine,
          endLine,
          score: 20 + exactBoost,
          reasons: [`symbol: ${symbol.kind} ${symbol.name}`],
          snippet: this.buildSnippet(file.lines, startLine, endLine),
        });
      }
    }

    return Array.from(matchesByRef.values())
      .sort((a, b) => b.score - a.score || a.filePath.localeCompare(b.filePath))
      .slice(0, boundedLimit);
  }

  private formatCodeSearchResults(query: string, matches: CodeSearchMatch[]): string {
    const header = `Found ${matches.length} candidate code result(s) for "${query}" (lexical FTS + symbol search).`;
    const body = matches.map((match, index) => {
      const readLimit = match.endLine - match.startLine + 1;
      return [
        `${index + 1}. ${match.filePath}:${match.startLine}-${match.endLine} (score ${match.score})`,
        `   reasons: ${match.reasons.join('; ')}`,
        `   EvidenceRef: ${JSON.stringify(match.evidenceRef)}`,
        `   Next read: Read {"file_path":"${match.filePath}","offset":${match.startLine},"limit":${readLimit}} before using this candidate in a conclusion.`,
        '```',
        match.snippet,
        '```',
      ].join('\n');
    }).join('\n\n');

    return `${header}\n\n${body}\n\nCandidate results are discovery hints only; bind them with Read before citing them as evidence.`;
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
          this.stats.indexedPatterns = [pattern];
          this.symbolIndex.symbols.clear();
          this.symbolIndex.fileSymbols.clear();
          this.fileIndex.clear();

          const errors: string[] = [];
          const filesToIndex = files.slice(0, maxFiles);

          for (const file of filesToIndex) {
            try {
              const filePath = path.join(absolutePath, file);
              const content = await fs.promises.readFile(filePath, 'utf-8');

              if (content.length > 100000) continue;

              const symbols = this.extractSymbols(content, filePath);
              for (const symbol of symbols) {
                const existing = this.symbolIndex.symbols.get(symbol.name) || [];
                existing.push(symbol);
                this.symbolIndex.symbols.set(symbol.name, existing);
              }

              this.symbolIndex.fileSymbols.set(filePath, symbols.map(s => s.name));
              this.fileIndex.set(filePath, {
                filePath,
                content,
                lines: content.split('\n'),
              });
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

    // code_search - lexical/FTS + symbol search
    this.addTool({
      definition: {
        name: 'code_search',
        description: `Search indexed code using lexical full-text matching and symbol lookup.

Parameters:
- query (required): Search query
- limit (optional): Maximum results (default: 5)`,
        inputSchema: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query' },
            limit: { type: 'number', description: 'Maximum results' },
          },
          required: ['query'],
        },
        requiresPermission: false,
        permissionLevel: 'read',
      },
      handler: async (args, toolCallId): Promise<ToolResult> => {
        const { query, limit = 5 } = args as { query: string; limit?: number };

        if (!query) {
          return { toolCallId, success: false, error: 'Query is required' };
        }

        const matches = this.searchIndexedCode(query, limit);
        const evidenceRefs = matches.map((match) => match.evidenceRef);

        if (matches.length === 0) {
          const tip = this.fileIndex.size === 0
            ? 'Tip: Run code_index first to index your codebase.'
            : 'Tip: Try a more specific symbol, function name, filename, or exact term.';
          return {
            toolCallId,
            success: true,
            output: `No indexed code found matching: "${query}"\n\n${tip}`,
            metadata: { evidenceRefs },
          };
        }

        return {
          toolCallId,
          success: true,
          output: this.formatCodeSearchResults(query, matches),
          metadata: { evidenceRefs },
        };
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
