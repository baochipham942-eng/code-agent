// ============================================================================
// Permission Policy Engine - Evaluates permissions with rules and auditing
// ============================================================================

import { createLogger } from '../services/infra/logger';
import { getAuditLogger } from '../security/auditLogger';
import {
  type PermissionMode,
  type PermissionLevel,
  type PermissionAction,
  type PermissionRequest,
  getPermissionModeManager,
  MODE_CONFIGS,
} from './modes';

const logger = createLogger('PolicyEngine');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Policy rule matching criteria
 */
export interface PolicyMatcher {
  /** Match by tool name (exact or regex) */
  tool?: string | RegExp;
  /** Match by permission level */
  level?: PermissionLevel | PermissionLevel[];
  /** Match by path pattern (for file operations) */
  pathPattern?: string | RegExp;
  /** Match by command pattern (for execution) */
  commandPattern?: string | RegExp;
  /** Match by session ID */
  sessionId?: string;
  /** Custom matcher function */
  custom?: (request: PolicyRequest) => boolean;
}

/**
 * Extended permission request with additional context
 */
export interface PolicyRequest extends PermissionRequest {
  /** Session ID */
  sessionId?: string;
  /** File path (for file operations) */
  filePath?: string;
  /** Command (for execution) */
  command?: string;
  /** Request timestamp */
  timestamp?: number;
  /** Parent request (for delegation) */
  parentRequest?: PolicyRequest;
}

/**
 * Policy rule
 */
export interface PolicyRule {
  /** Rule ID for reference */
  id: string;
  /** Rule name */
  name: string;
  /** Rule description */
  description?: string;
  /** Priority (higher = evaluated first) */
  priority: number;
  /** Matcher criteria */
  matcher: PolicyMatcher;
  /** Action to take when matched */
  action: PermissionAction;
  /** Optional reason to show user */
  reason?: string;
  /** Whether this rule can be overridden by mode */
  overridable: boolean;
  /** Whether to audit when this rule is applied */
  audit: boolean;
}

/**
 * Policy evaluation result
 */
export interface PolicyResult {
  /** Final action */
  action: PermissionAction;
  /** Rule that was matched (if any) */
  matchedRule?: PolicyRule;
  /** Mode-based action (before rules) */
  modeAction: PermissionAction;
  /** Reason for the decision */
  reason: string;
  /** Whether the decision was audited */
  audited: boolean;
  /** Evaluation timestamp */
  timestamp: number;
}

/**
 * Policy audit entry
 */
export interface PolicyAuditEntry {
  timestamp: number;
  sessionId?: string;
  request: PolicyRequest;
  result: PolicyResult;
  mode: PermissionMode;
}

// ----------------------------------------------------------------------------
// Built-in Rules
// ----------------------------------------------------------------------------

const BUILT_IN_RULES: PolicyRule[] = [
  // Block dangerous file paths
  {
    id: 'block-root-write',
    name: 'Block root filesystem writes',
    description: 'Prevent writing to system directories',
    priority: 1000,
    matcher: {
      level: 'write',
      pathPattern: /^\/(?:usr|bin|sbin|etc|lib|lib64|boot|sys|proc)\//,
    },
    action: 'deny',
    reason: 'Writing to system directories is not allowed',
    overridable: false,
    audit: true,
  },
  {
    id: 'block-ssh-keys',
    name: 'Block SSH key access',
    description: 'Prevent access to SSH private keys',
    priority: 1000,
    matcher: {
      level: ['read', 'write'],
      pathPattern: /\.ssh\/id_[^/]+$/,
    },
    action: 'deny',
    reason: 'SSH private key access is not allowed',
    overridable: false,
    audit: true,
  },
  {
    id: 'block-env-files',
    name: 'Block sensitive env file writes',
    description: 'Prevent writing to .env files outside project',
    priority: 900,
    matcher: {
      level: 'write',
      pathPattern: /^\/(?:Users|home)\/[^/]+\/\.env/,
    },
    action: 'prompt',
    reason: 'Writing to environment files requires confirmation',
    overridable: true,
    audit: true,
  },

  // Block dangerous commands
  {
    id: 'block-rm-rf-root',
    name: 'Block recursive delete of root',
    priority: 1000,
    matcher: {
      level: 'execute',
      commandPattern: /rm\s+(-[rRf]+\s+)*\/\s*$/,
    },
    action: 'deny',
    reason: 'Deleting root filesystem is not allowed',
    overridable: false,
    audit: true,
  },
  {
    id: 'prompt-git-force-push',
    name: 'Prompt for force push',
    priority: 800,
    matcher: {
      level: 'execute',
      commandPattern: /git\s+push\s+.*--force/,
    },
    action: 'prompt',
    reason: 'Force push may overwrite remote history',
    overridable: true,
    audit: true,
  },
  {
    id: 'prompt-sudo',
    name: 'Prompt for sudo commands',
    priority: 900,
    matcher: {
      level: 'execute',
      commandPattern: /^sudo\s/,
    },
    action: 'prompt',
    reason: 'Sudo commands require confirmation',
    overridable: true,
    audit: true,
  },

  // Allow safe operations
  {
    id: 'allow-git-status',
    name: 'Allow git status',
    priority: 500,
    matcher: {
      level: 'execute',
      commandPattern: /^git\s+(status|log|diff|branch|show)/,
    },
    action: 'allow',
    overridable: true,
    audit: false,
  },
  {
    id: 'allow-ls',
    name: 'Allow ls commands',
    priority: 500,
    matcher: {
      level: 'execute',
      commandPattern: /^ls\s/,
    },
    action: 'allow',
    overridable: true,
    audit: false,
  },
];

// ----------------------------------------------------------------------------
// Policy Engine Class
// ----------------------------------------------------------------------------

/**
 * Permission Policy Engine
 *
 * Evaluates permission requests using:
 * 1. Built-in rules (highest priority)
 * 2. Custom rules (configurable priority)
 * 3. Mode-based defaults (fallback)
 *
 * Provides audit logging for all decisions.
 */
export class PolicyEngine {
  private rules: PolicyRule[] = [];
  private auditEnabled = true;
  private auditHistory: PolicyAuditEntry[] = [];
  private maxAuditHistory = 1000;

  constructor() {
    // Add built-in rules
    this.rules = [...BUILT_IN_RULES];
    this.sortRules();
  }

  /**
   * Add a custom rule
   */
  addRule(rule: PolicyRule): void {
    this.rules.push(rule);
    this.sortRules();
    logger.debug('Rule added', { id: rule.id, priority: rule.priority });
  }

  /**
   * Remove a rule by ID
   */
  removeRule(ruleId: string): boolean {
    const index = this.rules.findIndex((r) => r.id === ruleId);
    if (index !== -1) {
      this.rules.splice(index, 1);
      logger.debug('Rule removed', { id: ruleId });
      return true;
    }
    return false;
  }

  /**
   * Get all rules
   */
  getRules(): PolicyRule[] {
    return [...this.rules];
  }

  /**
   * Sort rules by priority (highest first)
   */
  private sortRules(): void {
    this.rules.sort((a, b) => b.priority - a.priority);
  }

  /**
   * Evaluate a permission request
   *
   * @param request - Permission request to evaluate
   * @returns Policy result with action and details
   */
  evaluate(request: PolicyRequest): PolicyResult {
    const timestamp = Date.now();
    const modeManager = getPermissionModeManager();
    const mode = modeManager.getEffectiveMode();

    // Get mode-based default action
    const modeAction = modeManager.evaluate(request);

    // Try to find a matching rule
    let matchedRule: PolicyRule | undefined;
    let ruleAction: PermissionAction | undefined;

    for (const rule of this.rules) {
      if (this.matchesRule(request, rule)) {
        matchedRule = rule;

        // Non-overridable rules always apply
        if (!rule.overridable) {
          ruleAction = rule.action;
          break;
        }

        // Overridable rules: use rule action unless mode is more restrictive
        if (this.isMoreRestrictive(rule.action, modeAction)) {
          ruleAction = modeAction;
        } else {
          ruleAction = rule.action;
        }
        break;
      }
    }

    // Determine final action
    const finalAction = ruleAction ?? modeAction;
    const reason = matchedRule?.reason ?? this.getDefaultReason(finalAction, mode);

    const result: PolicyResult = {
      action: finalAction,
      matchedRule,
      modeAction,
      reason,
      audited: false,
      timestamp,
    };

    // Audit if needed
    if (this.auditEnabled && (matchedRule?.audit ?? this.shouldAuditByDefault(request))) {
      this.audit(request, result, mode);
      result.audited = true;
    }

    logger.debug('Policy evaluated', {
      level: request.level,
      tool: request.tool,
      action: finalAction,
      rule: matchedRule?.id,
      mode,
    });

    return result;
  }

  /**
   * Check if a request matches a rule
   */
  private matchesRule(request: PolicyRequest, rule: PolicyRule): boolean {
    const { matcher } = rule;

    // Tool matching
    if (matcher.tool) {
      if (typeof matcher.tool === 'string') {
        if (request.tool !== matcher.tool) return false;
      } else {
        if (!matcher.tool.test(request.tool)) return false;
      }
    }

    // Level matching
    if (matcher.level) {
      const levels = Array.isArray(matcher.level) ? matcher.level : [matcher.level];
      if (!levels.includes(request.level)) return false;
    }

    // Path matching
    if (matcher.pathPattern && request.filePath) {
      if (typeof matcher.pathPattern === 'string') {
        if (!request.filePath.includes(matcher.pathPattern)) return false;
      } else {
        if (!matcher.pathPattern.test(request.filePath)) return false;
      }
    }

    // Command matching
    if (matcher.commandPattern && request.command) {
      if (typeof matcher.commandPattern === 'string') {
        if (!request.command.includes(matcher.commandPattern)) return false;
      } else {
        if (!matcher.commandPattern.test(request.command)) return false;
      }
    }

    // Session matching
    if (matcher.sessionId && request.sessionId !== matcher.sessionId) {
      return false;
    }

    // Custom matcher
    if (matcher.custom && !matcher.custom(request)) {
      return false;
    }

    return true;
  }

  /**
   * Check if action A is more restrictive than action B
   */
  private isMoreRestrictive(a: PermissionAction, b: PermissionAction): boolean {
    const order = { deny: 2, prompt: 1, allow: 0 };
    return order[a] > order[b];
  }

  /**
   * Get default reason for an action
   */
  private getDefaultReason(action: PermissionAction, mode: PermissionMode): string {
    const modeConfig = MODE_CONFIGS[mode];
    switch (action) {
      case 'allow':
        return `Allowed by ${modeConfig.name} mode`;
      case 'deny':
        return `Denied by ${modeConfig.name} mode`;
      case 'prompt':
        return `Requires confirmation in ${modeConfig.name} mode`;
    }
  }

  /**
   * Check if a request should be audited by default
   */
  private shouldAuditByDefault(request: PolicyRequest): boolean {
    // Audit execution and dangerous operations
    return request.level === 'execute' ||
           request.level === 'dangerous' ||
           request.level === 'admin';
  }

  /**
   * Record an audit entry
   */
  private audit(request: PolicyRequest, result: PolicyResult, mode: PermissionMode): void {
    const entry: PolicyAuditEntry = {
      timestamp: result.timestamp,
      sessionId: request.sessionId,
      request,
      result,
      mode,
    };

    // Add to local history
    this.auditHistory.push(entry);
    if (this.auditHistory.length > this.maxAuditHistory) {
      this.auditHistory = this.auditHistory.slice(-this.maxAuditHistory);
    }

    // Log to audit system
    try {
      const auditLogger = getAuditLogger();
      auditLogger.log({
        eventType: 'permission_check',
        sessionId: request.sessionId || 'unknown',
        toolName: request.tool,
        input: {
          level: request.level,
          description: request.description,
          filePath: request.filePath,
          command: request.command,
        },
        output: result.reason,
        duration: 0,
        success: result.action !== 'deny',
        metadata: {
          mode,
          action: result.action,
          rule: result.matchedRule?.id,
        },
      });
    } catch (error) {
      logger.warn('Failed to write audit log', { error });
    }
  }

  /**
   * Get audit history
   */
  getAuditHistory(options?: {
    sessionId?: string;
    limit?: number;
    since?: number;
  }): PolicyAuditEntry[] {
    let entries = this.auditHistory;

    if (options?.sessionId) {
      entries = entries.filter((e) => e.sessionId === options.sessionId);
    }

    if (options?.since) {
      entries = entries.filter((e) => e.timestamp >= options.since);
    }

    if (options?.limit) {
      entries = entries.slice(-options.limit);
    }

    return entries;
  }

  /**
   * Clear audit history
   */
  clearAuditHistory(): void {
    this.auditHistory = [];
  }

  /**
   * Enable/disable auditing
   */
  setAuditEnabled(enabled: boolean): void {
    this.auditEnabled = enabled;
  }

  /**
   * Check if auditing is enabled
   */
  isAuditEnabled(): boolean {
    return this.auditEnabled;
  }

  /**
   * Get statistics about recent decisions
   */
  getStatistics(since?: number): {
    total: number;
    allowed: number;
    denied: number;
    prompted: number;
    byLevel: Record<string, number>;
    byRule: Record<string, number>;
  } {
    const entries = since
      ? this.auditHistory.filter((e) => e.timestamp >= since)
      : this.auditHistory;

    const stats = {
      total: entries.length,
      allowed: 0,
      denied: 0,
      prompted: 0,
      byLevel: {} as Record<string, number>,
      byRule: {} as Record<string, number>,
    };

    for (const entry of entries) {
      // Count by action
      switch (entry.result.action) {
        case 'allow':
          stats.allowed++;
          break;
        case 'deny':
          stats.denied++;
          break;
        case 'prompt':
          stats.prompted++;
          break;
      }

      // Count by level
      const level = entry.request.level;
      stats.byLevel[level] = (stats.byLevel[level] || 0) + 1;

      // Count by rule
      const ruleId = entry.result.matchedRule?.id || 'mode-default';
      stats.byRule[ruleId] = (stats.byRule[ruleId] || 0) + 1;
    }

    return stats;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let policyEngineInstance: PolicyEngine | null = null;

/**
 * Get or create policy engine instance
 */
export function getPolicyEngine(): PolicyEngine {
  if (!policyEngineInstance) {
    policyEngineInstance = new PolicyEngine();
  }
  return policyEngineInstance;
}

/**
 * Reset policy engine instance (for testing)
 */
export function resetPolicyEngine(): void {
  policyEngineInstance = null;
}

/**
 * Convenience function to evaluate a permission request
 */
export function evaluatePermission(request: PolicyRequest): PolicyResult {
  return getPolicyEngine().evaluate(request);
}
