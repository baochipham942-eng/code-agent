// ============================================================================
// Subagent Pipeline - Unified permission/budget/audit pipeline
// T4: Subagent dual mode support
// ============================================================================

import { createLogger } from '../services/infra/logger';
import {
  type PermissionPreset,
  type PermissionConfig,
  getPresetConfig,
  isPathTrusted,
  isCommandBlocked,
  isDangerousCommand,
} from '../services/core/permissionPresets';
import {
  type BudgetStatus,
  type TokenUsage,
  BudgetAlertLevel,
  getBudgetService,
} from '../services/core/budgetService';
import type { AgentDefinition, DynamicAgentConfig } from './agentDefinition';

const logger = createLogger('SubagentPipeline');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Pipeline check result
 */
export interface PipelineCheckResult {
  allowed: boolean;
  reason?: string;
  warnings: string[];
}

/**
 * Tool execution request for permission checking
 */
export interface ToolExecutionRequest {
  toolName: string;
  permissionLevel: 'read' | 'write' | 'execute' | 'network';
  path?: string;
  command?: string;
  url?: string;
}

/**
 * Audit log entry for subagent operations
 */
export interface SubagentAuditEntry {
  timestamp: number;
  agentId: string;
  agentName: string;
  action: 'spawn' | 'tool_execute' | 'complete' | 'error' | 'budget_warning' | 'permission_denied';
  details: Record<string, unknown>;
  cost?: number;
}

/**
 * Subagent execution context
 */
export interface SubagentExecutionContext {
  agentId: string;
  agentName: string;
  parentAgentId?: string;
  permissionConfig: PermissionConfig;
  maxBudget?: number;
  workingDirectory: string;
  startTime: number;
  toolsUsed: string[];
  tokenUsage: TokenUsage[];
}

// ----------------------------------------------------------------------------
// SubagentPipeline
// ----------------------------------------------------------------------------

/**
 * SubagentPipeline - Unified pipeline for subagent permission/budget/audit
 *
 * This class provides:
 * 1. Permission checking based on presets
 * 2. Budget tracking and enforcement
 * 3. Audit logging for all operations
 *
 * @example
 * ```typescript
 * const pipeline = getSubagentPipeline();
 *
 * // Create context for a new subagent
 * const ctx = pipeline.createContext(agentDef, '/path/to/project');
 *
 * // Check tool execution
 * const result = pipeline.checkToolExecution(ctx, {
 *   toolName: 'bash',
 *   permissionLevel: 'execute',
 *   command: 'npm test',
 * });
 *
 * if (result.allowed) {
 *   // Execute tool...
 *   pipeline.recordToolUsage(ctx, 'bash');
 * }
 * ```
 */
export class SubagentPipeline {
  private auditLog: SubagentAuditEntry[] = [];
  private activeContexts: Map<string, SubagentExecutionContext> = new Map();

  // --------------------------------------------------------------------------
  // Context Management
  // --------------------------------------------------------------------------

  /**
   * Create execution context for a subagent
   */
  createContext(
    config: AgentDefinition | DynamicAgentConfig,
    workingDirectory: string,
    parentAgentId?: string
  ): SubagentExecutionContext {
    const agentId = `subagent_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Resolve agent name - AgentDefinition.name is required, DynamicAgentConfig.name is optional
    let agentName: string;
    if ('id' in config) {
      // AgentDefinition always has name
      agentName = config.name;
    } else {
      // DynamicAgentConfig may not have name
      agentName = config.name || 'Dynamic Agent';
    }

    // Resolve permission preset
    let preset: PermissionPreset;
    if ('id' in config) {
      // AgentDefinition always has permissionPreset
      preset = config.permissionPreset;
    } else {
      // DynamicAgentConfig may not have permissionPreset
      preset = config.permissionPreset || 'development';
    }

    const permissionConfig = getPresetConfig(preset, workingDirectory);

    const context: SubagentExecutionContext = {
      agentId,
      agentName,
      parentAgentId,
      permissionConfig,
      maxBudget: 'maxBudget' in config ? config.maxBudget : (config as DynamicAgentConfig).maxBudget,
      workingDirectory,
      startTime: Date.now(),
      toolsUsed: [],
      tokenUsage: [],
    };

    this.activeContexts.set(agentId, context);

    // Audit: spawn
    this.addAuditEntry({
      timestamp: Date.now(),
      agentId,
      agentName,
      action: 'spawn',
      details: {
        preset,
        parentAgentId,
        workingDirectory,
        maxBudget: context.maxBudget,
      },
    });

    logger.info(`Subagent context created: ${agentName} (${agentId})`);

    return context;
  }

  /**
   * Get active context by ID
   */
  getContext(agentId: string): SubagentExecutionContext | undefined {
    return this.activeContexts.get(agentId);
  }

  /**
   * Complete and cleanup context
   */
  completeContext(agentId: string, success: boolean, error?: string): void {
    const context = this.activeContexts.get(agentId);
    if (!context) return;

    const duration = Date.now() - context.startTime;
    const totalCost = this.calculateTotalCost(context.tokenUsage);

    // Audit: complete or error
    this.addAuditEntry({
      timestamp: Date.now(),
      agentId,
      agentName: context.agentName,
      action: success ? 'complete' : 'error',
      details: {
        duration,
        toolsUsed: context.toolsUsed,
        error,
      },
      cost: totalCost,
    });

    logger.info(`Subagent completed: ${context.agentName} (${agentId}) - success: ${success}, duration: ${duration}ms`);

    this.activeContexts.delete(agentId);
  }

  // --------------------------------------------------------------------------
  // Permission Checking
  // --------------------------------------------------------------------------

  /**
   * Check if a tool execution is allowed
   */
  checkToolExecution(context: SubagentExecutionContext, request: ToolExecutionRequest): PipelineCheckResult {
    const warnings: string[] = [];
    const { permissionConfig } = context;

    // 1. Check blocked commands
    if (request.command && isCommandBlocked(request.command, permissionConfig.blockedCommands)) {
      this.addAuditEntry({
        timestamp: Date.now(),
        agentId: context.agentId,
        agentName: context.agentName,
        action: 'permission_denied',
        details: {
          tool: request.toolName,
          reason: 'blocked_command',
          command: request.command,
        },
      });

      return {
        allowed: false,
        reason: `Command is blocked: ${request.command}`,
        warnings,
      };
    }

    // 2. Check dangerous commands (warning)
    if (request.command && isDangerousCommand(request.command)) {
      if (permissionConfig.confirmDangerousCommands) {
        warnings.push(`Dangerous command detected: ${request.command}`);
      }
    }

    // 3. Check auto-approve by permission level
    const autoApproved = permissionConfig.autoApprove[request.permissionLevel];

    // 4. Check trusted directory for write/execute operations
    if (!autoApproved && permissionConfig.trustProjectDirectory && request.path) {
      const pathTrusted = isPathTrusted(request.path, permissionConfig.trustedDirectories);
      if (pathTrusted) {
        logger.debug(`Tool ${request.toolName} auto-approved for trusted path: ${request.path}`);
        return { allowed: true, warnings };
      }
    }

    // 5. For strict mode, deny if not auto-approved
    if (!autoApproved) {
      // In subagent context, we allow read operations but log them
      if (request.permissionLevel === 'read') {
        return { allowed: true, warnings };
      }

      // For write/execute/network, check if path is in working directory
      if (request.path) {
        const inWorkingDir = request.path.startsWith(context.workingDirectory);
        if (inWorkingDir) {
          return { allowed: true, warnings };
        }
      }

      // Deny for operations outside working directory in non-autoApprove mode
      this.addAuditEntry({
        timestamp: Date.now(),
        agentId: context.agentId,
        agentName: context.agentName,
        action: 'permission_denied',
        details: {
          tool: request.toolName,
          permissionLevel: request.permissionLevel,
          path: request.path,
          command: request.command,
        },
      });

      return {
        allowed: false,
        reason: `Permission denied: ${request.permissionLevel} operation requires approval`,
        warnings,
      };
    }

    return { allowed: true, warnings };
  }

  /**
   * Record tool usage
   */
  recordToolUsage(context: SubagentExecutionContext, toolName: string): void {
    if (!context.toolsUsed.includes(toolName)) {
      context.toolsUsed.push(toolName);
    }

    this.addAuditEntry({
      timestamp: Date.now(),
      agentId: context.agentId,
      agentName: context.agentName,
      action: 'tool_execute',
      details: { tool: toolName },
    });
  }

  // --------------------------------------------------------------------------
  // Budget Checking
  // --------------------------------------------------------------------------

  /**
   * Check budget before execution
   */
  checkBudget(context: SubagentExecutionContext): PipelineCheckResult {
    const budgetService = getBudgetService();
    const status = budgetService.checkBudget();
    const warnings: string[] = [];

    // Check global budget
    if (status.alertLevel === BudgetAlertLevel.BLOCKED) {
      this.addAuditEntry({
        timestamp: Date.now(),
        agentId: context.agentId,
        agentName: context.agentName,
        action: 'budget_warning',
        details: {
          level: 'blocked',
          currentCost: status.currentCost,
          maxBudget: status.maxBudget,
        },
      });

      return {
        allowed: false,
        reason: status.message || 'Budget exceeded',
        warnings,
      };
    }

    if (status.alertLevel === BudgetAlertLevel.WARNING) {
      warnings.push(status.message || 'Budget warning: approaching limit');

      this.addAuditEntry({
        timestamp: Date.now(),
        agentId: context.agentId,
        agentName: context.agentName,
        action: 'budget_warning',
        details: {
          level: 'warning',
          currentCost: status.currentCost,
          maxBudget: status.maxBudget,
        },
      });
    }

    // Check subagent-specific budget if set
    if (context.maxBudget) {
      const subagentCost = this.calculateTotalCost(context.tokenUsage);
      if (subagentCost >= context.maxBudget) {
        return {
          allowed: false,
          reason: `Subagent budget exceeded: $${subagentCost.toFixed(2)} / $${context.maxBudget.toFixed(2)}`,
          warnings,
        };
      }

      const usageRatio = subagentCost / context.maxBudget;
      if (usageRatio >= 0.85) {
        warnings.push(`Subagent budget warning: ${(usageRatio * 100).toFixed(0)}% used`);
      }
    }

    return { allowed: true, warnings };
  }

  /**
   * Record token usage for a subagent
   */
  recordTokenUsage(context: SubagentExecutionContext, usage: TokenUsage): void {
    context.tokenUsage.push(usage);

    // Also record to global budget service
    const budgetService = getBudgetService();
    budgetService.recordUsage(usage);
  }

  /**
   * Get current budget status for a subagent
   */
  getBudgetStatus(context: SubagentExecutionContext): BudgetStatus & { subagentCost?: number } {
    const budgetService = getBudgetService();
    const globalStatus = budgetService.checkBudget();
    const subagentCost = this.calculateTotalCost(context.tokenUsage);

    return {
      ...globalStatus,
      subagentCost,
    };
  }

  /**
   * Calculate total cost from token usage
   */
  private calculateTotalCost(usages: TokenUsage[]): number {
    const budgetService = getBudgetService();
    return usages.reduce((sum, usage) => {
      return sum + budgetService.estimateCost(usage.inputTokens, usage.outputTokens, usage.model);
    }, 0);
  }

  // --------------------------------------------------------------------------
  // Audit Log
  // --------------------------------------------------------------------------

  /**
   * Add entry to audit log
   */
  private addAuditEntry(entry: SubagentAuditEntry): void {
    this.auditLog.push(entry);

    // Keep only last 1000 entries
    if (this.auditLog.length > 1000) {
      this.auditLog = this.auditLog.slice(-1000);
    }

    logger.debug(`Audit: ${entry.action} - ${entry.agentName}`, entry.details);
  }

  /**
   * Get audit log entries for an agent
   */
  getAuditLog(agentId?: string): SubagentAuditEntry[] {
    if (agentId) {
      return this.auditLog.filter((e) => e.agentId === agentId);
    }
    return [...this.auditLog];
  }

  /**
   * Get recent audit entries
   */
  getRecentAuditEntries(count: number = 50): SubagentAuditEntry[] {
    return this.auditLog.slice(-count);
  }

  /**
   * Clear audit log
   */
  clearAuditLog(): void {
    this.auditLog = [];
  }

  // --------------------------------------------------------------------------
  // Combined Pre-execution Check
  // --------------------------------------------------------------------------

  /**
   * Perform all pre-execution checks
   * Call this before each tool execution in a subagent
   */
  preExecutionCheck(
    context: SubagentExecutionContext,
    toolRequest: ToolExecutionRequest
  ): PipelineCheckResult {
    const allWarnings: string[] = [];

    // 1. Check budget
    const budgetResult = this.checkBudget(context);
    if (!budgetResult.allowed) {
      return budgetResult;
    }
    allWarnings.push(...budgetResult.warnings);

    // 2. Check permission
    const permissionResult = this.checkToolExecution(context, toolRequest);
    if (!permissionResult.allowed) {
      return permissionResult;
    }
    allWarnings.push(...permissionResult.warnings);

    return { allowed: true, warnings: allWarnings };
  }

  // --------------------------------------------------------------------------
  // Statistics
  // --------------------------------------------------------------------------

  /**
   * Get statistics about subagent executions
   */
  getStatistics(): {
    activeAgents: number;
    totalExecutions: number;
    totalCost: number;
    toolUsageCounts: Record<string, number>;
    errorCount: number;
  } {
    const toolUsageCounts: Record<string, number> = {};
    let totalCost = 0;
    let errorCount = 0;

    for (const entry of this.auditLog) {
      if (entry.action === 'tool_execute' && entry.details.tool) {
        const tool = entry.details.tool as string;
        toolUsageCounts[tool] = (toolUsageCounts[tool] || 0) + 1;
      }
      if (entry.cost) {
        totalCost += entry.cost;
      }
      if (entry.action === 'error') {
        errorCount++;
      }
    }

    return {
      activeAgents: this.activeContexts.size,
      totalExecutions: this.auditLog.filter((e) => e.action === 'complete').length,
      totalCost,
      toolUsageCounts,
      errorCount,
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let pipelineInstance: SubagentPipeline | null = null;

/**
 * Get the singleton SubagentPipeline instance
 */
export function getSubagentPipeline(): SubagentPipeline {
  if (!pipelineInstance) {
    pipelineInstance = new SubagentPipeline();
  }
  return pipelineInstance;
}

/**
 * Reset the pipeline (for testing)
 */
export function resetSubagentPipeline(): void {
  pipelineInstance = null;
}
