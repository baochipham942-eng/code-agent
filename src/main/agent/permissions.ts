// ============================================================================
// Sub-Agent Permissions - Permission inheritance and contraction
// ============================================================================

import { createLogger } from '../services/infra/logger';
import {
  type PermissionMode,
  type PermissionLevel,
  type PermissionAction,
  type PermissionRequest,
  MODE_CONFIGS,
  getPermissionModeManager,
} from '../permissions/modes';
import { getPolicyEngine, type PolicyRequest } from '../permissions/policyEngine';
import type { AgentDefinition, PermissionConstraints } from './types';

const logger = createLogger('SubAgentPermissions');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Permission evaluation result for sub-agents
 */
export interface SubAgentPermissionResult {
  /** Final action */
  action: PermissionAction;

  /** Effective permission mode */
  effectiveMode: PermissionMode;

  /** Whether permission was contracted from parent */
  contracted: boolean;

  /** Reason for the decision */
  reason: string;

  /** Constraints that were applied */
  appliedConstraints: string[];
}

/**
 * Permission context for a sub-agent
 */
export interface SubAgentPermissionContext {
  /** Sub-agent definition */
  agentDefinition: AgentDefinition;

  /** Parent agent's permission mode */
  parentMode: PermissionMode;

  /** Parent's permission constraints */
  parentConstraints?: PermissionConstraints;

  /** Session ID for audit */
  sessionId?: string;
}

/**
 * Permission contraction rule
 */
export interface ContractionRule {
  /** Source mode */
  from: PermissionMode;

  /** Maximum allowed contracted mode */
  maxContracted: PermissionMode;

  /** Levels that can be preserved */
  preserveLevels: PermissionLevel[];
}

// ----------------------------------------------------------------------------
// Permission Contraction Rules
// ----------------------------------------------------------------------------

/**
 * Mode contraction hierarchy
 *
 * When a sub-agent is spawned, its permissions are contracted
 * (made more restrictive) based on the parent's mode.
 */
const MODE_HIERARCHY: PermissionMode[] = [
  'bypassPermissions',  // Most permissive (0)
  'acceptEdits',        // (1)
  'default',            // (2)
  'delegate',           // (3)
  'plan',               // (4)
  'dontAsk',            // Most restrictive (5)
];

/**
 * Get the restrictiveness level of a mode (higher = more restrictive)
 */
function getModeLevel(mode: PermissionMode): number {
  const index = MODE_HIERARCHY.indexOf(mode);
  return index === -1 ? 2 : index; // default to 'default' level
}

/**
 * Get the more restrictive of two modes
 */
function getMoreRestrictiveMode(a: PermissionMode, b: PermissionMode): PermissionMode {
  return getModeLevel(a) >= getModeLevel(b) ? a : b;
}

// ----------------------------------------------------------------------------
// Sub-Agent Permission Manager
// ----------------------------------------------------------------------------

/**
 * Sub-Agent Permission Manager
 *
 * Manages permission inheritance and contraction for sub-agents.
 *
 * Key principles:
 * 1. Sub-agents can never have more permissions than their parent
 * 2. Permissions are contracted based on agent definition
 * 3. Custom constraints from parent are always respected
 * 4. All permission decisions are audited
 */
export class SubAgentPermissionManager {
  /**
   * Calculate the effective permission mode for a sub-agent
   */
  calculateEffectiveMode(context: SubAgentPermissionContext): PermissionMode {
    const { agentDefinition, parentMode, parentConstraints } = context;

    // Start with the most restrictive of parent mode and agent's default
    let effectiveMode = getMoreRestrictiveMode(
      parentMode,
      agentDefinition.defaultPermissionMode
    );

    // Apply parent constraints if any
    if (parentConstraints?.maxMode) {
      effectiveMode = getMoreRestrictiveMode(effectiveMode, parentConstraints.maxMode);
    }

    logger.debug('Calculated effective mode', {
      agent: agentDefinition.id,
      parentMode,
      agentDefault: agentDefinition.defaultPermissionMode,
      effective: effectiveMode,
    });

    return effectiveMode;
  }

  /**
   * Create permission constraints for a sub-agent
   */
  createConstraints(context: SubAgentPermissionContext): PermissionConstraints {
    const { agentDefinition, parentConstraints } = context;

    // Start with agent's max permission levels
    const allowedLevels = agentDefinition.maxPermissionLevels;

    // Calculate blocked levels (all levels not in allowed list)
    const allLevels: PermissionLevel[] = ['read', 'write', 'execute', 'network', 'dangerous', 'admin'];
    const blockedLevels = allLevels.filter(level => !allowedLevels.includes(level));

    // Merge with parent's blocked levels
    if (parentConstraints?.blockedLevels) {
      for (const level of parentConstraints.blockedLevels) {
        if (!blockedLevels.includes(level)) {
          blockedLevels.push(level);
        }
      }
    }

    // Inherit path restrictions from parent
    const allowedPaths = parentConstraints?.allowedPaths;
    const blockedPaths = parentConstraints?.blockedPaths;

    // Inherit command restrictions
    const allowedCommands = parentConstraints?.allowedCommands;
    const blockedCommands = parentConstraints?.blockedCommands;

    // Network access: only if both agent and parent allow it
    const allowNetwork = allowedLevels.includes('network') &&
      (parentConstraints?.allowNetwork !== false);

    const constraints: PermissionConstraints = {
      maxMode: this.calculateEffectiveMode(context),
      blockedLevels,
      allowedPaths,
      blockedPaths,
      allowedCommands,
      blockedCommands,
      allowNetwork,
    };

    logger.debug('Created constraints for sub-agent', {
      agent: agentDefinition.id,
      blockedLevels,
      allowNetwork,
    });

    return constraints;
  }

  /**
   * Evaluate a permission request for a sub-agent
   */
  evaluate(
    request: PermissionRequest,
    context: SubAgentPermissionContext
  ): SubAgentPermissionResult {
    const appliedConstraints: string[] = [];
    const constraints = this.createConstraints(context);
    const effectiveMode = constraints.maxMode;

    // Check if the permission level is blocked
    if (constraints.blockedLevels.includes(request.level)) {
      appliedConstraints.push(`Level '${request.level}' is blocked for this agent`);

      return {
        action: 'deny',
        effectiveMode,
        contracted: true,
        reason: `Permission level '${request.level}' is not allowed for ${context.agentDefinition.name}`,
        appliedConstraints,
      };
    }

    // Check path restrictions for file operations
    if (request.level === 'read' || request.level === 'write') {
      const policyRequest = request as PolicyRequest;
      if (policyRequest.filePath) {
        // Check blocked paths
        if (constraints.blockedPaths) {
          for (const blockedPath of constraints.blockedPaths) {
            if (policyRequest.filePath.startsWith(blockedPath)) {
              appliedConstraints.push(`Path '${blockedPath}' is blocked`);

              return {
                action: 'deny',
                effectiveMode,
                contracted: true,
                reason: `Access to path '${policyRequest.filePath}' is not allowed`,
                appliedConstraints,
              };
            }
          }
        }

        // Check allowed paths (if specified, path must be in list)
        if (constraints.allowedPaths && constraints.allowedPaths.length > 0) {
          const isAllowed = constraints.allowedPaths.some(
            allowed => policyRequest.filePath!.startsWith(allowed)
          );

          if (!isAllowed) {
            appliedConstraints.push('Path not in allowed list');

            return {
              action: 'deny',
              effectiveMode,
              contracted: true,
              reason: `Path '${policyRequest.filePath}' is outside allowed directories`,
              appliedConstraints,
            };
          }
        }
      }
    }

    // Check network restriction
    if (request.level === 'network' && !constraints.allowNetwork) {
      appliedConstraints.push('Network access is disabled');

      return {
        action: 'deny',
        effectiveMode,
        contracted: true,
        reason: 'Network access is not allowed for this sub-agent',
        appliedConstraints,
      };
    }

    // Check command restrictions for execute
    if (request.level === 'execute') {
      const policyRequest = request as PolicyRequest;
      if (policyRequest.command) {
        // Check blocked commands
        if (constraints.blockedCommands) {
          for (const pattern of constraints.blockedCommands) {
            if (pattern.test(policyRequest.command)) {
              appliedConstraints.push(`Command matches blocked pattern`);

              return {
                action: 'deny',
                effectiveMode,
                contracted: true,
                reason: `Command '${policyRequest.command}' is not allowed`,
                appliedConstraints,
              };
            }
          }
        }

        // Check allowed commands (if specified)
        if (constraints.allowedCommands && constraints.allowedCommands.length > 0) {
          const isAllowed = constraints.allowedCommands.some(
            pattern => pattern.test(policyRequest.command!)
          );

          if (!isAllowed) {
            appliedConstraints.push('Command not in allowed list');

            return {
              action: 'deny',
              effectiveMode,
              contracted: true,
              reason: `Command '${policyRequest.command}' is not in allowed commands`,
              appliedConstraints,
            };
          }
        }
      }
    }

    // Use policy engine with effective mode
    const policyEngine = getPolicyEngine();
    const policyResult = policyEngine.evaluate({
      ...request,
      sessionId: context.sessionId,
    } as PolicyRequest);

    // Apply mode contraction if needed
    const modeManager = getPermissionModeManager();
    const modeConfig = MODE_CONFIGS[effectiveMode];
    const modeAction = modeConfig.defaults[request.level];

    // Take the more restrictive action
    let finalAction = policyResult.action;
    const actionOrder: Record<PermissionAction, number> = { allow: 0, prompt: 1, deny: 2 };

    if (actionOrder[modeAction] > actionOrder[finalAction]) {
      finalAction = modeAction;
      appliedConstraints.push(`Mode '${effectiveMode}' requires ${modeAction}`);
    }

    // Check if contracted
    const originalMode = getPermissionModeManager().getMode();
    const contracted = getModeLevel(effectiveMode) > getModeLevel(originalMode);

    if (contracted) {
      appliedConstraints.push(`Permissions contracted from '${originalMode}' to '${effectiveMode}'`);
    }

    return {
      action: finalAction,
      effectiveMode,
      contracted,
      reason: policyResult.reason,
      appliedConstraints,
    };
  }

  /**
   * Check if a sub-agent can be spawned with given permissions
   */
  canSpawn(
    agentDefinition: AgentDefinition,
    parentMode: PermissionMode,
    parentConstraints?: PermissionConstraints
  ): { allowed: boolean; reason?: string } {
    // Check if parent mode allows delegation
    const parentConfig = MODE_CONFIGS[parentMode];

    // plan and dontAsk modes don't allow spawning agents that can execute
    if ((parentMode === 'plan' || parentMode === 'dontAsk') &&
        agentDefinition.capabilities.includes('code_execution')) {
      return {
        allowed: false,
        reason: `Cannot spawn agent with code execution capability in ${parentMode} mode`,
      };
    }

    // Check if any required capability is blocked
    if (parentConstraints?.blockedLevels) {
      const levelToCapability: Record<PermissionLevel, string[]> = {
        read: ['file_operations'],
        write: ['file_operations'],
        execute: ['code_execution'],
        network: ['web_access', 'research'],
        dangerous: [],
        admin: [],
      };

      for (const level of parentConstraints.blockedLevels) {
        const blockedCaps = levelToCapability[level] || [];
        const hasBlockedCap = agentDefinition.capabilities.some(
          cap => blockedCaps.includes(cap)
        );

        if (hasBlockedCap) {
          return {
            allowed: false,
            reason: `Agent requires ${level} level which is blocked`,
          };
        }
      }
    }

    return { allowed: true };
  }

  /**
   * Get a summary of permission differences for a sub-agent
   */
  getPermissionSummary(context: SubAgentPermissionContext): string[] {
    const summary: string[] = [];
    const constraints = this.createConstraints(context);

    summary.push(`Effective mode: ${constraints.maxMode}`);

    if (constraints.blockedLevels.length > 0) {
      summary.push(`Blocked levels: ${constraints.blockedLevels.join(', ')}`);
    }

    if (constraints.allowedPaths && constraints.allowedPaths.length > 0) {
      summary.push(`Allowed paths: ${constraints.allowedPaths.length} directories`);
    }

    if (constraints.blockedPaths && constraints.blockedPaths.length > 0) {
      summary.push(`Blocked paths: ${constraints.blockedPaths.length} directories`);
    }

    summary.push(`Network access: ${constraints.allowNetwork ? 'allowed' : 'blocked'}`);

    return summary;
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let subAgentPermissionManagerInstance: SubAgentPermissionManager | null = null;

/**
 * Get or create sub-agent permission manager instance
 */
export function getSubAgentPermissionManager(): SubAgentPermissionManager {
  if (!subAgentPermissionManagerInstance) {
    subAgentPermissionManagerInstance = new SubAgentPermissionManager();
  }
  return subAgentPermissionManagerInstance;
}

/**
 * Reset sub-agent permission manager instance (for testing)
 */
export function resetSubAgentPermissionManager(): void {
  subAgentPermissionManagerInstance = null;
}

/**
 * Convenience function to evaluate sub-agent permission
 */
export function evaluateSubAgentPermission(
  request: PermissionRequest,
  context: SubAgentPermissionContext
): SubAgentPermissionResult {
  return getSubAgentPermissionManager().evaluate(request, context);
}

/**
 * Convenience function to create constraints for a sub-agent
 */
export function createSubAgentConstraints(
  context: SubAgentPermissionContext
): PermissionConstraints {
  return getSubAgentPermissionManager().createConstraints(context);
}
