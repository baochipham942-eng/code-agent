// ============================================================================
// Unified Configuration Paths
// ============================================================================
// Central module for all configuration directory paths.
// Supports both new (.code-agent/) and legacy (.claude/) formats.
// ============================================================================

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';
import { CONFIG_DIR_NEW, CONFIG_DIR_LEGACY, CONFIG_DIR_DEV } from '../../shared/constants/configDir';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

// 目录名常量上移到 shared 单一真值源（供 renderer 干净引用）；此处 re-export 保持现有 import 不变。
export { CONFIG_DIR_NEW, CONFIG_DIR_LEGACY, CONFIG_DIR_DEV };

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface ConfigPathOptions {
  /** Working directory for project-level configs */
  workingDirectory?: string;
  /** Whether to prefer legacy paths (default: false) */
  preferLegacy?: boolean;
}

export interface ResolvedPaths {
  /** Path that exists and should be used */
  resolved: string;
  /** Whether legacy path is being used */
  isLegacy: boolean;
  /** New format path (may not exist) */
  newPath: string;
  /** Legacy format path (may not exist) */
  legacyPath: string;
}

// ----------------------------------------------------------------------------
// Base Path Getters
// ----------------------------------------------------------------------------

/**
 * Get home directory
 */
export function getHomeDir(): string {
  return process.env.CODE_AGENT_HOME || os.homedir();
}

/**
 * Get user-level config directory (new format)
 *
 * 与 appPaths.getUserDataPath() 指向同一目录：优先 CODE_AGENT_DATA_DIR（测试/开发通道
 * 由 webEnvInit/Rust 注入到 .code-agent-dev），未设置时退回 <home>/.code-agent。
 * 这样 pty/background-tasks 等走 getUserConfigDir 的子系统也随通道隔离，不再固定在生产目录。
 */
export function getUserConfigDir(): string {
  const explicit = process.env.CODE_AGENT_DATA_DIR?.trim();
  if (explicit) return explicit;
  return path.join(getHomeDir(), CONFIG_DIR_NEW);
}

/**
 * 没有项目目录的会话（「未分类」、快速对话）默认工作目录。所有兜底点共用这一个函数。
 *
 * 不能放在数据目录里：后台任务的写权限（resolveBackgroundWorkspaceAuthority）按设计拒绝数据目录，
 * 放在 <dataDir>/work 时未分类会话派后台任务必然 WORKSPACE_REQUIRED（爸 2026-09-16 真机）。
 * 爸 2026-09-16 拍板放主目录下用户看得见的 ~/Neo（不放「文稿」：macOS 会弹授权，拒了就写不了）。
 * - 数据目录直接挂在主目录下：正式版 ~/.code-agent → ~/Neo；测试槽 ~/.code-agent-dev → ~/Neo-dev（测试产物不混进正式目录）
 * - 其余嵌套数据目录（测试临时目录、远端验收宿主）：放在数据目录旁边 <dataDir>-work，不往真实主目录写
 */
export function getDefaultWorkDirectory(env: NodeJS.ProcessEnv = process.env): string {
  const home = path.resolve(env.CODE_AGENT_HOME || os.homedir());
  const dataDir = path.resolve(env.CODE_AGENT_DATA_DIR?.trim() || path.join(home, CONFIG_DIR_NEW));
  if (path.dirname(dataDir) !== home) return `${dataDir}-work`;
  const slot = path.basename(dataDir).replace(/^\.+/, '').replace(/^code-agent-?/, '');
  return path.join(home, slot ? `Neo-${slot}` : 'Neo');
}

/**
 * Get user-level config directory (legacy format)
 */
export function getUserConfigDirLegacy(): string {
  return path.join(getHomeDir(), CONFIG_DIR_LEGACY);
}

/**
 * Get project-level config directory (new format)
 */
export function getProjectConfigDir(workingDirectory: string): string {
  return path.join(workingDirectory, CONFIG_DIR_NEW);
}

/**
 * Get project-level config directory (legacy format)
 */
export function getProjectConfigDirLegacy(workingDirectory: string): string {
  return path.join(workingDirectory, CONFIG_DIR_LEGACY);
}

// ----------------------------------------------------------------------------
// Specific Config Paths
// ----------------------------------------------------------------------------

/**
 * Get hooks config paths
 */
export function getHooksConfigDir(workingDirectory?: string): {
  user: { new: string; legacy: string };
  project?: { new: string; legacy: string };
} {
  const result: ReturnType<typeof getHooksConfigDir> = {
    user: {
      new: path.join(getUserConfigDir(), 'hooks'),
      legacy: getUserConfigDirLegacy(), // hooks in settings.json
    },
  };

  if (workingDirectory) {
    result.project = {
      new: path.join(getProjectConfigDir(workingDirectory), 'hooks'),
      legacy: getProjectConfigDirLegacy(workingDirectory),
    };
  }

  return result;
}

/**
 * Get skills directory paths
 */
export function getSkillsDir(workingDirectory?: string): {
  user: { new: string; legacy: string };
  project?: { new: string; legacy: string };
} {
  const result: ReturnType<typeof getSkillsDir> = {
    user: {
      new: path.join(getUserConfigDir(), 'skills'),
      legacy: path.join(getUserConfigDirLegacy(), 'skills'),
    },
  };

  if (workingDirectory) {
    result.project = {
      new: path.join(getProjectConfigDir(workingDirectory), 'skills'),
      legacy: path.join(getProjectConfigDirLegacy(workingDirectory), 'skills'),
    };
  }

  return result;
}

/**
 * Get prompt command directories (.code-agent/commands，roadmap 2.2)
 */
export function getCommandsDir(workingDirectory?: string): {
  user: string;
  project?: string;
} {
  const result: ReturnType<typeof getCommandsDir> = {
    user: path.join(getUserConfigDir(), 'commands'),
  };
  if (workingDirectory) {
    result.project = path.join(getProjectConfigDir(workingDirectory), 'commands');
  }
  return result;
}

/**
 * Get agents config paths
 */
export function getAgentsConfigPath(workingDirectory?: string): {
  user: { new: string; legacy: string };
  project?: { new: string; legacy: string };
} {
  const result: ReturnType<typeof getAgentsConfigPath> = {
    user: {
      new: path.join(getUserConfigDir(), 'agents.json'),
      legacy: path.join(getUserConfigDirLegacy(), 'agents.json'),
    },
  };

  if (workingDirectory) {
    result.project = {
      new: path.join(getProjectConfigDir(workingDirectory), 'agents.json'),
      legacy: path.join(getProjectConfigDirLegacy(workingDirectory), 'agents.json'),
    };
  }

  return result;
}

/**
 * Get agents .md directory paths for custom agent definitions
 */
export function getAgentsMdDir(workingDirectory?: string): {
  user: string;
  project?: string;
} {
  const result: { user: string; project?: string } = {
    user: path.join(getUserConfigDir(), 'agents'),
  };
  if (workingDirectory) {
    result.project = path.join(getProjectConfigDir(workingDirectory), 'agents');
  }
  return result;
}

/**
 * Get managed config path for enterprise administration
 */
export function getManagedConfigPath(): string {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return '/etc/code-agent';
  }
  return path.join(os.homedir(), '.config', 'code-agent', 'managed');
}

/**
 * Get MCP config path
 */
export function getMcpConfigPath(workingDirectory: string): {
  new: string;
  legacy: string;
} {
  return {
    new: path.join(getProjectConfigDir(workingDirectory), 'mcp.json'),
    legacy: path.join(getProjectConfigDirLegacy(workingDirectory), 'settings.json'),
  };
}

/**
 * Get scoped MCP config file paths (user / project / local).
 * - user: ~/.code-agent/mcp.json — 跨所有项目生效
 * - project: <wd>/.code-agent/mcp.json — 随项目走、纳入版本控制、团队共享
 * - local: <wd>/.code-agent/mcp.local.json — 项目内私有、应 gitignore
 * 优先级 local > project > user（同名后者覆盖前者）。
 */
export function getMcpScopedConfigPaths(workingDirectory?: string): {
  user: string;
  project?: string;
  local?: string;
} {
  const result: { user: string; project?: string; local?: string } = {
    user: path.join(getUserConfigDir(), 'mcp.json'),
  };

  if (workingDirectory) {
    result.project = path.join(getProjectConfigDir(workingDirectory), 'mcp.json');
    result.local = path.join(getProjectConfigDir(workingDirectory), 'mcp.local.json');
  }

  return result;
}

/**
 * Get settings.json path (for non-hooks settings)
 */
export function getSettingsPath(workingDirectory?: string): {
  user: { new: string; legacy: string };
  project?: { new: string; legacy: string };
} {
  const result: ReturnType<typeof getSettingsPath> = {
    user: {
      new: path.join(getUserConfigDir(), 'settings.json'),
      legacy: path.join(getUserConfigDirLegacy(), 'settings.json'),
    },
  };

  if (workingDirectory) {
    result.project = {
      new: path.join(getProjectConfigDir(workingDirectory), 'settings.json'),
      legacy: path.join(getProjectConfigDirLegacy(workingDirectory), 'settings.json'),
    };
  }

  return result;
}

/**
 * Get teams directory for persistent team state
 */
export function getTeamsDir(workingDirectory: string): string {
  return path.join(getProjectConfigDir(workingDirectory), 'teams');
}

/**
 * Get permissions config from settings.json
 */
export function getPermissionsConfig(workingDirectory?: string): {
  user: { new: string; legacy: string };
  project?: { new: string; legacy: string };
} {
  const result: ReturnType<typeof getPermissionsConfig> = {
    user: {
      new: path.join(getUserConfigDir(), 'permissions.json'),
      legacy: path.join(getUserConfigDirLegacy(), 'settings.json'),
    },
  };

  if (workingDirectory) {
    result.project = {
      new: path.join(getProjectConfigDir(workingDirectory), 'permissions.json'),
      legacy: path.join(getProjectConfigDirLegacy(workingDirectory), 'settings.json'),
    };
  }

  return result;
}

/**
 * Get test directories
 */
export function getTestDirs(workingDirectory: string): {
  testCases: { new: string; legacy: string };
  results: { new: string; legacy: string };
} {
  return {
    testCases: {
      new: path.join(getProjectConfigDir(workingDirectory), 'test-cases'),
      legacy: path.join(getProjectConfigDirLegacy(workingDirectory), 'test-cases'),
    },
    results: {
      new: path.join(getProjectConfigDir(workingDirectory), 'test-results'),
      legacy: path.join(getProjectConfigDirLegacy(workingDirectory), 'test-results'),
    },
  };
}

// ----------------------------------------------------------------------------
// Path Resolution Utilities
// ----------------------------------------------------------------------------

/**
 * Check if a path exists
 */
export async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve path with fallback to legacy
 * Returns the new path if it exists, otherwise legacy path if it exists,
 * otherwise returns the new path (for creation)
 */
export async function resolvePathWithFallback(
  newPath: string,
  legacyPath: string
): Promise<ResolvedPaths> {
  const [newExists, legacyExists] = await Promise.all([
    pathExists(newPath),
    pathExists(legacyPath),
  ]);

  if (newExists) {
    return {
      resolved: newPath,
      isLegacy: false,
      newPath,
      legacyPath,
    };
  }

  if (legacyExists) {
    return {
      resolved: legacyPath,
      isLegacy: true,
      newPath,
      legacyPath,
    };
  }

  // Neither exists, return new path for creation
  return {
    resolved: newPath,
    isLegacy: false,
    newPath,
    legacyPath,
  };
}

/**
 * Resolve multiple paths, warning if both exist
 */
export async function resolvePathsWithWarning(
  newPath: string,
  legacyPath: string,
  configName: string
): Promise<ResolvedPaths> {
  const [newExists, legacyExists] = await Promise.all([
    pathExists(newPath),
    pathExists(legacyPath),
  ]);

  if (newExists && legacyExists) {
    console.warn(
      `[Config] Warning: Both new and legacy ${configName} configs found.\n` +
        `  Using: ${newPath}\n` +
        `  Ignoring: ${legacyPath}\n` +
        `  Consider removing the legacy config.`
    );
  }

  if (newExists) {
    return {
      resolved: newPath,
      isLegacy: false,
      newPath,
      legacyPath,
    };
  }

  if (legacyExists) {
    return {
      resolved: legacyPath,
      isLegacy: true,
      newPath,
      legacyPath,
    };
  }

  return {
    resolved: newPath,
    isLegacy: false,
    newPath,
    legacyPath,
  };
}

// ----------------------------------------------------------------------------
// Directory Creation
// ----------------------------------------------------------------------------

/**
 * Ensure config directory exists
 */
export async function ensureConfigDir(workingDirectory: string): Promise<string> {
  const configDir = getProjectConfigDir(workingDirectory);
  await fs.mkdir(configDir, { recursive: true });
  return configDir;
}

/**
 * Ensure user config directory exists
 */
export async function ensureUserConfigDir(): Promise<string> {
  const configDir = getUserConfigDir();
  await fs.mkdir(configDir, { recursive: true });
  return configDir;
}

/**
 * Initialize project config directory structure
 */
export async function initProjectConfig(workingDirectory: string): Promise<void> {
  const configDir = getProjectConfigDir(workingDirectory);

  const dirs = [
    configDir,
    path.join(configDir, 'hooks'),
    path.join(configDir, 'hooks', 'scripts'),
    path.join(configDir, 'skills'),
    path.join(configDir, 'agents'),
  ];

  await Promise.all(dirs.map((dir) => fs.mkdir(dir, { recursive: true })));
}
