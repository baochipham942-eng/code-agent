// ============================================================================
// Permission Modes - Define different permission handling behaviors
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import { getUserConfigDir } from '../config/configPaths';

const logger = createLogger('PermissionModes');

// 会话档持久化文件（审出 MED：纯内存跨重启会静默回退全局默认档）。
const SESSION_MODES_FILE = 'session-permission-modes.json';
// ponytail: 全量覆写小 JSON + 超上限丢最旧（Map 保插入序）；量级/并发成问题再换 DB。
const SESSION_MODES_MAX_ENTRIES = 500;

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Permission mode determines how permission requests are handled
 */
export type PermissionMode =
  | 'default'           // Standard interactive prompting
  | 'readOnly'          // Read-only explore - reads pass, every write/exec prompts (no auto-approve shortcuts)
  | 'acceptEdits'       // Auto-accept file edits, prompt for others
  | 'dontAsk'           // Auto-deny risky operations, allow safe ones
  | 'bypassPermissions' // Skip all permission checks (dangerous)
  | 'plan'              // Planning mode - read-only, no execution
  | 'delegate';         // Delegation mode - inherit parent permissions

/**
 * Permission level for operations
 */
export type PermissionLevel =
  | 'read'      // Read files, list directories
  | 'write'     // Write/edit files
  | 'execute'   // Execute commands
  | 'network'   // Network operations
  | 'dangerous' // Destructive operations
  | 'admin';    // Administrative operations

/**
 * Permission action result
 */
export type PermissionAction = 'allow' | 'deny' | 'prompt';

/**
 * Permission request
 */
export interface PermissionRequest {
  /** Type of operation */
  level: PermissionLevel;
  /** Tool requesting permission */
  tool: string;
  /** Description of the operation */
  description: string;
  /** Additional details */
  details?: Record<string, unknown>;
}

/**
 * Mode configuration
 */
export interface ModeConfig {
  /** Mode name */
  name: PermissionMode;
  /** Human-readable description */
  description: string;
  /** Default action for each permission level */
  defaults: Record<PermissionLevel, PermissionAction>;
  /** Whether the mode allows execution */
  allowsExecution: boolean;
  /** Whether the mode allows writes */
  allowsWrites: boolean;
  /** Whether the mode requires explicit user approval to enter */
  requiresApproval: boolean;
  /** Risk level of this mode */
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

// ----------------------------------------------------------------------------
// Mode Definitions
// ----------------------------------------------------------------------------

/**
 * Mode configurations
 */
export const MODE_CONFIGS: Record<PermissionMode, ModeConfig> = {
  default: {
    name: 'default',
    description: 'Standard interactive mode - prompts for all operations',
    defaults: {
      read: 'allow',
      write: 'prompt',
      execute: 'prompt',
      network: 'prompt',
      dangerous: 'prompt',
      admin: 'deny',
    },
    allowsExecution: true,
    allowsWrites: true,
    requiresApproval: false,
    riskLevel: 'low',
  },

  readOnly: {
    name: 'readOnly',
    description: 'Read-only explore - reads pass through, all writes and command executions prompt',
    defaults: {
      read: 'allow',
      write: 'prompt',
      execute: 'prompt',
      network: 'allow',
      dangerous: 'prompt',
      admin: 'deny',
    },
    allowsExecution: true,
    allowsWrites: true,
    requiresApproval: false,
    riskLevel: 'low',
  },

  acceptEdits: {
    name: 'acceptEdits',
    description: 'Auto-accept file edits, prompt for execution and network',
    defaults: {
      read: 'allow',
      write: 'allow',
      execute: 'prompt',
      network: 'prompt',
      dangerous: 'prompt',
      admin: 'deny',
    },
    allowsExecution: true,
    allowsWrites: true,
    requiresApproval: false,
    riskLevel: 'medium',
  },

  dontAsk: {
    name: 'dontAsk',
    description: 'Minimal permissions - auto-deny risky operations',
    defaults: {
      read: 'allow',
      write: 'deny',
      execute: 'deny',
      network: 'deny',
      dangerous: 'deny',
      admin: 'deny',
    },
    allowsExecution: false,
    allowsWrites: false,
    requiresApproval: false,
    riskLevel: 'low',
  },

  bypassPermissions: {
    name: 'bypassPermissions',
    description: 'Skip all permission checks - USE WITH EXTREME CAUTION',
    defaults: {
      read: 'allow',
      write: 'allow',
      execute: 'allow',
      network: 'allow',
      dangerous: 'prompt', // Still prompt for truly dangerous operations
      admin: 'deny',
    },
    allowsExecution: true,
    allowsWrites: true,
    requiresApproval: true, // Requires explicit user approval
    riskLevel: 'critical',
  },

  plan: {
    name: 'plan',
    description: 'Planning mode - read-only exploration, no execution',
    defaults: {
      read: 'allow',
      write: 'deny',
      execute: 'deny',
      network: 'allow', // Allow network for research
      dangerous: 'deny',
      admin: 'deny',
    },
    allowsExecution: false,
    allowsWrites: false,
    requiresApproval: false,
    riskLevel: 'low',
  },

  delegate: {
    name: 'delegate',
    description: 'Delegation mode - inherit permissions from parent agent',
    defaults: {
      read: 'allow',
      write: 'prompt',
      execute: 'prompt',
      network: 'prompt',
      dangerous: 'deny',
      admin: 'deny',
    },
    allowsExecution: true,
    allowsWrites: true,
    requiresApproval: false,
    riskLevel: 'medium',
  },
};

// ----------------------------------------------------------------------------
// Permission Mode Class
// ----------------------------------------------------------------------------

/**
 * Permission Mode Manager
 *
 * Manages the current permission mode and provides methods to
 * evaluate permission requests according to the active mode.
 */
export class PermissionModeManager {
  private currentMode: PermissionMode = 'default';
  private parentMode: PermissionMode | null = null;
  private modeHistory: Array<{ mode: PermissionMode; timestamp: number }> = [];
  private customOverrides: Map<string, PermissionAction> = new Map();
  // 会话级权限档（B1 收口）：key=sessionId。无条目的会话回退全局 currentMode。
  // 显式切换（setSessionMode）写穿到 SESSION_MODES_FILE，跨重启不回退；
  // ponytail: initSessionMode 的创建期快照不落盘（重启后回退当时的全局默认档），
  // 只持久化用户显式选的档——要完整快照语义再把 init 也写穿。
  private sessionModes: Map<string, PermissionMode> = new Map();
  private sessionModesLoaded = false;
  // 无人值守会话（cron/heartbeat 等 automation 来源）：权限档读取时强制钳到不高于 acceptEdits。
  private unattendedSessions: Set<string> = new Set();

  constructor(initialMode: PermissionMode = 'default') {
    this.currentMode = initialMode;
    this.recordModeChange(initialMode);
  }

  /**
   * Get current permission mode
   */
  getMode(): PermissionMode {
    return this.currentMode;
  }

  /**
   * Get mode configuration
   */
  getModeConfig(mode?: PermissionMode): ModeConfig {
    return MODE_CONFIGS[mode || this.currentMode];
  }

  /**
   * Set permission mode
   *
   * @param mode - New mode to set
   * @param approved - Whether user has approved this mode change
   * @returns Whether mode was changed
   */
  setMode(mode: PermissionMode, approved = false): boolean {
    const config = MODE_CONFIGS[mode];

    // Check if mode requires approval
    if (config.requiresApproval && !approved) {
      logger.warn('Mode requires user approval', { mode });
      return false;
    }

    const previousMode = this.currentMode;
    this.currentMode = mode;
    this.recordModeChange(mode);

    logger.info('Permission mode changed', {
      from: previousMode,
      to: mode,
      riskLevel: config.riskLevel,
    });

    return true;
  }

  /**
   * 解析某个会话的有效权限档：会话级覆盖优先，无覆盖回退全局档。
   * 判定链（toolExecutor / subagent / bash 沙箱）统一走这里取档。
   * 无人值守会话在此单点钳制（B1 ③）：bypassPermissions 强制降到 acceptEdits，
   * 杜绝「用户开着 bypass 时定时任务也 bypass 跑」。
   */
  getModeForSession(sessionId?: string): PermissionMode {
    this.ensureSessionModesLoaded();
    const base = (sessionId && this.sessionModes.get(sessionId)) || this.currentMode;
    if (sessionId && this.unattendedSessions.has(sessionId)) {
      return clampUnattendedPermissionMode(base);
    }
    return base;
  }

  /**
   * 标记无人值守会话（automation/cron 定时会话创建收口处调用）。
   */
  markUnattendedSession(sessionId: string): void {
    this.unattendedSessions.add(sessionId);
  }

  /**
   * 是否无人值守会话（bash OS 沙箱等下游围栏用：钳制档位不等于撤围栏）。
   */
  isUnattendedSession(sessionId?: string): boolean {
    return !!sessionId && this.unattendedSessions.has(sessionId);
  }

  /**
   * 会话创建收口（B1 ②）：新会话按「新会话默认权限档」（全局 currentMode，
   * 由 settings.permissions.permissionMode 持久化）快照建档。之后修改默认档
   * 只影响新会话；当前会话档由会话内切换器（setSessionMode）管理。
   */
  initSessionMode(sessionId: string): void {
    this.ensureSessionModesLoaded();
    if (this.sessionModes.has(sessionId)) return;
    this.sessionModes.set(sessionId, this.currentMode);
  }

  /**
   * 设置会话级权限档（会话内切换器入口）。与全局 setMode 同一审批语义。
   */
  setSessionMode(sessionId: string, mode: PermissionMode, approved = false): boolean {
    const config = MODE_CONFIGS[mode];
    if (!config) return false;
    if (config.requiresApproval && !approved) {
      logger.warn('Session mode requires user approval', { sessionId, mode });
      return false;
    }
    this.ensureSessionModesLoaded();
    this.sessionModes.set(sessionId, mode);
    this.persistSessionModes();
    logger.info('Session permission mode changed', { sessionId, mode, riskLevel: config.riskLevel });
    return true;
  }

  /**
   * 从磁盘装载已持久化的会话档（惰性，一次）。内存中已有的条目优先（内存更新）。
   */
  private ensureSessionModesLoaded(): void {
    if (this.sessionModesLoaded) return;
    this.sessionModesLoaded = true;
    try {
      const filePath = this.sessionModesFilePath();
      if (!fs.existsSync(filePath)) return;
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Record<string, PermissionMode>;
      for (const [sessionId, mode] of Object.entries(raw)) {
        if (!this.sessionModes.has(sessionId) && MODE_CONFIGS[mode]) {
          this.sessionModes.set(sessionId, mode);
        }
      }
    } catch (error) {
      logger.warn('Failed to load persisted session permission modes, starting fresh', error);
    }
  }

  private persistSessionModes(): void {
    try {
      while (this.sessionModes.size > SESSION_MODES_MAX_ENTRIES) {
        const oldest = this.sessionModes.keys().next().value;
        if (oldest === undefined) break;
        this.sessionModes.delete(oldest);
      }
      const filePath = this.sessionModesFilePath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(this.sessionModes)), 'utf-8');
    } catch (error) {
      logger.warn('Failed to persist session permission modes', error);
    }
  }

  private sessionModesFilePath(): string {
    return path.join(getUserConfigDir(), SESSION_MODES_FILE);
  }

  /**
   * Set parent mode for delegation
   */
  setParentMode(mode: PermissionMode): void {
    this.parentMode = mode;
  }

  /**
   * Get effective mode (considers delegation)
   */
  getEffectiveMode(): PermissionMode {
    if (this.currentMode === 'delegate' && this.parentMode) {
      return this.parentMode;
    }
    return this.currentMode;
  }

  /**
   * Evaluate a permission request
   *
   * @param request - Permission request to evaluate
   * @returns Action to take (allow, deny, or prompt)
   */
  evaluate(request: PermissionRequest): PermissionAction {
    const effectiveMode = this.getEffectiveMode();
    const config = MODE_CONFIGS[effectiveMode];

    // Check for custom overrides first
    const overrideKey = `${request.tool}:${request.level}`;
    const override = this.customOverrides.get(overrideKey);
    if (override) {
      logger.debug('Using custom override', { key: overrideKey, action: override });
      return override;
    }

    // Get default action for this level
    const action = config.defaults[request.level];

    logger.debug('Permission evaluated', {
      mode: effectiveMode,
      level: request.level,
      tool: request.tool,
      action,
    });

    return action;
  }

  /**
   * Check if an operation should be allowed
   *
   * @param request - Permission request
   * @returns true if allowed, false if should prompt or deny
   */
  shouldAllow(request: PermissionRequest): boolean {
    return this.evaluate(request) === 'allow';
  }

  /**
   * Check if an operation should prompt
   *
   * @param request - Permission request
   * @returns true if should prompt
   */
  shouldPrompt(request: PermissionRequest): boolean {
    return this.evaluate(request) === 'prompt';
  }

  /**
   * Check if an operation should be denied
   *
   * @param request - Permission request
   * @returns true if should deny
   */
  shouldDeny(request: PermissionRequest): boolean {
    return this.evaluate(request) === 'deny';
  }

  /**
   * Add a custom override for a specific tool/level combination
   */
  addOverride(tool: string, level: PermissionLevel, action: PermissionAction): void {
    const key = `${tool}:${level}`;
    this.customOverrides.set(key, action);
    logger.debug('Custom override added', { key, action });
  }

  /**
   * Remove a custom override
   */
  removeOverride(tool: string, level: PermissionLevel): void {
    const key = `${tool}:${level}`;
    this.customOverrides.delete(key);
  }

  /**
   * Clear all custom overrides
   */
  clearOverrides(): void {
    this.customOverrides.clear();
  }

  /**
   * Check if execution is allowed in current mode
   */
  allowsExecution(): boolean {
    return MODE_CONFIGS[this.getEffectiveMode()].allowsExecution;
  }

  /**
   * Check if writes are allowed in current mode
   */
  allowsWrites(): boolean {
    return MODE_CONFIGS[this.getEffectiveMode()].allowsWrites;
  }

  /**
   * Get mode history
   */
  getModeHistory(): Array<{ mode: PermissionMode; timestamp: number }> {
    return [...this.modeHistory];
  }

  /**
   * Record mode change in history
   */
  private recordModeChange(mode: PermissionMode): void {
    this.modeHistory.push({
      mode,
      timestamp: Date.now(),
    });

    // Keep only last 50 entries
    if (this.modeHistory.length > 50) {
      this.modeHistory = this.modeHistory.slice(-50);
    }
  }

  /**
   * Get a summary of available modes
   */
  static getModeSummary(): Array<{
    mode: PermissionMode;
    description: string;
    riskLevel: string;
  }> {
    return Object.values(MODE_CONFIGS).map((config) => ({
      mode: config.name,
      description: config.description,
      riskLevel: config.riskLevel,
    }));
  }

  /**
   * Validate if a mode transition is safe
   */
  static isTransitionSafe(from: PermissionMode, to: PermissionMode): boolean {
    const fromConfig = MODE_CONFIGS[from];
    const toConfig = MODE_CONFIGS[to];

    // Transitioning to a higher risk level requires approval
    const riskOrder = ['low', 'medium', 'high', 'critical'];
    const fromRisk = riskOrder.indexOf(fromConfig.riskLevel);
    const toRisk = riskOrder.indexOf(toConfig.riskLevel);

    return toRisk <= fromRisk;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let permissionModeManagerInstance: PermissionModeManager | null = null;

/**
 * Get or create permission mode manager instance
 */
export function getPermissionModeManager(): PermissionModeManager {
  if (!permissionModeManagerInstance) {
    permissionModeManagerInstance = new PermissionModeManager();
  }
  return permissionModeManagerInstance;
}

/**
 * Reset permission mode manager instance (for testing)
 */
export function resetPermissionModeManager(): void {
  permissionModeManagerInstance = null;
}

/**
 * Convenience function to get current mode
 */
export function getCurrentMode(): PermissionMode {
  return getPermissionModeManager().getMode();
}

/**
 * Convenience function to set mode
 */
export function setPermissionMode(mode: PermissionMode, approved = false): boolean {
  return getPermissionModeManager().setMode(mode, approved);
}

/**
 * 无人值守权限档钳制：不得高于 acceptEdits。
 * 目前只有 bypassPermissions 高于 acceptEdits，其余档位原样返回。
 */
export function clampUnattendedPermissionMode(mode: PermissionMode): PermissionMode {
  return mode === 'bypassPermissions' ? 'acceptEdits' : mode;
}

/**
 * 档位免确认语义（单一真源，主 agent 判定链与 subagent requestPermission 共用）：
 * bypassPermissions = 写入 + 执行免确认；acceptEdits = 仅写入免确认；其余档一律不免。
 * 只覆盖「本来要问用户」的 ask —— deny / 硬毙 / 策略强确认不经此放宽。
 */
export function permissionModeAutoApproves(mode: string, level: string): boolean {
  if (mode === 'bypassPermissions') return level === 'write' || level === 'execute';
  if (mode === 'acceptEdits') return level === 'write';
  return false;
}
