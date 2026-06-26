// ============================================================================
// Repo Map Builder — 遍历项目文件，提取符号和 import 关系
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { glob } from 'glob';
import type { RepoMapEntry, SymbolEntry, RepoMapConfig } from './types';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('RepoMapBuilder');

const DEFAULT_PATTERNS = ['**/*.{ts,tsx,js,jsx,py,go,rs}'];
const DEFAULT_IGNORE = [
  '**/node_modules/**', '**/dist/**', '**/build/**', '**/.git/**',
  '**/vendor/**', '**/__pycache__/**', '**/coverage/**', '**/*.d.ts',
  '**/*.test.*', '**/*.spec.*', '**/tests/**',
];
const DEFAULT_MAX_FILES = 500;
const MAX_FILE_SIZE = 100_000; // 100KB

// ── Symbol Extraction Patterns ──────────────────────────────────────────────

// TypeScript/JavaScript
const TS_FUNC = /^(\s*)(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*(<[^>]*>)?\s*\(([^)]*)\)/;
const TS_ARROW = /^(\s*)(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::\s*[^=]+)?\s*=\s*(?:async\s*)?\(([^)]*)\)/;
const TS_CLASS = /^(\s*)(?:export\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+\w+)?(?:\s+implements\s+[\w,\s]+)?/;
const TS_INTERFACE = /^(\s*)(?:export\s+)?interface\s+(\w+)/;
const TS_TYPE = /^(\s*)(?:export\s+)?type\s+(\w+)/;
const TS_ENUM = /^(\s*)(?:export\s+)?(?:const\s+)?enum\s+(\w+)/;

// Python
const PY_FUNC = /^(\s*)(?:async\s+)?def\s+(\w+)\s*\(([^)]*)\)/;
const PY_CLASS = /^(\s*)class\s+(\w+)/;

// Go
const GO_FUNC = /^func\s+(?:\(\w+\s+\*?\w+\)\s+)?(\w+)\s*\(([^)]*)\)/;
const GO_TYPE = /^type\s+(\w+)\s+(?:struct|interface)/;

// Rust
const RS_FN = /^(\s*)(?:pub\s+)?(?:async\s+)?fn\s+(\w+)\s*(?:<[^>]*>)?\s*\(([^)]*)\)/;
const RS_STRUCT = /^(\s*)(?:pub\s+)?struct\s+(\w+)/;
const RS_ENUM = /^(\s*)(?:pub\s+)?enum\s+(\w+)/;
const RS_TRAIT = /^(\s*)(?:pub\s+)?trait\s+(\w+)/;

// ── Import Extraction Patterns ──────────────────────────────────────────────

// TypeScript/JavaScript: import ... from 'xxx' / require('xxx')
const TS_IMPORT_FROM = /(?:import|export)\s+.*?\s+from\s+['"]([^'"]+)['"]/;
const TS_IMPORT_SIDE = /^import\s+['"]([^'"]+)['"]/;
const TS_REQUIRE = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/;

// Python: import xxx / from xxx import yyy
const PY_IMPORT = /^(?:from\s+(\S+)\s+import|import\s+(\S+))/;

// Go: import "xxx" or within import block
const GO_IMPORT = /^\s*"([^"]+)"/;

// Rust: use xxx::yyy
const RS_USE = /^use\s+(?:crate::)?(\S+)/;

/** 从单个文件提取符号 */
function extractSymbols(lines: string[], ext: string): SymbolEntry[] {
  const symbols: SymbolEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const isExported = trimmed.startsWith('export ') || trimmed.startsWith('pub ');
    let match: RegExpMatchArray | null;

    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      if ((match = line.match(TS_FUNC))) {
        symbols.push({ name: match[2], kind: 'function', exported: isExported, signature: match[4]?.trim(), line: i + 1 });
      } else if ((match = line.match(TS_ARROW))) {
        symbols.push({ name: match[2], kind: 'function', exported: isExported, signature: match[3]?.trim(), line: i + 1 });
      } else if ((match = line.match(TS_CLASS))) {
        symbols.push({ name: match[2], kind: 'class', exported: isExported, line: i + 1 });
      } else if ((match = line.match(TS_INTERFACE))) {
        symbols.push({ name: match[2], kind: 'interface', exported: isExported, line: i + 1 });
      } else if ((match = line.match(TS_TYPE))) {
        symbols.push({ name: match[2], kind: 'type', exported: isExported, line: i + 1 });
      } else if ((match = line.match(TS_ENUM))) {
        symbols.push({ name: match[2], kind: 'enum', exported: isExported, line: i + 1 });
      }
    } else if (ext === '.py') {
      if ((match = line.match(PY_FUNC))) {
        // Skip private methods (leading _)
        if (!match[2].startsWith('_')) {
          symbols.push({ name: match[2], kind: 'function', exported: true, signature: match[3]?.trim(), line: i + 1 });
        }
      } else if ((match = line.match(PY_CLASS))) {
        symbols.push({ name: match[2], kind: 'class', exported: true, line: i + 1 });
      }
    } else if (ext === '.go') {
      if ((match = line.match(GO_FUNC))) {
        const isPublic = match[1][0] === match[1][0].toUpperCase();
        symbols.push({ name: match[1], kind: 'function', exported: isPublic, signature: match[2]?.trim(), line: i + 1 });
      } else if ((match = line.match(GO_TYPE))) {
        const isPublic = match[1][0] === match[1][0].toUpperCase();
        symbols.push({ name: match[1], kind: trimmed.includes('interface') ? 'interface' : 'class', exported: isPublic, line: i + 1 });
      }
    } else if (ext === '.rs') {
      if ((match = line.match(RS_FN))) {
        symbols.push({ name: match[2], kind: 'function', exported: isExported, signature: match[3]?.trim(), line: i + 1 });
      } else if ((match = line.match(RS_STRUCT))) {
        symbols.push({ name: match[2], kind: 'class', exported: isExported, line: i + 1 });
      } else if ((match = line.match(RS_ENUM))) {
        symbols.push({ name: match[2], kind: 'enum', exported: isExported, line: i + 1 });
      } else if ((match = line.match(RS_TRAIT))) {
        symbols.push({ name: match[2], kind: 'interface', exported: isExported, line: i + 1 });
      }
    }
  }

  return symbols;
}

/** 从单个文件提取 import 目标 */
function extractImports(lines: string[], ext: string): string[] {
  const imports: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    let match: RegExpMatchArray | null;

    if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
      if ((match = trimmed.match(TS_IMPORT_FROM))) {
        imports.push(match[1]);
      } else if ((match = trimmed.match(TS_IMPORT_SIDE))) {
        imports.push(match[1]);
      } else if ((match = trimmed.match(TS_REQUIRE))) {
        imports.push(match[1]);
      }
    } else if (ext === '.py') {
      if ((match = trimmed.match(PY_IMPORT))) {
        imports.push(match[1] || match[2]);
      }
    } else if (ext === '.go') {
      if ((match = trimmed.match(GO_IMPORT))) {
        imports.push(match[1]);
      }
    } else if (ext === '.rs') {
      if ((match = trimmed.match(RS_USE))) {
        imports.push(match[1]);
      }
    }
  }

  return imports;
}

/** 将 import 路径解析为相对文件路径（仅处理相对路径） */
function resolveImportPath(importPath: string, fromFile: string, rootDir: string): string | null {
  // 只处理相对 import（./ 或 ../）
  if (!importPath.startsWith('.')) return null;

  const fromDir = path.dirname(path.join(rootDir, fromFile));
  let resolved = path.resolve(fromDir, importPath);

  // 尝试补全扩展名
  const extensions = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js'];
  for (const ext of extensions) {
    const candidate = resolved + ext;
    if (fs.existsSync(candidate)) {
      return path.relative(rootDir, candidate);
    }
  }

  // 原路径可能已包含扩展名
  if (fs.existsSync(resolved)) {
    return path.relative(rootDir, resolved);
  }

  return null;
}

/** 构建单个文件的 RepoMapEntry */
async function buildEntry(filePath: string, rootDir: string): Promise<RepoMapEntry | null> {
  const absolutePath = path.join(rootDir, filePath);

  try {
    const stat = await fs.promises.stat(absolutePath);
    if (stat.size > MAX_FILE_SIZE) return null;

    const content = await fs.promises.readFile(absolutePath, 'utf-8');
    const lines = content.split('\n');
    const ext = path.extname(filePath).toLowerCase();

    const symbols = extractSymbols(lines, ext);
    const rawImports = extractImports(lines, ext);

    // 解析相对 import 为项目内路径
    const imports: string[] = [];
    for (const imp of rawImports) {
      const resolved = resolveImportPath(imp, filePath, rootDir);
      if (resolved) {
        imports.push(resolved);
      }
    }

    return {
      relativePath: filePath,
      symbols,
      imports,
      mtime: stat.mtimeMs,
    };
  } catch (err) {
    logger.debug(`Skip file ${filePath}: ${err instanceof Error ? err.message : 'unknown'}`);
    return null;
  }
}

/** 遍历项目文件构建所有 RepoMapEntry */
export async function buildRepoMap(config: RepoMapConfig): Promise<Map<string, RepoMapEntry>> {
  const {
    rootDir,
    patterns = DEFAULT_PATTERNS,
    ignore = DEFAULT_IGNORE,
    maxFiles = DEFAULT_MAX_FILES,
  } = config;

  const entries = new Map<string, RepoMapEntry>();

  // Glob 所有匹配文件
  let allFiles: string[] = [];
  for (const pattern of patterns) {
    const files = await glob(pattern, {
      cwd: rootDir,
      ignore,
      nodir: true,
    });
    allFiles.push(...files);
  }

  // 去重并限制数量
  allFiles = [...new Set(allFiles)].slice(0, maxFiles);
  logger.info(`RepoMap: scanning ${allFiles.length} files in ${rootDir}`);

  // 并发构建（限制并发数避免文件句柄耗尽）
  const BATCH_SIZE = 50;
  for (let i = 0; i < allFiles.length; i += BATCH_SIZE) {
    const batch = allFiles.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(batch.map(f => buildEntry(f, rootDir)));
    for (const entry of results) {
      if (entry && entry.symbols.length > 0) {
        entries.set(entry.relativePath, entry);
      }
    }
  }

  logger.info(`RepoMap: indexed ${entries.size} files with symbols`);
  return entries;
}

export { resolveImportPath, extractSymbols, extractImports };
