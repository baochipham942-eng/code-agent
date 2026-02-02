// ============================================================================
// Feasibility Checker - 计划可行性检查
// ============================================================================
// 在执行计划前检查前置条件，确保计划可执行
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import { createLogger } from '../services/infra/logger';
import type { TaskPlan, TaskStep, TaskPhase } from './types';

const logger = createLogger('FeasibilityChecker');

/**
 * 前置条件类型
 */
export type PreconditionType =
  | 'file_exists'
  | 'file_not_exists'
  | 'directory_exists'
  | 'dependency_installed'
  | 'env_var_set'
  | 'tool_available'
  | 'permission_granted'
  | 'custom';

/**
 * 前置条件定义
 */
export interface Precondition {
  type: PreconditionType;
  description: string;
  target: string; // 目标路径、变量名、工具名等
  required: boolean; // 是否必须满足
  fallback?: string; // 不满足时的替代方案
}

/**
 * 后置条件定义
 */
export interface Postcondition {
  type: 'file_created' | 'file_modified' | 'test_passed' | 'service_running' | 'custom';
  description: string;
  target: string;
  validation?: (context: ValidationContext) => Promise<boolean>;
}

/**
 * 验证上下文
 */
export interface ValidationContext {
  workingDirectory: string;
  env: Record<string, string | undefined>;
  availableTools: string[];
}

/**
 * 可行性检查结果
 */
export interface FeasibilityCheckResult {
  feasible: boolean;
  score: number; // 0-100
  checks: FeasibilityCheck[];
  blockers: FeasibilityCheck[];
  warnings: FeasibilityCheck[];
  suggestions: string[];
}

/**
 * 单项检查结果
 */
export interface FeasibilityCheck {
  precondition: Precondition;
  passed: boolean;
  message: string;
  severity: 'blocker' | 'warning' | 'info';
}

/**
 * 增强的任务步骤（带前后置条件）
 */
export interface EnhancedTaskStep extends TaskStep {
  preconditions: Precondition[];
  postconditions: Postcondition[];
  affectedFiles: string[];
  requiredTools: string[];
}

/**
 * 增强的计划（带可行性信息）
 */
export interface EnhancedTaskPlan extends TaskPlan {
  feasibility?: FeasibilityCheckResult;
  constraints: PlanConstraints;
  checkpoints: Checkpoint[];
  snapshots: PlanSnapshot[];
}

/**
 * 计划约束
 */
export interface PlanConstraints {
  maxDuration?: number; // 最大执行时间（毫秒）
  maxIterations?: number; // 最大迭代次数
  requiredFiles?: string[]; // 必须存在的文件
  forbiddenOperations?: string[]; // 禁止的操作
}

/**
 * 检查点
 */
export interface Checkpoint {
  id: string;
  phaseId: string;
  stepId: string;
  description: string;
  validation: () => Promise<boolean>;
  createdAt: number;
}

/**
 * 计划快照
 */
export interface PlanSnapshot {
  id: string;
  planState: TaskPlan;
  fileStates: Map<string, string>; // 文件路径 -> 内容哈希
  createdAt: number;
  description: string;
}

/**
 * 可行性检查器
 */
export class FeasibilityChecker {
  private workingDirectory: string;
  private availableTools: string[];

  constructor(workingDirectory: string, availableTools: string[] = []) {
    this.workingDirectory = workingDirectory;
    this.availableTools = availableTools;
  }

  /**
   * 检查计划的可行性
   */
  async checkPlan(plan: TaskPlan): Promise<FeasibilityCheckResult> {
    const checks: FeasibilityCheck[] = [];
    const preconditions = this.extractPreconditions(plan);

    for (const precondition of preconditions) {
      const result = await this.checkPrecondition(precondition);
      checks.push(result);
    }

    const blockers = checks.filter((c) => !c.passed && c.severity === 'blocker');
    const warnings = checks.filter((c) => !c.passed && c.severity === 'warning');

    const passedCount = checks.filter((c) => c.passed).length;
    const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 100;

    const suggestions = this.generateSuggestions(blockers, warnings);

    return {
      feasible: blockers.length === 0,
      score,
      checks,
      blockers,
      warnings,
      suggestions,
    };
  }

  /**
   * 检查单个步骤的可行性
   */
  async checkStep(step: EnhancedTaskStep): Promise<FeasibilityCheckResult> {
    const checks: FeasibilityCheck[] = [];

    for (const precondition of step.preconditions) {
      const result = await this.checkPrecondition(precondition);
      checks.push(result);
    }

    const blockers = checks.filter((c) => !c.passed && c.severity === 'blocker');
    const warnings = checks.filter((c) => !c.passed && c.severity === 'warning');

    const passedCount = checks.filter((c) => c.passed).length;
    const score = checks.length > 0 ? Math.round((passedCount / checks.length) * 100) : 100;

    return {
      feasible: blockers.length === 0,
      score,
      checks,
      blockers,
      warnings,
      suggestions: this.generateSuggestions(blockers, warnings),
    };
  }

  /**
   * 检查单个前置条件
   */
  private async checkPrecondition(
    precondition: Precondition
  ): Promise<FeasibilityCheck> {
    let passed = false;
    let message = '';

    try {
      switch (precondition.type) {
        case 'file_exists':
          passed = await this.fileExists(precondition.target);
          message = passed
            ? `文件存在: ${precondition.target}`
            : `文件不存在: ${precondition.target}`;
          break;

        case 'file_not_exists':
          passed = !(await this.fileExists(precondition.target));
          message = passed
            ? `文件不存在（符合预期）: ${precondition.target}`
            : `文件已存在（可能冲突）: ${precondition.target}`;
          break;

        case 'directory_exists':
          passed = await this.directoryExists(precondition.target);
          message = passed
            ? `目录存在: ${precondition.target}`
            : `目录不存在: ${precondition.target}`;
          break;

        case 'dependency_installed':
          passed = await this.checkDependency(precondition.target);
          message = passed
            ? `依赖已安装: ${precondition.target}`
            : `依赖未安装: ${precondition.target}`;
          break;

        case 'env_var_set':
          passed = this.checkEnvVar(precondition.target);
          message = passed
            ? `环境变量已设置: ${precondition.target}`
            : `环境变量未设置: ${precondition.target}`;
          break;

        case 'tool_available':
          passed = this.checkToolAvailable(precondition.target);
          message = passed
            ? `工具可用: ${precondition.target}`
            : `工具不可用: ${precondition.target}`;
          break;

        case 'permission_granted':
          passed = await this.checkPermission(precondition.target);
          message = passed
            ? `权限已授予: ${precondition.target}`
            : `权限未授予: ${precondition.target}`;
          break;

        case 'custom':
          passed = true; // 自定义条件需要在运行时验证
          message = `自定义条件: ${precondition.description}`;
          break;

        default:
          message = `未知条件类型: ${precondition.type}`;
      }
    } catch (error) {
      passed = false;
      message = `检查失败: ${error instanceof Error ? error.message : '未知错误'}`;
    }

    return {
      precondition,
      passed,
      message,
      severity: precondition.required && !passed ? 'blocker' : 'warning',
    };
  }

  /**
   * 从计划中提取前置条件
   */
  private extractPreconditions(plan: TaskPlan): Precondition[] {
    const preconditions: Precondition[] = [];

    // 分析计划内容，提取潜在的前置条件
    for (const phase of plan.phases) {
      for (const step of phase.steps) {
        const extracted = this.extractPreconditionsFromStep(step.content);
        preconditions.push(...extracted);
      }
    }

    // 去重
    const uniquePreconditions = this.deduplicatePreconditions(preconditions);
    return uniquePreconditions;
  }

  /**
   * 从步骤内容提取前置条件
   */
  private extractPreconditionsFromStep(content: string): Precondition[] {
    const preconditions: Precondition[] = [];
    const lowerContent = content.toLowerCase();

    // 检测文件操作
    const filePatterns = [
      /修改\s*`?([^`\s]+\.[a-z]+)`?/gi,
      /编辑\s*`?([^`\s]+\.[a-z]+)`?/gi,
      /读取\s*`?([^`\s]+\.[a-z]+)`?/gi,
      /打开\s*`?([^`\s]+\.[a-z]+)`?/gi,
    ];

    for (const pattern of filePatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        preconditions.push({
          type: 'file_exists',
          description: `文件需要存在: ${match[1]}`,
          target: match[1],
          required: true,
        });
      }
    }

    // 检测依赖
    const dependencyPatterns = [
      /安装\s*`?([a-z0-9@/-]+)`?/gi,
      /使用\s*`?([a-z0-9@/-]+)`?\s*库/gi,
      /依赖\s*`?([a-z0-9@/-]+)`?/gi,
    ];

    for (const pattern of dependencyPatterns) {
      let match;
      while ((match = pattern.exec(content)) !== null) {
        preconditions.push({
          type: 'dependency_installed',
          description: `依赖需要安装: ${match[1]}`,
          target: match[1],
          required: false,
        });
      }
    }

    // 检测环境变量
    if (lowerContent.includes('环境变量') || lowerContent.includes('env')) {
      const envPattern = /\$?([A-Z_][A-Z0-9_]*)/g;
      let match;
      while ((match = envPattern.exec(content)) !== null) {
        if (match[1].length > 3) { // 排除太短的匹配
          preconditions.push({
            type: 'env_var_set',
            description: `环境变量需要设置: ${match[1]}`,
            target: match[1],
            required: false,
          });
        }
      }
    }

    return preconditions;
  }

  /**
   * 前置条件去重
   */
  private deduplicatePreconditions(preconditions: Precondition[]): Precondition[] {
    const seen = new Set<string>();
    return preconditions.filter((p) => {
      const key = `${p.type}:${p.target}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  /**
   * 生成建议
   */
  private generateSuggestions(
    blockers: FeasibilityCheck[],
    warnings: FeasibilityCheck[]
  ): string[] {
    const suggestions: string[] = [];

    for (const blocker of blockers) {
      switch (blocker.precondition.type) {
        case 'file_exists':
          suggestions.push(`创建文件: ${blocker.precondition.target}`);
          break;
        case 'dependency_installed':
          suggestions.push(`安装依赖: npm install ${blocker.precondition.target}`);
          break;
        case 'env_var_set':
          suggestions.push(`设置环境变量: export ${blocker.precondition.target}=<value>`);
          break;
        case 'tool_available':
          suggestions.push(`确保工具可用: ${blocker.precondition.target}`);
          break;
        default:
          if (blocker.precondition.fallback) {
            suggestions.push(`替代方案: ${blocker.precondition.fallback}`);
          }
      }
    }

    return suggestions;
  }

  // --------------------------------------------------------------------------
  // 检查方法
  // --------------------------------------------------------------------------

  private async fileExists(filePath: string): Promise<boolean> {
    try {
      const fullPath = path.isAbsolute(filePath)
        ? filePath
        : path.join(this.workingDirectory, filePath);
      await fs.access(fullPath);
      return true;
    } catch {
      return false;
    }
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const fullPath = path.isAbsolute(dirPath)
        ? dirPath
        : path.join(this.workingDirectory, dirPath);
      const stats = await fs.stat(fullPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  private async checkDependency(depName: string): Promise<boolean> {
    try {
      // 检查 node_modules
      const nodeModulesPath = path.join(
        this.workingDirectory,
        'node_modules',
        depName
      );
      await fs.access(nodeModulesPath);
      return true;
    } catch {
      return false;
    }
  }

  private checkEnvVar(varName: string): boolean {
    return process.env[varName] !== undefined;
  }

  private checkToolAvailable(toolName: string): boolean {
    return this.availableTools.includes(toolName);
  }

  private async checkPermission(target: string): Promise<boolean> {
    try {
      const fullPath = path.isAbsolute(target)
        ? target
        : path.join(this.workingDirectory, target);
      await fs.access(fullPath, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 更新可用工具列表
   */
  setAvailableTools(tools: string[]): void {
    this.availableTools = tools;
  }
}

// ----------------------------------------------------------------------------
// Factory Function
// ----------------------------------------------------------------------------

export function createFeasibilityChecker(
  workingDirectory: string,
  availableTools?: string[]
): FeasibilityChecker {
  return new FeasibilityChecker(workingDirectory, availableTools);
}
