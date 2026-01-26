// ============================================================================
// ParallelAgentCoordinator - True parallel agent execution and coordination
// Enhancement 3: Multi-Agent Parallelism
// Refactored: Now supports Task DAG scheduler for advanced dependency handling
// ============================================================================

import { EventEmitter } from 'events';
import type { ModelConfig } from '../../shared/types';
import type { Tool, ToolContext } from '../tools/toolRegistry';
import { getSubagentExecutor, type SubagentResult } from './subagentExecutor';
import { createLogger } from '../services/infra/logger';
import { TaskDAG, getDAGScheduler, type SchedulerResult } from '../scheduler';

const logger = createLogger('ParallelAgentCoordinator');

// ============================================================================
// Types
// ============================================================================

export interface AgentTask {
  id: string;
  role: string;
  task: string;
  systemPrompt?: string;
  tools: string[];
  maxIterations?: number;
  dependsOn?: string[]; // IDs of tasks this task depends on
  priority?: number; // Higher = more priority
}

export interface AgentTaskResult extends SubagentResult {
  taskId: string;
  role: string;
  startTime: number;
  endTime: number;
  duration: number;
}

export interface ParallelExecutionResult {
  success: boolean;
  results: AgentTaskResult[];
  totalDuration: number;
  parallelism: number; // How many tasks ran in parallel
  errors: Array<{ taskId: string; error: string }>;
}

export interface SharedContext {
  findings: Map<string, unknown>;
  files: Map<string, string>;
  decisions: Map<string, string>;
  errors: string[];
}

export type CoordinatorEventType =
  | 'task:start'
  | 'task:complete'
  | 'task:error'
  | 'discovery'
  | 'all:complete';

export interface CoordinatorEvent {
  type: CoordinatorEventType;
  taskId?: string;
  data?: unknown;
}

export interface CoordinatorConfig {
  maxParallelTasks: number;
  taskTimeout: number;
  enableSharedContext: boolean;
  aggregateResults: boolean;
}

const DEFAULT_CONFIG: CoordinatorConfig = {
  maxParallelTasks: 4,
  taskTimeout: 120000, // 2 minutes
  enableSharedContext: true,
  aggregateResults: true,
};

// ============================================================================
// ParallelAgentCoordinator
// ============================================================================

let coordinatorInstance: ParallelAgentCoordinator | null = null;

export class ParallelAgentCoordinator extends EventEmitter {
  private config: CoordinatorConfig;
  private runningTasks: Map<string, Promise<AgentTaskResult>> = new Map();
  private completedTasks: Map<string, AgentTaskResult> = new Map();
  private sharedContext: SharedContext;
  private modelConfig?: ModelConfig;
  private toolRegistry?: Map<string, Tool>;
  private toolContext?: ToolContext;

  constructor(config: Partial<CoordinatorConfig> = {}) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.sharedContext = {
      findings: new Map(),
      files: new Map(),
      decisions: new Map(),
      errors: [],
    };
  }

  /**
   * Initialize coordinator with execution context
   */
  initialize(context: {
    modelConfig: ModelConfig;
    toolRegistry: Map<string, Tool>;
    toolContext: ToolContext;
  }): void {
    this.modelConfig = context.modelConfig;
    this.toolRegistry = context.toolRegistry;
    this.toolContext = context.toolContext;
  }

  /**
   * Execute multiple agent tasks in parallel with dependency resolution
   */
  async executeParallel(tasks: AgentTask[]): Promise<ParallelExecutionResult> {
    if (!this.modelConfig || !this.toolRegistry || !this.toolContext) {
      throw new Error('Coordinator not initialized. Call initialize() first.');
    }

    const startTime = Date.now();
    const results: AgentTaskResult[] = [];
    const errors: Array<{ taskId: string; error: string }> = [];
    let maxConcurrent = 0;

    // Sort tasks by priority and dependencies
    const sortedTasks = this.sortTasksByDependencies(tasks);

    // Execute tasks respecting dependencies
    for (const taskGroup of sortedTasks) {
      // Track concurrent execution
      maxConcurrent = Math.max(maxConcurrent, taskGroup.length);

      // Execute group in parallel
      const groupResults = await this.executeTaskGroup(taskGroup);

      for (const result of groupResults) {
        if (result.success) {
          results.push(result);
          this.completedTasks.set(result.taskId, result);

          // Share discoveries with other agents
          if (this.config.enableSharedContext) {
            this.updateSharedContext(result);
          }
        } else {
          errors.push({ taskId: result.taskId, error: result.error || 'Unknown error' });
        }
      }
    }

    const totalDuration = Date.now() - startTime;

    // Aggregate results if enabled
    const aggregatedResults = this.config.aggregateResults
      ? this.aggregateResults(results)
      : results;

    this.emit('all:complete', { results: aggregatedResults, errors });

    return {
      success: errors.length === 0,
      results: aggregatedResults,
      totalDuration,
      parallelism: maxConcurrent,
      errors,
    };
  }

  /**
   * Sort tasks into groups based on dependencies
   * Tasks in the same group can run in parallel
   */
  private sortTasksByDependencies(tasks: AgentTask[]): AgentTask[][] {
    const groups: AgentTask[][] = [];
    const completed = new Set<string>();
    const remaining = [...tasks];

    while (remaining.length > 0) {
      // Find tasks with all dependencies satisfied
      const ready = remaining.filter(task =>
        !task.dependsOn || task.dependsOn.every(dep => completed.has(dep))
      );

      if (ready.length === 0) {
        // Circular dependency or missing dependency
        logger.warn(' Circular or missing dependency detected');
        // Add remaining tasks as a single group
        groups.push(remaining);
        break;
      }

      // Sort by priority within the group
      ready.sort((a, b) => (b.priority || 0) - (a.priority || 0));

      // Limit parallel tasks
      const group = ready.slice(0, this.config.maxParallelTasks);
      groups.push(group);

      // Mark as completed and remove from remaining
      for (const task of group) {
        completed.add(task.id);
        const idx = remaining.indexOf(task);
        if (idx !== -1) remaining.splice(idx, 1);
      }
    }

    return groups;
  }

  /**
   * Execute a group of tasks in parallel
   */
  private async executeTaskGroup(tasks: AgentTask[]): Promise<AgentTaskResult[]> {
    const promises = tasks.map(task => this.executeTask(task));
    return Promise.all(promises);
  }

  /**
   * Execute a single task with timeout
   */
  private async executeTask(task: AgentTask): Promise<AgentTaskResult> {
    const startTime = Date.now();

    this.emit('task:start', { taskId: task.id, role: task.role });

    try {
      // Create timeout promise
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Task timeout')), this.config.taskTimeout);
      });

      // Execute task
      const executor = getSubagentExecutor();

      // Inject shared context into system prompt if available
      let enhancedPrompt = task.systemPrompt || '';
      if (this.config.enableSharedContext && this.sharedContext.findings.size > 0) {
        enhancedPrompt += this.formatSharedContextForPrompt();
      }

      const executionPromise = executor.execute(
        task.task,
        {
          name: task.role,
          systemPrompt: enhancedPrompt,
          availableTools: task.tools,
          maxIterations: task.maxIterations || 20,
        },
        {
          modelConfig: this.modelConfig!,
          toolRegistry: this.toolRegistry!,
          toolContext: this.toolContext!,
        }
      );

      // Race execution against timeout
      const result = await Promise.race([executionPromise, timeoutPromise]);

      const endTime = Date.now();

      const taskResult: AgentTaskResult = {
        ...result,
        taskId: task.id,
        role: task.role,
        startTime,
        endTime,
        duration: endTime - startTime,
      };

      this.emit('task:complete', { taskId: task.id, result: taskResult });

      return taskResult;
    } catch (error) {
      const endTime = Date.now();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';

      this.emit('task:error', { taskId: task.id, error: errorMessage });

      return {
        success: false,
        output: '',
        error: errorMessage,
        toolsUsed: [],
        iterations: 0,
        taskId: task.id,
        role: task.role,
        startTime,
        endTime,
        duration: endTime - startTime,
      };
    }
  }

  /**
   * Update shared context from task result
   */
  private updateSharedContext(result: AgentTaskResult): void {
    // Extract findings from output (simple heuristic)
    const output = result.output.toLowerCase();

    // Look for file mentions
    const fileMatches = result.output.match(/(?:file|path)[:\s]+([^\s\n]+)/gi);
    if (fileMatches) {
      for (const match of fileMatches) {
        const path = match.replace(/(?:file|path)[:\s]+/i, '').trim();
        this.sharedContext.files.set(path, result.role);
      }
    }

    // Look for key findings
    if (output.includes('found') || output.includes('discovered') || output.includes('issue')) {
      this.sharedContext.findings.set(
        `${result.role}_${result.taskId}`,
        result.output.substring(0, 500)
      );
      this.emit('discovery', { taskId: result.taskId, finding: result.output.substring(0, 200) });
    }

    // Track errors
    if (!result.success && result.error) {
      this.sharedContext.errors.push(`[${result.role}] ${result.error}`);
    }
  }

  /**
   * Format shared context for injection into prompts
   */
  private formatSharedContextForPrompt(): string {
    const parts: string[] = [];

    if (this.sharedContext.findings.size > 0) {
      parts.push('\n## Shared Discoveries from Other Agents:');
      for (const [key, value] of this.sharedContext.findings) {
        parts.push(`- [${key}]: ${value}`);
      }
    }

    if (this.sharedContext.files.size > 0) {
      parts.push('\n## Files Identified by Team:');
      for (const [path, agent] of this.sharedContext.files) {
        parts.push(`- ${path} (by ${agent})`);
      }
    }

    if (this.sharedContext.errors.length > 0) {
      parts.push('\n## Issues Encountered:');
      for (const error of this.sharedContext.errors) {
        parts.push(`- ${error}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Aggregate results from multiple agents
   * Deduplicates and prioritizes findings
   */
  private aggregateResults(results: AgentTaskResult[]): AgentTaskResult[] {
    // Simple aggregation - could be enhanced with smarter deduplication
    return results.sort((a, b) => {
      // Sort by success first, then by role priority
      if (a.success !== b.success) return a.success ? -1 : 1;
      // Architect > Coder > Reviewer > Tester > Others
      const rolePriority: Record<string, number> = {
        architect: 5,
        coder: 4,
        reviewer: 3,
        tester: 2,
        debugger: 2,
        documenter: 1,
      };
      return (rolePriority[b.role] || 0) - (rolePriority[a.role] || 0);
    });
  }

  /**
   * Share a finding with all agents
   */
  shareDiscovery(key: string, value: unknown): void {
    this.sharedContext.findings.set(key, value);
    this.emit('discovery', { key, value });
  }

  /**
   * Get shared context
   */
  getSharedContext(): SharedContext {
    return this.sharedContext;
  }

  /**
   * Clear shared context
   */
  clearSharedContext(): void {
    this.sharedContext = {
      findings: new Map(),
      files: new Map(),
      decisions: new Map(),
      errors: [],
    };
  }

  /**
   * Get running task status
   */
  getRunningTasks(): string[] {
    return Array.from(this.runningTasks.keys());
  }

  /**
   * Get completed task results
   */
  getCompletedTasks(): AgentTaskResult[] {
    return Array.from(this.completedTasks.values());
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<CoordinatorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): CoordinatorConfig {
    return { ...this.config };
  }

  /**
   * Reset coordinator state
   */
  reset(): void {
    this.runningTasks.clear();
    this.completedTasks.clear();
    this.clearSharedContext();
    this.removeAllListeners();
  }

  // ============================================================================
  // DAG-based Execution (New in Session 4)
  // ============================================================================

  /**
   * Execute tasks using the new DAG scheduler
   * Provides better dependency handling and parallel scheduling
   */
  async executeWithDAG(tasks: AgentTask[]): Promise<ParallelExecutionResult> {
    if (!this.modelConfig || !this.toolRegistry || !this.toolContext) {
      throw new Error('Coordinator not initialized. Call initialize() first.');
    }

    // Create DAG from tasks
    const dag = new TaskDAG(
      `parallel_${Date.now()}`,
      'Parallel Agent Execution',
      {
        maxParallelism: this.config.maxParallelTasks,
        defaultTimeout: this.config.taskTimeout,
        enableOutputPassing: this.config.enableSharedContext,
        enableSharedContext: this.config.enableSharedContext,
        failureStrategy: 'continue',
      }
    );

    // Add tasks to DAG
    for (const task of tasks) {
      dag.addAgentTask(
        task.id,
        {
          role: task.role,
          prompt: task.task,
          systemPrompt: task.systemPrompt,
          tools: task.tools,
          maxIterations: task.maxIterations,
        },
        {
          name: task.role,
          dependencies: task.dependsOn,
          priority: task.priority === undefined ? 'normal' :
            task.priority >= 3 ? 'critical' :
            task.priority >= 2 ? 'high' :
            task.priority >= 1 ? 'normal' : 'low',
        }
      );
    }

    // Validate DAG
    const validation = dag.validate();
    if (!validation.valid) {
      logger.error('DAG validation failed', { errors: validation.errors });
      throw new Error(`Invalid DAG: ${validation.errors.join(', ')}`);
    }

    // Get scheduler and execute
    const scheduler = getDAGScheduler();
    const result = await scheduler.execute(dag, {
      modelConfig: this.modelConfig,
      toolRegistry: this.toolRegistry,
      toolContext: this.toolContext,
      workingDirectory: process.cwd(),
    });

    // Convert scheduler result to coordinator result format
    return this.convertSchedulerResult(result);
  }

  /**
   * Convert DAG scheduler result to coordinator result format
   */
  private convertSchedulerResult(result: SchedulerResult): ParallelExecutionResult {
    const dagTasks = result.dag.getAllTasks();
    const results: AgentTaskResult[] = [];
    const errors: Array<{ taskId: string; error: string }> = [];

    for (const task of dagTasks) {
      const taskResult: AgentTaskResult = {
        success: task.status === 'completed',
        output: task.output?.text || '',
        error: task.failure?.message,
        toolsUsed: task.output?.toolsUsed || [],
        iterations: task.output?.iterations || 0,
        taskId: task.id,
        role: task.config.type === 'agent' ? (task.config as { role: string }).role : task.name,
        startTime: task.metadata.startedAt || 0,
        endTime: task.metadata.completedAt || 0,
        duration: task.metadata.duration || 0,
      };

      if (taskResult.success) {
        results.push(taskResult);
        this.completedTasks.set(task.id, taskResult);

        // Update shared context
        if (this.config.enableSharedContext) {
          this.updateSharedContext(taskResult);
        }
      } else if (task.failure) {
        errors.push({ taskId: task.id, error: task.failure.message });
      }
    }

    // Aggregate results
    const aggregatedResults = this.config.aggregateResults
      ? this.aggregateResults(results)
      : results;

    return {
      success: result.success,
      results: aggregatedResults,
      totalDuration: result.totalDuration,
      parallelism: result.maxParallelism,
      errors,
    };
  }
}

/**
 * Get singleton instance
 */
export function getParallelAgentCoordinator(): ParallelAgentCoordinator {
  if (!coordinatorInstance) {
    coordinatorInstance = new ParallelAgentCoordinator();
  }
  return coordinatorInstance;
}

/**
 * Initialize with custom config
 */
export function initParallelAgentCoordinator(
  config: Partial<CoordinatorConfig>
): ParallelAgentCoordinator {
  coordinatorInstance = new ParallelAgentCoordinator(config);
  return coordinatorInstance;
}
