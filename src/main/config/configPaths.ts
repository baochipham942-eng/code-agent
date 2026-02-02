// ============================================================================
// Unified Configuration Paths
// ============================================================================
// Central module for all configuration directory paths.
// Supports both new (.code-agent/) and legacy (.claude/) formats.
// ============================================================================

import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs/promises';

// ----------------------------------------------------------------------------
// Constants
// ----------------------------------------------------------------------------

/** New config directory name */
export const CONFIG_DIR_NEW = '.code-agent';

/** Legacy config directory name (for backward compatibility) */
export const CONFIG_DIR_LEGACY = '.claude';

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
  return os.homedir();
}

/**
 * Get user-level config directory (new format)
 */
export function getUserConfigDir(): string {
  return path.join(getHomeDir(), CONFIG_DIR_NEW);
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
