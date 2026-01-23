// ============================================================================
// Permission Modes - Define different permission handling behaviors
// ============================================================================

import { createLogger } from '../services/infra/logger';

const logger = createLogger('PermissionModes');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Permission mode determines how permission requests are handled
 */
export type PermissionMode =
  | 'default'           // Standard interactive prompting
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
