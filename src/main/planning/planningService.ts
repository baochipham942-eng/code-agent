// ============================================================================
// PlanningService - Main service for persistent planning system
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { PlanManager } from './planManager';
import { HooksEngine } from './hooksEngine';
import { ErrorTracker } from './errorTracker';
import { FindingsManager } from './findingsManager';
import { CONFIG_DIR_NEW } from '../config/configPaths';
import type {
  HookContext,
  PlanningConfig,
  PlanningHooksConfig,
  PlanningRulesConfig,
} from './types';
import type { HookPoint } from './hooks/types';
import type { HookManager } from '../hooks/hookManager';

// ----------------------------------------------------------------------------
// PlanningService
// ----------------------------------------------------------------------------

export interface PlanningServiceOptions {
  hooks?: Partial<PlanningHooksConfig>;
  rules?: Partial<PlanningRulesConfig>;
  /** HookManager for bridging planning hooks to user hook system */
  hookManager?: HookManager;
  /** Session ID for bridge events */
  sessionId?: string;
}

export class PlanningService {
  private _planManager: PlanManager;
  private _hooksEngine: HooksEngine;
  private _errorTracker: ErrorTracker;
  private _findingsManager: FindingsManager;
  private _initialized: boolean = false;

  constructor(
    private config: PlanningConfig,
    private options?: PlanningServiceOptions
  ) {
    this._planManager = new PlanManager(config);
    this._errorTracker = new ErrorTracker(config);
    this._findingsManager = new FindingsManager(config);

    const bridgeCallback = options?.hookManager
      ? this.createBridgeCallback(options.hookManager, options.sessionId || config.sessionId)
      : undefined;

    this._hooksEngine = new HooksEngine(
      this._planManager,
      this._errorTracker,
      this._findingsManager,
      {
        ...options,
        onBridgeEvent: bridgeCallback,
      }
    );
  }

  // ==========================================================================
  // Bridge to User Hook System
  // ==========================================================================

  /**
   * Set bridge hookManager for late binding (when hookManager is not available at construction).
   * Fire-and-forget: bridge errors are silently caught to never block planning.
   */
  setBridgeHookManager(hookManager: HookManager, sessionId?: string): void {
    const callback = this.createBridgeCallback(hookManager, sessionId || this.config.sessionId);
    this._hooksEngine.setBridgeCallback(callback);
  }

  /**
   * Create a bridge callback that maps planning HookPoints to HookManager triggers.
   */
  private createBridgeCallback(
    hookManager: HookManager,
    sessionId: string
  ): (point: HookPoint, ctx: HookContext) => void {
    return (point: HookPoint, ctx: HookContext) => {
      if (point === 'pre_tool_use' && ctx.toolName) {
        hookManager.triggerPreToolUse(
          ctx.toolName,
          JSON.stringify(ctx.toolParams || {}),
          sessionId
        ).catch(() => {});
      } else if (point === 'post_tool_use' && ctx.toolName) {
        const toolOutput = ctx.toolResult?.success
          ? (ctx.toolResult.output || '')
          : (ctx.toolResult?.error || '');
        if (ctx.toolResult?.success) {
          hookManager.triggerPostToolUse(
            ctx.toolName,
            JSON.stringify(ctx.toolParams || {}),
            toolOutput,
            sessionId
          ).catch(() => {});
        } else {
          hookManager.triggerPostToolUseFailure(
            ctx.toolName,
            JSON.stringify(ctx.toolParams || {}),
            toolOutput,
            sessionId
          ).catch(() => {});
        }
      } else if (point === 'on_stop') {
        hookManager.triggerStop(undefined, sessionId).catch(() => {});
      }
      // on_error and session_start are not bridged (planning-internal concerns)
    };
  }

  // ==========================================================================
  // Getters for sub-modules
  // ==========================================================================

  get plan(): PlanManager {
    return this._planManager;
  }

  get hooks(): HooksEngine {
    return this._hooksEngine;
  }

  get errors(): ErrorTracker {
    return this._errorTracker;
  }

  get findings(): FindingsManager {
    return this._findingsManager;
  }

  // ==========================================================================
  // Lifecycle Methods
  // ==========================================================================

  /**
   * Initialize the planning service
   * Creates the plan directory structure
   */
  async initialize(): Promise<void> {
    if (this._initialized) return;

    const planDir = this.getPlanDirectory();
    await fs.mkdir(planDir, { recursive: true });

    this._initialized = true;
  }

  /**
   * Check if service is initialized
   */
  isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * Get the plan directory path
   */
  getPlanDirectory(): string {
    return path.join(
      this.config.workingDirectory,
      CONFIG_DIR_NEW,
      'plans',
      this.config.sessionId
    );
  }

  /**
   * Get all file paths managed by this service
   */
  getFilePaths(): {
    planFile: string;
    errorsFile: string;
    findingsFile: string;
  } {
    const dir = this.getPlanDirectory();
    return {
      planFile: path.join(dir, 'task_plan.md'),
      errorsFile: path.join(dir, 'errors.md'),
      findingsFile: path.join(dir, 'findings.md'),
    };
  }

  // ==========================================================================
  // Convenience Methods
  // ==========================================================================

  /**
   * Quick check if there's an active plan
   */
  async hasActivePlan(): Promise<boolean> {
    const plan = await this._planManager.read();
    return plan !== null && !this._planManager.isComplete();
  }

  /**
   * Get a summary of current state (for context injection)
   */
  async getStateSummary(): Promise<string> {
    let summary = '';

    // Plan summary
    const plan = await this._planManager.read();
    if (plan) {
      summary += `<plan-state>\n`;
      summary += `Plan: ${plan.title}\n`;
      summary += `Progress: ${plan.metadata.completedSteps}/${plan.metadata.totalSteps}\n`;

      const current = this._planManager.getCurrentTask();
      if (current) {
        summary += `Current: ${current.step.content}\n`;
      }
      summary += `</plan-state>\n\n`;
    }

    // Findings summary
    const findingsSummary = await this._findingsManager.getSummary(2);
    if (findingsSummary) {
      summary += findingsSummary + '\n\n';
    }

    // Recent errors
    const recentErrors = await this._errorTracker.getRecentErrors(undefined, 3);
    if (recentErrors.length > 0) {
      summary += `<recent-errors>\n`;
      for (const err of recentErrors) {
        summary += `- ${err.toolName}: ${err.message} (${err.count}x)\n`;
      }
      summary += `</recent-errors>\n`;
    }

    return summary;
  }

  // ==========================================================================
  // Cleanup Methods
  // ==========================================================================

  /**
   * Clean up old plan directories
   */
  async cleanup(olderThanDays: number = 7): Promise<number> {
    const plansBaseDir = path.join(
      this.config.workingDirectory,
      CONFIG_DIR_NEW,
      'plans'
    );

    let cleanedCount = 0;

    try {
      const entries = await fs.readdir(plansBaseDir, { withFileTypes: true });
      const now = Date.now();
      const maxAge = olderThanDays * 24 * 60 * 60 * 1000;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === this.config.sessionId) continue; // Don't delete current

        const dirPath = path.join(plansBaseDir, entry.name);

        try {
          const stat = await fs.stat(dirPath);
          if (now - stat.mtimeMs > maxAge) {
            await fs.rm(dirPath, { recursive: true });
            cleanedCount++;
          }
        } catch {
          // Skip if can't stat
        }
      }
    } catch {
      // Plans directory doesn't exist
    }

    return cleanedCount;
  }

  /**
   * Delete current plan directory
   */
  async deleteCurrent(): Promise<void> {
    const planDir = this.getPlanDirectory();
    try {
      await fs.rm(planDir, { recursive: true });
    } catch {
      // Directory doesn't exist
    }
  }
}

// ----------------------------------------------------------------------------
// Factory function
// ----------------------------------------------------------------------------

export function createPlanningService(
  workingDirectory: string,
  sessionId: string,
  options?: PlanningServiceOptions
): PlanningService {
  return new PlanningService(
    {
      workingDirectory,
      sessionId,
      autoCreatePlan: true,
      syncToTodoWrite: true,
    },
    options
  );
}
