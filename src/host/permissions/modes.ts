// ============================================================================
// Permission Modes - Define different permission handling behaviors
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import { getUserConfigDir } from '../config/configPaths';
import type { PermissionPreset } from '../../shared/contract/permission';

const logger = createLogger('PermissionModes');

// 会话档持久化文件（审出 MED：纯内存跨重启会静默回退全局默认档）。
const SESSION_MODES_FILE = 'session-permission-modes.json';

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
  // 单独记录显式选档的来源：创建期快照只存在 sessionModes，不能被旁边的持久化带上磁盘。
  private explicitSessionModes: Map<string, PermissionMode> = new Map();
  private sessionModesLoaded = false;
  // 无人值守会话（cron/heartbeat 等 automation 来源）：权限档读取时强制钳到不高于 acceptEdits。
  private unattendedSessions: Set<string> = new Set();
  /**
   * 云货架专家的首跑会话：本轮一律最严档，不看会话自己选的档。
   * 只在本轮有效（turn 结束即 clear），第二轮起回到会话档。
   */
  private firstRunStrictSessions: Set<string> = new Set();
  /**
   * 本轮跑的专家自带的审批档（详情页「安全」页 / agent.md 的 permission-override）。
   * 「为这位专家单独设置」比会话档更具体，所以它取代会话档当 base——包括放宽方向
   * （放手档 → bypassPermissions）；首跑 / 无人值守两处钳制仍压在它之上，只收紧不放宽。
   */
  private rolePresetSessions: Map<string, PermissionMode> = new Map();
  /**
   * 正在实时语音通话中的会话（D4）：语音态比文本再严一档。
   * 用户在通话里说「直接改吧」时，手不在键盘上、眼睛不在 diff 上——免确认档在这种
   * 姿态下等于无人值守，所以写盘/执行一律退回交互确认。
   */
  private liveVoiceSessions: Set<string> = new Set();

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
    const base = (sessionId && this.rolePresetSessions.get(sessionId))
      || (sessionId && this.sessionModes.get(sessionId))
      || this.currentMode;
    // 三处钳制都只收紧不放宽，所以依次叠加即可，顺序不影响结果。
    let mode = base;
    if (sessionId && this.firstRunStrictSessions.has(sessionId)) {
      mode = clampFirstRunPermissionMode(mode);
    }
    if (sessionId && this.unattendedSessions.has(sessionId)) {
      mode = clampUnattendedPermissionMode(mode);
    }
    if (sessionId && this.liveVoiceSessions.has(sessionId)) {
      mode = clampLiveVoicePermissionMode(mode);
    }
    return mode;
  }

  /**
   * 标记「这一轮是某个云货架专家的首跑」——档位钳到最严，用户能看见每一步审批。
   *
   * 主 agent 的档位单一真源就是本方法所在的 getModeForSession()。PR #690 曾把首跑钳制
   * 钩在 subagentExecutor 上，而用户选中专家聊天时专家是主 agent，那条路根本不经过——
   * 2026-07-25 真机 dogfood 因此判 NO-GO（两轮行为无差别、文件直接落盘）。
   */
  markFirstRunStrictSession(sessionId: string): void {
    this.firstRunStrictSessions.add(sessionId);
  }

  /** 本轮结束即解除，第二轮起回到会话自己的档。 */
  clearFirstRunStrictSession(sessionId: string): void {
    this.firstRunStrictSessions.delete(sessionId);
  }

  /**
   * 标记「这一轮跑的专家自带审批档」——PR #637 打通了 agent.md 的 permission-override，
   * 但它的下游出口只有 subagentPipeline；用户在输入框选中专家直接聊时专家是主 agent，
   * 那条路根本不经过（与 #690/#697 同源）。主 agent 的档位单一真源就是 getModeForSession，
   * 所以档位在轮起点写进来、finally 清掉。
   */
  setRolePresetSession(sessionId: string, mode: PermissionMode): void {
    this.rolePresetSessions.set(sessionId, mode);
  }

  /** 本轮结束即解除，没带档的专家 / 下一轮换人时回到会话自己的档。 */
  clearRolePresetSession(sessionId: string): void {
    this.rolePresetSessions.delete(sessionId);
  }

  /** 标记会话进入实时语音通话态（VoiceSessionService 建连成功时调用）。 */
  markLiveVoiceSession(sessionId: string): void {
    this.liveVoiceSessions.add(sessionId);
  }

  /** 挂断即解除（VoiceSessionService teardown 调用）。 */
  clearLiveVoiceSession(sessionId: string): void {
    this.liveVoiceSessions.delete(sessionId);
  }

  /**
   * 是否处于实时语音通话态。子 agent 链的档位钳制读这里——PermissionConfig 那条链
   * 不经过 getModeForSession，只共享这一个会话态标记（D4 两条链同源单一真源）。
   */
  isLiveVoiceSession(sessionId?: string): boolean {
    return !!sessionId && this.liveVoiceSessions.has(sessionId);
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
    this.explicitSessionModes.set(sessionId, mode);
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
          this.explicitSessionModes.set(sessionId, mode);
        }
      }
    } catch (error) {
      logger.warn('Failed to load persisted session permission modes, starting fresh', error);
    }
  }

  private persistSessionModes(): void {
    try {
      const filePath = this.sessionModesFilePath();
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(Object.fromEntries(this.explicitSessionModes)), 'utf-8');
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
 * 首跑钳制：把任何「有免确认」的档收到 readOnly（读通过、每一次写/执行都问用户）。
 * 只收紧不放宽——已经更严的档（plan / readOnly）原样返回。
 */
/**
 * 专家审批档 → 主 agent 档位。详情页三档承诺的行为逐条对上：
 * - strict「每一步都先问过你」→ readOnly（读通过，写/执行一律确认，免确认捷径全失效）
 * - development「工作目录内自己来，目录外先问」→ default（classifier 的 W1/R3 即此语义）
 * - ci「不管在哪儿都自己动手」→ bypassPermissions（硬毙清单与危险命令二次确认照常）
 */
export function rolePermissionPresetToMode(preset: 'strict' | 'development' | 'ci'): PermissionMode {
  return preset === 'strict' ? 'readOnly' : preset === 'ci' ? 'bypassPermissions' : 'default';
}

/**
 * D4 Live 语音抬严（主 agent 链）：通话态比文本再严一档。
 *
 * 映射表照方案 §6.7.10：bypassPermissions / acceptEdits → default（免确认全部失效），
 * 其余档原样返回——default 本身写/执行/网络就已经全是 prompt，dontAsk / readOnly /
 * plan 已经更严，delegate 由上游先解析成父档再进这里。
 *
 * 为什么不是「口头说允许就行」：通话时用户手不在键盘、眼睛不在 diff 上，
 * 口述「好的」既没有具体对象也没有可回看的痕迹，不能替代权限卡点击。
 */
export function clampLiveVoicePermissionMode(mode: PermissionMode): PermissionMode {
  return mode === 'bypassPermissions' || mode === 'acceptEdits' ? 'default' : mode;
}

/**
 * D4 Live 语音抬严（子 agent 链）：与上面同一决议的 preset 口径。
 *
 * 两条链的档位类型不同（主链是 PermissionMode，子链是 PermissionPreset →
 * PermissionConfig），但抬严语义一致：ci 档四类操作全自动批准，等价于
 * bypassPermissions，通话态收到 development（写/执行退回 trustProjectDirectory 收口）；
 * development / strict 已经不免确认，原样返回。
 */
export function clampLiveVoicePermissionPreset(preset: PermissionPreset): PermissionPreset {
  return preset === 'ci' ? 'development' : preset;
}

export function clampFirstRunPermissionMode(mode: PermissionMode): PermissionMode {
  return permissionModeAutoApproves(mode, 'write') || permissionModeAutoApproves(mode, 'execute')
    ? 'readOnly'
    : mode;
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
