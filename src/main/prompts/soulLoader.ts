// ============================================================================
// Soul Loader - 文件化人格加载
// ============================================================================
// 组合语义（对标 Hermes 四层记忆的 identity 层）：
//   - ~/.code-agent/SOUL.md（用户级）替换内置 IDENTITY 核心自我块
//   - <workingDir>/.code-agent/PROFILE.md（项目级）作为 project extension 追加
//   - 工程层规则（CONCISENESS / TASK / TOOL / MEMORY）始终保留，不被覆盖
// 首次运行若都不存在，记录一次提示引导用户运行 `code-agent init-soul`。
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import { getUserConfigDir, getProjectConfigDir } from '../config/configPaths';
import {
  IDENTITY,
  IDENTITY_PROMPT,
  CONCISENESS_RULES,
  TASK_GUIDELINES,
  TOOL_DISCIPLINE,
  MEMORY_SYSTEM,
} from './identity';

const logger = createLogger('SoulLoader');

// ----------------------------------------------------------------------------
// State
// ----------------------------------------------------------------------------

let cachedSoul: string | null = null;
let currentWorkingDirectory: string | undefined;
const watchers: fs.FSWatcher[] = [];
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let hasLoggedFirstTimeHint = false;

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * 加载人格定义 — 组合 SOUL.md / PROFILE.md / 内置工程层
 */
export function loadSoul(workingDirectory?: string): string {
  currentWorkingDirectory = workingDirectory;

  // 用户级 SOUL.md — 替换 IDENTITY 核心自我块
  const soulPath = path.join(getUserConfigDir(), 'SOUL.md');
  const soulContent = readFileIfExists(soulPath);

  // 项目级 PROFILE.md — 作为项目扩展追加
  let profileContent: string | null = null;
  let profilePath: string | null = null;
  if (workingDirectory) {
    profilePath = path.join(getProjectConfigDir(workingDirectory), 'PROFILE.md');
    profileContent = readFileIfExists(profilePath);
  }

  // 快路径：完全使用内置默认
  if (!soulContent && !profileContent) {
    if (!hasLoggedFirstTimeHint) {
      logger.info(
        'No SOUL.md / PROFILE.md found — using built-in identity. ' +
          'Run `code-agent init-soul` to customize Agent identity.',
      );
      hasLoggedFirstTimeHint = true;
    }
    cachedSoul = IDENTITY_PROMPT;
    return cachedSoul;
  }

  // 组合：核心身份（SOUL 或 IDENTITY）+ 工程层 + 可选 PROFILE 扩展
  const coreIdentity = soulContent ?? IDENTITY;
  const parts = [
    coreIdentity,
    CONCISENESS_RULES,
    TASK_GUIDELINES,
    TOOL_DISCIPLINE,
    MEMORY_SYSTEM,
  ];
  if (profileContent) {
    parts.push(`<project_profile>\n${profileContent}\n</project_profile>`);
  }

  if (soulContent) {
    logger.info('Loaded user SOUL.md', { path: soulPath });
  }
  if (profileContent && profilePath) {
    logger.info('Loaded project PROFILE.md', { path: profilePath });
  }

  cachedSoul = parts.join('\n\n').trim();
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
