// ============================================================================
// Soul Loader - 文件化人格加载
// ============================================================================
// 支持 .code-agent/PROFILE.md（项目级）和 ~/.code-agent/SOUL.md（用户级）
// 优先级: 项目 PROFILE.md > 用户 SOUL.md > 内置 IDENTITY_PROMPT
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import { getUserConfigDir, getProjectConfigDir } from '../config/configPaths';
import { IDENTITY_PROMPT } from './identity';

const logger = createLogger('SoulLoader');

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------

let cachedSoul: string | null = null;
let currentWorkingDirectory: string | undefined;
const watchers: fs.FSWatcher[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * 加载人格定义，按优先级查找
 */
export function loadSoul(workingDirectory?: string): string {
  currentWorkingDirectory = workingDirectory;

  // 1. 项目级 PROFILE.md
  if (workingDirectory) {
    const profilePath = path.join(getProjectConfigDir(workingDirectory), 'PROFILE.md');
    const content = readFileIfExists(profilePath);
    if (content) {
      logger.info('Loaded project PROFILE.md', { path: profilePath });
      cachedSoul = content;
      return cachedSoul;
    }
  }

  // 2. 用户级 SOUL.md
  const soulPath = path.join(getUserConfigDir(), 'SOUL.md');
  const content = readFileIfExists(soulPath);
  if (content) {
    logger.info('Loaded user SOUL.md', { path: soulPath });
    cachedSoul = content;
    return cachedSoul;
  }

  // 3. 内置默认
  cachedSoul = IDENTITY_PROMPT;
  return cachedSoul;
}

/**
 * 获取当前人格（带缓存）
 */
export function getSoul(): string {
  if (cachedSoul !== null) return cachedSoul;
  return loadSoul(currentWorkingDirectory);
}

/**
 * 监听人格文件变更，自动热重载
 */
export function watchSoulFiles(workingDirectory?: string): void {
  unwatchSoulFiles();

  const pathsToWatch: string[] = [];

  if (workingDirectory) {
    pathsToWatch.push(path.join(getProjectConfigDir(workingDirectory), 'PROFILE.md'));
  }
  pathsToWatch.push(path.join(getUserConfigDir(), 'SOUL.md'));

  for (const filePath of pathsToWatch) {
    // 确保父目录存在才能 watch
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) continue;

    try {
      const watcher = fs.watch(dir, (eventType, filename) => {
        if (filename === path.basename(filePath)) {
          // debounce 500ms
          if (debounceTimer) clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            logger.info('Soul file changed, reloading', { path: filePath });
            cachedSoul = null; // 清除缓存，下次 getSoul() 时重新加载
            loadSoul(currentWorkingDirectory);
          }, 500);
        }
      });
      watchers.push(watcher);
    } catch (error) {
      logger.warn('Failed to watch soul file directory', { dir, error });
    }
  }
}

/**
 * 停止监听
 */
export function unwatchSoulFiles(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  for (const watcher of watchers) {
    watcher.close();
  }
  watchers.length = 0;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function readFileIfExists(filePath: string): string | null {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8').trim();
      return content || null;
    }
  } catch (error) {
    logger.warn('Failed to read soul file', { path: filePath, error });
  }
  return null;
}
