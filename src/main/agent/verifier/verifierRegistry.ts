// ============================================================================
// Verifier Registry - 中央验证器注册表
// ============================================================================
// 可插拔的验证器系统，每种任务类型有确定性检查器。
// 参考：Anthropic "Building a C compiler with parallel Claudes" — 验证器质量
// 决定了自主代理的可靠性。
// ============================================================================

import { createLogger } from '../../services/infra/logger';
import type { TaskAnalysis } from '../hybrid/taskRouter';

const logger = createLogger('VerifierRegistry');

// ============================================================================
// Types
// ============================================================================

export type TaskType = 'code' | 'ppt' | 'search' | 'review' | 'data' | 'document' | 'image' | 'video' | 'generic';

export interface VerificationCheck {
  name: string;
  passed: boolean;
  score: number; // 0-1
  message: string;
  metadata?: Record<string, unknown>;
}

export interface VerificationResult {
  passed: boolean;
  score: number; // 0-1 weighted average
  checks: VerificationCheck[];
  suggestions?: string[]; // feedback for retry
  taskType: TaskType;
  durationMs: number;
}

export interface VerificationContext {
  /** Task description / user prompt */
  taskDescription: string;
  /** Task analysis from router */
  taskAnalysis?: TaskAnalysis;
  /** Agent output text */
  agentOutput: string;
  /** Tool calls made during execution */
  toolCalls?: Array<{
    name: string;
    args?: Record<string, unknown>;
    result?: { success: boolean; output?: string; error?: string };
  }>;
  /** Working directory */
  workingDirectory: string;
  /** Files created or modified */
  modifiedFiles?: string[];
  /** Session ID */
  sessionId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface TaskVerifier {
  id: string;
  taskType: TaskType;
  /** Check if this verifier can handle the given task */
  canVerify(taskAnalysis: TaskAnalysis): boolean;
  /** Run verification checks */
  verify(context: VerificationContext): Promise<VerificationResult>;
}

// ============================================================================
// Registry
// ============================================================================

class VerifierRegistryImpl {
  private verifiers: Map<string, TaskVerifier> = new Map();

  /**
   * Register a verifier
   */
  register(verifier: TaskVerifier): void {
    if (this.verifiers.has(verifier.id)) {
      logger.warn(`Verifier ${verifier.id} already registered, overwriting`);
    }
    this.verifiers.set(verifier.id, verifier);
    logger.info(`Registered verifier: ${verifier.id} (type=${verifier.taskType})`);
  }

  /**
   * Get a specific verifier by ID
   */
  getVerifier(id: string): TaskVerifier | undefined {
    return this.verifiers.get(id);
  }

  /**
   * Find the best verifier for a task analysis
   */
  findVerifier(taskAnalysis: TaskAnalysis): TaskVerifier | undefined {
    // 1. Find specific verifiers that can handle this task
    for (const verifier of this.verifiers.values()) {
      if (verifier.taskType !== 'generic' && verifier.canVerify(taskAnalysis)) {
        return verifier;
      }
    }

    // 2. Fall back to generic verifier
    for (const verifier of this.verifiers.values()) {
      if (verifier.taskType === 'generic') {
        return verifier;
      }
    }

    return undefined;
  }

  /**
   * Verify a task result using the appropriate verifier
   */
  async verifyTask(
    context: VerificationContext,
    taskAnalysis?: TaskAnalysis
  ): Promise<VerificationResult> {
    const startTime = Date.now();

    // Determine task analysis if not provided
    const analysis = taskAnalysis ?? {
      complexity: 'moderate' as const,
      taskType: 'code',
      involvesFiles: true,
      involvesNetwork: false,
      involvesExecution: false,
      estimatedSteps: 5,
      parallelism: 1,
      specializations: [],
      confidence: 0.5,
    };

    const verifier = this.findVerifier(analysis);

    if (!verifier) {
      logger.warn('No verifier found, returning pass-through result');
      return {
        passed: true,
        score: 0.5,
        checks: [{
          name: 'no_verifier',
          passed: true,
          score: 0.5,
          message: 'No verifier available for this task type',
        }],
        taskType: 'generic',
        durationMs: Date.now() - startTime,
      };
    }

    logger.info(`Running verifier: ${verifier.id} for task type: ${analysis.taskType}`);

    try {
      const result = await verifier.verify(context);
      result.durationMs = Date.now() - startTime;

      logger.info(`Verification complete: passed=${result.passed} score=${result.score.toFixed(2)}`, {
        checks: result.checks.map(c => `${c.name}:${c.passed ? 'PASS' : 'FAIL'}`),
      });

      return result;
    } catch (error) {
      logger.error(`Verifier ${verifier.id} threw error:`, error);
      return {
        passed: false,
        score: 0,
        checks: [{
          name: 'verifier_error',
          passed: false,
          score: 0,
          message: `Verifier error: ${error instanceof Error ? error.message : String(error)}`,
        }],
        taskType: verifier.taskType,
        durationMs: Date.now() - startTime,
      };
    }
  }

  /**
   * Get all registered verifier IDs
   */
  getRegisteredIds(): string[] {
    return Array.from(this.verifiers.keys());
  }

  /**
   * Reset registry (for testing)
   */
  reset(): void {
    this.verifiers.clear();
  }
}

// ============================================================================
// Singleton
// ============================================================================

let instance: VerifierRegistryImpl | null = null;

export function getVerifierRegistry(): VerifierRegistryImpl {
  if (!instance) {
    instance = new VerifierRegistryImpl();
  }
  return instance;
}

export type { VerifierRegistryImpl };
