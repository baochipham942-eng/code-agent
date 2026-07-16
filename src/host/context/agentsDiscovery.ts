// ============================================================================
// AGENTS.md Discovery Service - Discover and load AGENTS.md files
// ============================================================================
// Implements the AGENTS.md standard used by 60k+ open source projects
// These files provide agent-specific instructions for different directories
// ============================================================================

import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { createLogger } from '../services/infra/logger';
import { isProjectConfigTrusted } from '../security/folderTrustService';

const logger = createLogger('AgentsDiscovery');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * An AGENTS.md file with its content and metadata
 */
export interface AgentInstructions {
  /** Relative path from working directory */
  relativePath: string;
  /** Absolute path to the file */
  absolutePath: string;
  /** The directory this AGENTS.md applies to */
  directory: string;
  /** Content of the AGENTS.md file */
  content: string;
  /** File modification time */
  modifiedAt: number;
  /** Optional parsed sections */
  sections?: AgentSection[];
}

/**
 * A section within an AGENTS.md file
 */
export interface AgentSection {
  title: string;
  content: string;
  level: number; // Header level (1-6)
}

/**
 * Discovery result
 */
export interface AgentsDiscoveryResult {
  /** All discovered AGENTS.md files */
  files: AgentInstructions[];
  /** Combined instructions for a specific path */
  combinedInstructions: string;
  /** Total files found */
  totalFiles: number;
  /** Discovery time in ms */
  discoveryTimeMs: number;
  /** Whether discovery stopped before traversing everything */
  truncated?: boolean;
}

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/**
 * File names to search for (AGENTS.md is the standard)
 * Also includes CLAUDE.md for compatibility with Claude Code style
 */
const AGENT_FILES = ['AGENTS.md', 'CLAUDE.md', '.agents.md', '.claude.md'];

/**
 * Directories to skip during discovery
 */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'vendor',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
  'env',
  '.env',
  'target', // Rust
  'Pods', // iOS
  '.idea',
  '.vscode',
]);

/**
 * macOS TCC 保护的用户目录名。递归发现 AGENTS.md/CLAUDE.md 时若从家目录起扫,
 * 下钻进这些目录会触发系统授权弹窗(Desktop/Documents/Downloads),且这些目录
 * 不是项目根,不应为找 agent 文件而扫。按"家目录下的确切子目录"匹配,不误伤
 * 名字碰巧相同的项目内子目录,也不影响工作目录本身就在这些目录下的项目扫描。
 */
const PROTECTED_USER_FOLDER_NAMES = ['Desktop', 'Documents', 'Downloads'];

/** dir 是否为家目录下的 TCC 受保护用户目录(~/Desktop、~/Documents、~/Downloads)。 */
export function isProtectedUserFolder(dir: string, homeDir: string = os.homedir()): boolean {
  const resolved = path.resolve(dir);
  return PROTECTED_USER_FOLDER_NAMES.some((name) => resolved === path.join(homeDir, name));
}

/**
 * Maximum depth to search
 */
const MAX_DEPTH = 5;
const MAX_FILES = 32;
const MAX_DIRECTORIES = 1500;

/**
 * 稀疏回退阈值（借鉴 MiMoCode session/instruction.ts）：
 * AGENTS.md trim 后少于该字符数视为"太薄"，很可能不含完整项目指引，
 * 迁移期补充加载同目录的 CLAUDE.md，避免 first-match-wins 把指引丢掉。
 */
const SPARSE_AGENTS_FALLBACK_CHARS = 500;

export interface AgentsDiscoveryOptions {
  maxDepth?: number;
  maxFiles?: number;
  maxDirectories?: number;
}

function normalizeDiscoveryOptions(
  optionsOrDepth?: number | AgentsDiscoveryOptions,
): Required<AgentsDiscoveryOptions> {
  if (typeof optionsOrDepth === 'number') {
    return {
      maxDepth: optionsOrDepth,
      maxFiles: MAX_FILES,
      maxDirectories: MAX_DIRECTORIES,
    };
  }

  return {
    maxDepth: optionsOrDepth?.maxDepth ?? MAX_DEPTH,
    maxFiles: optionsOrDepth?.maxFiles ?? MAX_FILES,
    maxDirectories: optionsOrDepth?.maxDirectories ?? MAX_DIRECTORIES,
  };
}

// ----------------------------------------------------------------------------
// Discovery Service
// ----------------------------------------------------------------------------

/**
 * Discover all AGENTS.md files in a directory tree
 *
 * @param workingDirectory - The root directory to search from
 * @param maxDepth - Maximum directory depth to search (default: 5)
 * @returns Discovery result with all found files
 */
export async function discoverAgentFiles(
  workingDirectory: string,
  optionsOrDepth?: number | AgentsDiscoveryOptions
): Promise<AgentsDiscoveryResult> {
  const startTime = Date.now();
  if (!await isProjectConfigTrusted(workingDirectory, 'agent-instructions')) {
    return {
      files: [],
      combinedInstructions: '',
      totalFiles: 0,
      discoveryTimeMs: Date.now() - startTime,
    };
  }

  const files: AgentInstructions[] = [];
  const { maxDepth, maxFiles, maxDirectories } = normalizeDiscoveryOptions(optionsOrDepth);
  let visitedDirectories = 0;
  let truncated = false;

  async function searchDirectory(dir: string, depth: number): Promise<void> {
    if (depth > maxDepth) return;
    if (files.length >= maxFiles || visitedDirectories >= maxDirectories) {
      truncated = true;
      return;
    }
    visitedDirectories += 1;

    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });

      // First, check for agent files in current directory
      async function loadAgentFile(fileName: string): Promise<string | null> {
        const filePath = path.join(dir, fileName);
        try {
          const stat = await fs.stat(filePath);
          if (!stat.isFile()) return null;
          const content = await fs.readFile(filePath, 'utf-8');
          files.push({
            relativePath: path.relative(workingDirectory, filePath),
            absolutePath: filePath,
            directory: path.relative(workingDirectory, dir) || '.',
            content,
            modifiedAt: stat.mtimeMs,
            sections: parseAgentSections(content),
          });
          return content;
        } catch {
          return null; // File doesn't exist
        }
      }

      for (const fileName of AGENT_FILES) {
        const content = await loadAgentFile(fileName);
        if (content === null) continue;
        // 稀疏回退：AGENTS.md 太薄时补充加载同目录 CLAUDE.md（roadmap 1.10）
        if (
          fileName === 'AGENTS.md'
          && content.trim().length < SPARSE_AGENTS_FALLBACK_CHARS
          && files.length < maxFiles
        ) {
          await loadAgentFile('CLAUDE.md');
        }
        // Only load one file per directory (prefer AGENTS.md over CLAUDE.md)
        break;
      }

      // 打包态工作目录会 fallback 到家目录(cwd 在 .app 内)。家目录不是项目根,
      // 不该为找 AGENTS.md 递归扫遍它——下钻会触碰 ~/Desktop、~/Documents、
      // ~/Downloads、~/Music、~/Pictures、~/Library 等,逐个触发 macOS TCC 授权弹窗。
      // 故:扫到家目录本身时只读它这一层(收本层 AGENTS.md/CLAUDE.md),不下钻任何子目录。
      const scanningHome = path.resolve(dir) === os.homedir();

      // Then recursively search subdirectories
      for (const entry of entries) {
        if (files.length >= maxFiles || visitedDirectories >= maxDirectories) {
          truncated = true;
          break;
        }
        if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
          if (scanningHome) continue;
          const childDir = path.join(dir, entry.name);
          // 兜底:即便不是从家目录起扫,也不下钻 TCC 受保护用户目录。
          if (isProtectedUserFolder(childDir)) continue;
          await searchDirectory(childDir, depth + 1);
        }
      }
    } catch (error) {
      logger.debug('Error searching directory', { dir, error });
    }
  }

  await searchDirectory(workingDirectory, 0);

  // Sort by path depth (root first, then deeper directories)
  files.sort((a, b) => {
    const depthA = a.relativePath.split(path.sep).length;
    const depthB = b.relativePath.split(path.sep).length;
    return depthA - depthB;
  });

  const discoveryTimeMs = Date.now() - startTime;

  logger.info('AGENTS.md discovery completed', {
    totalFiles: files.length,
    discoveryTimeMs,
    truncated,
    paths: files.map(f => f.relativePath),
  });

  return {
    files,
    combinedInstructions: combineInstructions(files),
    totalFiles: files.length,
    discoveryTimeMs,
    truncated,
  };
}

/**
 * Get agent instructions relevant to a specific file path
 *
 * @param workingDirectory - The root working directory
 * @param targetPath - The file path to get instructions for
 * @returns Combined instructions from all applicable AGENTS.md files
 */
export async function getInstructionsForPath(
  workingDirectory: string,
  targetPath: string
): Promise<string> {
  const result = await discoverAgentFiles(workingDirectory);

  // Filter to only files that apply to the target path
  const applicableFiles = result.files.filter(file => {
    // Root-level files apply to everything
    if (file.directory === '.') return true;

    // Check if target path is within the directory
    const targetDir = path.dirname(targetPath);
    return targetDir.startsWith(file.directory) || file.directory === targetDir;
  });

  return combineInstructions(applicableFiles);
}

/**
 * Parse sections from an AGENTS.md file
 */
function parseAgentSections(content: string): AgentSection[] {
  const sections: AgentSection[] = [];
  const lines = content.split('\n');
  let currentSection: AgentSection | null = null;
  let contentLines: string[] = [];

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headerMatch) {
      // Save previous section
      if (currentSection) {
        currentSection.content = contentLines.join('\n').trim();
        sections.push(currentSection);
      }

      // Start new section
      currentSection = {
        title: headerMatch[2],
        content: '',
        level: headerMatch[1].length,
      };
      contentLines = [];
    } else if (currentSection) {
      contentLines.push(line);
    }
  }

  // Don't forget the last section
  if (currentSection) {
    currentSection.content = contentLines.join('\n').trim();
    sections.push(currentSection);
  }

  return sections;
}

/**
 * Combine multiple AGENTS.md files into a single instruction string
 */
function combineInstructions(files: AgentInstructions[]): string {
  if (files.length === 0) return '';

  const parts: string[] = [];

  for (const file of files) {
    const header = file.directory === '.'
      ? '# Project Root Instructions'
      : `# Instructions for ${file.directory}/`;

    parts.push(`${header}\n\n${file.content}`);
  }

  return parts.join('\n\n---\n\n');
}

// ----------------------------------------------------------------------------
// Caching Layer
// ----------------------------------------------------------------------------

interface CacheEntry {
  result: AgentsDiscoveryResult;
  timestamp: number;
}

const discoveryCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60000; // 1 minute

function getCacheKey(workingDirectory: string, options: Required<AgentsDiscoveryOptions>): string {
  return [
    workingDirectory,
    options.maxDepth,
    options.maxFiles,
    options.maxDirectories,
  ].join('\0');
}

/**
 * Discover agent files with caching
 * Results are cached for 1 minute to avoid repeated filesystem scans
 */
export async function discoverAgentFilesCached(
  workingDirectory: string,
  optionsOrDepth?: number | AgentsDiscoveryOptions,
): Promise<AgentsDiscoveryResult> {
  const options = normalizeDiscoveryOptions(optionsOrDepth);
  const cacheKey = getCacheKey(workingDirectory, options);
  const cached = discoveryCache.get(cacheKey);

  if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
    return cached.result;
  }

  const result = await discoverAgentFiles(workingDirectory, options);

  discoveryCache.set(cacheKey, {
    result,
    timestamp: Date.now(),
  });

  return result;
}

/**
 * Clear the discovery cache
 * Call this when files might have changed
 */
export function clearAgentsDiscoveryCache(workingDirectory?: string): void {
  if (workingDirectory) {
    for (const key of discoveryCache.keys()) {
      if (key.startsWith(`${workingDirectory}\0`)) {
        discoveryCache.delete(key);
      }
    }
  } else {
    discoveryCache.clear();
  }
}

// ----------------------------------------------------------------------------
// Singleton Service
// ----------------------------------------------------------------------------

/**
 * AgentsDiscoveryService - Manages discovery and caching of AGENTS.md files
 */
export class AgentsDiscoveryService {
  private workingDirectory: string;

  constructor(workingDirectory: string) {
    this.workingDirectory = workingDirectory;
  }

  /**
   * Discover all agent instruction files
   */
  async discover(): Promise<AgentsDiscoveryResult> {
    return discoverAgentFilesCached(this.workingDirectory);
  }

  /**
   * Get instructions for a specific path
   */
  async getInstructionsFor(targetPath: string): Promise<string> {
    return getInstructionsForPath(this.workingDirectory, targetPath);
  }

  /**
   * Get combined instructions for the entire project
   */
  async getCombinedInstructions(): Promise<string> {
    const result = await this.discover();
    return result.combinedInstructions;
  }

  /**
   * Refresh the cache
   */
  refresh(): void {
    clearAgentsDiscoveryCache(this.workingDirectory);
  }

  /**
   * Update working directory
   */
  setWorkingDirectory(dir: string): void {
    this.workingDirectory = dir;
  }
}

// Singleton instance
let agentsDiscoveryService: AgentsDiscoveryService | null = null;

/**
 * Get or create the AgentsDiscoveryService singleton
 */
export function getAgentsDiscoveryService(workingDirectory?: string): AgentsDiscoveryService {
  if (!agentsDiscoveryService) {
    agentsDiscoveryService = new AgentsDiscoveryService(workingDirectory || process.cwd());
  } else if (workingDirectory) {
    agentsDiscoveryService.setWorkingDirectory(workingDirectory);
  }
  return agentsDiscoveryService;
}

/**
 * Initialize with a specific working directory
 */
export function initAgentsDiscovery(workingDirectory: string): AgentsDiscoveryService {
  agentsDiscoveryService = new AgentsDiscoveryService(workingDirectory);
  return agentsDiscoveryService;
}
