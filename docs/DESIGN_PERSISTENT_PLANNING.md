# 持久化规划系统设计方案

> 版本: 1.0
> 日期: 2026-01-14
> 基于: Planning-with-Files (Manus 模式) 的增强设计

---

## 一、设计目标

将 Manus 风格的持久化规划能力集成到 Code Agent 中，解决当前系统的以下问题：

| 当前问题 | 解决方案 |
|---------|---------|
| `todo_write` 只在内存中，会话结束丢失 | 任务计划持久化到文件 |
| 长对话后容易遗忘原始目标 | Hooks 机制在关键时刻重读计划 |
| 错误不被追踪，重复犯错 | 错误日志持久化 |
| 无法验证任务是否真正完成 | 完成验证 Hook |

---

## 二、系统架构

### 2.1 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Enhanced Planning System                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    PlanningService (新增)                         │   │
│  │                                                                   │   │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │   │
│  │  │ PlanManager │  │ HooksEngine │  │ErrorTracker │              │   │
│  │  │             │  │             │  │             │              │   │
│  │  │ - create    │  │ - pre_tool  │  │ - log_error │              │   │
│  │  │ - update    │  │ - post_tool │  │ - get_fails │              │   │
│  │  │ - read      │  │ - on_stop   │  │ - clear     │              │   │
│  │  │ - complete  │  │ - session   │  │             │              │   │
│  │  └─────────────┘  └─────────────┘  └─────────────┘              │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│                              ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     AgentLoop (增强)                              │   │
│  │                                                                   │   │
│  │  run() {                                                         │   │
│  │    await hooks.onSessionStart()     // 新增: 会话开始钩子         │   │
│  │    while (running) {                                             │   │
│  │      await hooks.preToolUse()       // 新增: 工具调用前钩子       │   │
│  │      result = await executeTool()                                │   │
│  │      await hooks.postToolUse()      // 新增: 工具调用后钩子       │   │
│  │    }                                                             │   │
│  │    await hooks.onStop()             // 新增: 停止前验证钩子       │   │
│  │  }                                                               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                              │                                          │
│                              ▼                                          │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                    Planning Files (持久化)                        │   │
│  │                                                                   │   │
│  │  .code-agent/                                                    │   │
│  │  └── plans/                                                      │   │
│  │      └── {session-id}/                                           │   │
│  │          ├── task_plan.md      # 任务计划和进度                   │   │
│  │          ├── findings.md       # 发现和研究笔记                   │   │
│  │          ├── errors.md         # 错误追踪                        │   │
│  │          └── deliverable.md    # 最终交付物                       │   │
│  │                                                                   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 核心概念

```
┌─────────────────────────────────────────────────────────────────┐
│                   Context Engineering 原则                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│   Context Window (RAM)          File System (Disk)              │
│   ┌─────────────────┐           ┌─────────────────┐             │
│   │  有限 (~128K)    │  ◄────►  │  无限            │             │
│   │  易失            │   同步    │  持久            │             │
│   │  昂贵            │           │  廉价            │             │
│   └─────────────────┘           └─────────────────┘             │
│                                                                  │
│   策略: 把重要信息写入文件，需要时再读回来                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 三、核心模块设计

### 3.1 PlanningService

```typescript
// src/main/planning/PlanningService.ts

import { PlanManager } from './PlanManager';
import { HooksEngine } from './HooksEngine';
import { ErrorTracker } from './ErrorTracker';
import { FindingsManager } from './FindingsManager';

export interface PlanningConfig {
  workingDirectory: string;
  sessionId: string;
  autoCreatePlan: boolean;        // 是否自动创建计划文件
  syncToTodoWrite: boolean;       // 是否同步到内存 TodoWrite
}

export class PlanningService {
  private planManager: PlanManager;
  private hooksEngine: HooksEngine;
  private errorTracker: ErrorTracker;
  private findingsManager: FindingsManager;
  private config: PlanningConfig;

  constructor(config: PlanningConfig) {
    this.config = config;
    this.planManager = new PlanManager(config);
    this.hooksEngine = new HooksEngine(this);
    this.errorTracker = new ErrorTracker(config);
    this.findingsManager = new FindingsManager(config);
  }

  // 获取各个子模块
  get plan(): PlanManager { return this.planManager; }
  get hooks(): HooksEngine { return this.hooksEngine; }
  get errors(): ErrorTracker { return this.errorTracker; }
  get findings(): FindingsManager { return this.findingsManager; }

  // 获取计划目录路径
  getPlanDirectory(): string {
    return path.join(
      this.config.workingDirectory,
      '.code-agent',
      'plans',
      this.config.sessionId
    );
  }

  // 初始化计划目录
  async initialize(): Promise<void> {
    const planDir = this.getPlanDirectory();
    await fs.mkdir(planDir, { recursive: true });
  }

  // 清理旧计划
  async cleanup(olderThanDays: number = 7): Promise<void> {
    // 清理超过指定天数的计划目录
  }
}
```

### 3.2 PlanManager - 计划管理器

```typescript
// src/main/planning/PlanManager.ts

export interface TaskPhase {
  id: string;
  title: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked';
  steps: TaskStep[];
  notes?: string;
}

export interface TaskStep {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
  activeForm?: string;  // 兼容现有 TodoWrite
}

export interface TaskPlan {
  id: string;
  title: string;
  objective: string;
  phases: TaskPhase[];
  createdAt: number;
  updatedAt: number;
  metadata: {
    totalSteps: number;
    completedSteps: number;
    blockedSteps: number;
  };
}

export class PlanManager {
  private planPath: string;
  private currentPlan: TaskPlan | null = null;

  constructor(config: PlanningConfig) {
    this.planPath = path.join(
      config.workingDirectory,
      '.code-agent',
      'plans',
      config.sessionId,
      'task_plan.md'
    );
  }

  // =========================================================================
  // 核心方法
  // =========================================================================

  /**
   * 创建新计划
   */
  async create(plan: Omit<TaskPlan, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>): Promise<TaskPlan> {
    const newPlan: TaskPlan = {
      ...plan,
      id: this.generateId(),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      metadata: this.calculateMetadata(plan.phases),
    };

    this.currentPlan = newPlan;
    await this.savePlanToFile();
    return newPlan;
  }

  /**
   * 读取计划 (关键方法 - Hooks 会频繁调用)
   */
  async read(): Promise<TaskPlan | null> {
    if (!await this.exists()) {
      return null;
    }

    const content = await fs.readFile(this.planPath, 'utf-8');
    this.currentPlan = this.parseMarkdown(content);
    return this.currentPlan;
  }

  /**
   * 更新步骤状态
   */
  async updateStepStatus(
    phaseId: string,
    stepId: string,
    status: TaskStep['status']
  ): Promise<void> {
    if (!this.currentPlan) await this.read();
    if (!this.currentPlan) throw new Error('No plan exists');

    const phase = this.currentPlan.phases.find(p => p.id === phaseId);
    if (!phase) throw new Error(`Phase ${phaseId} not found`);

    const step = phase.steps.find(s => s.id === stepId);
    if (!step) throw new Error(`Step ${stepId} not found`);

    step.status = status;

    // 自动更新阶段状态
    this.autoUpdatePhaseStatus(phase);

    this.currentPlan.updatedAt = Date.now();
    this.currentPlan.metadata = this.calculateMetadata(this.currentPlan.phases);

    await this.savePlanToFile();
  }

  /**
   * 更新阶段状态
   */
  async updatePhaseStatus(phaseId: string, status: TaskPhase['status']): Promise<void> {
    if (!this.currentPlan) await this.read();
    if (!this.currentPlan) throw new Error('No plan exists');

    const phase = this.currentPlan.phases.find(p => p.id === phaseId);
    if (!phase) throw new Error(`Phase ${phaseId} not found`);

    phase.status = status;
    this.currentPlan.updatedAt = Date.now();

    await this.savePlanToFile();
  }

  /**
   * 添加步骤到阶段
   */
  async addStep(phaseId: string, step: Omit<TaskStep, 'id'>): Promise<TaskStep> {
    if (!this.currentPlan) await this.read();
    if (!this.currentPlan) throw new Error('No plan exists');

    const phase = this.currentPlan.phases.find(p => p.id === phaseId);
    if (!phase) throw new Error(`Phase ${phaseId} not found`);

    const newStep: TaskStep = {
      ...step,
      id: this.generateId(),
    };

    phase.steps.push(newStep);
    this.currentPlan.updatedAt = Date.now();
    this.currentPlan.metadata = this.calculateMetadata(this.currentPlan.phases);

    await this.savePlanToFile();
    return newStep;
  }

  /**
   * 检查计划是否完成
   */
  isComplete(): boolean {
    if (!this.currentPlan) return false;
    return this.currentPlan.phases.every(phase => phase.status === 'completed');
  }

  /**
   * 获取当前进行中的阶段和步骤
   */
  getCurrentTask(): { phase: TaskPhase; step: TaskStep } | null {
    if (!this.currentPlan) return null;

    for (const phase of this.currentPlan.phases) {
      if (phase.status === 'in_progress') {
        const step = phase.steps.find(s => s.status === 'in_progress');
        if (step) {
          return { phase, step };
        }
      }
    }
    return null;
  }

  /**
   * 获取下一个待办任务
   */
  getNextPendingTask(): { phase: TaskPhase; step: TaskStep } | null {
    if (!this.currentPlan) return null;

    for (const phase of this.currentPlan.phases) {
      if (phase.status === 'pending' || phase.status === 'in_progress') {
        const step = phase.steps.find(s => s.status === 'pending');
        if (step) {
          return { phase, step };
        }
      }
    }
    return null;
  }

  // =========================================================================
  // 文件操作
  // =========================================================================

  private async savePlanToFile(): Promise<void> {
    if (!this.currentPlan) return;

    const markdown = this.toMarkdown(this.currentPlan);
    await fs.mkdir(path.dirname(this.planPath), { recursive: true });
    await fs.writeFile(this.planPath, markdown, 'utf-8');
  }

  private async exists(): Promise<boolean> {
    try {
      await fs.access(this.planPath);
      return true;
    } catch {
      return false;
    }
  }

  // =========================================================================
  // Markdown 转换
  // =========================================================================

  /**
   * 将计划转换为 Markdown 格式
   */
  private toMarkdown(plan: TaskPlan): string {
    const statusIcon = {
      pending: '○',
      in_progress: '◐',
      completed: '●',
      blocked: '✖',
      skipped: '⊘',
    };

    let md = `# ${plan.title}\n\n`;
    md += `> **Objective:** ${plan.objective}\n\n`;
    md += `> **Progress:** ${plan.metadata.completedSteps}/${plan.metadata.totalSteps} steps completed\n\n`;
    md += `---\n\n`;

    for (const phase of plan.phases) {
      md += `## ${statusIcon[phase.status]} Phase: ${phase.title}\n\n`;

      if (phase.notes) {
        md += `> ${phase.notes}\n\n`;
      }

      for (const step of phase.steps) {
        const icon = statusIcon[step.status];
        md += `- [${step.status === 'completed' ? 'x' : ' '}] ${icon} ${step.content}\n`;
      }

      md += '\n';
    }

    md += `---\n`;
    md += `*Last updated: ${new Date(plan.updatedAt).toISOString()}*\n`;

    return md;
  }

  /**
   * 从 Markdown 解析计划
   */
  private parseMarkdown(content: string): TaskPlan {
    // 实现 Markdown 解析逻辑
    // 支持读取上述格式的 Markdown 文件
    // ...
  }

  // =========================================================================
  // 辅助方法
  // =========================================================================

  private calculateMetadata(phases: TaskPhase[]): TaskPlan['metadata'] {
    let totalSteps = 0;
    let completedSteps = 0;
    let blockedSteps = 0;

    for (const phase of phases) {
      totalSteps += phase.steps.length;
      completedSteps += phase.steps.filter(s => s.status === 'completed').length;
      blockedSteps += phase.steps.filter(s => s.status === 'skipped').length;
    }

    return { totalSteps, completedSteps, blockedSteps };
  }

  private autoUpdatePhaseStatus(phase: TaskPhase): void {
    const allCompleted = phase.steps.every(s =>
      s.status === 'completed' || s.status === 'skipped'
    );
    const anyInProgress = phase.steps.some(s => s.status === 'in_progress');
    const anyBlocked = phase.steps.some(s => s.status === 'skipped');

    if (allCompleted) {
      phase.status = 'completed';
    } else if (anyBlocked && !anyInProgress) {
      phase.status = 'blocked';
    } else if (anyInProgress) {
      phase.status = 'in_progress';
    }
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
```

### 3.3 HooksEngine - 钩子引擎

```typescript
// src/main/planning/HooksEngine.ts

export type HookType =
  | 'session_start'   // 会话开始
  | 'pre_tool_use'    // 工具调用前
  | 'post_tool_use'   // 工具调用后
  | 'on_stop'         // Agent 停止前
  | 'on_error';       // 发生错误时

export interface HookContext {
  toolName?: string;
  toolParams?: Record<string, unknown>;
  toolResult?: ToolExecutionResult;
  error?: Error;
  actionCount?: number;  // 当前动作计数
}

export interface HookResult {
  shouldContinue: boolean;     // 是否继续执行
  injectContext?: string;      // 注入到 context 的内容
  notification?: string;       // 给用户的通知
}

export class HooksEngine {
  private planningService: PlanningService;
  private actionCount: number = 0;
  private readonly ACTION_THRESHOLD = 2;  // 2-Action Rule

  constructor(planningService: PlanningService) {
    this.planningService = planningService;
  }

  // =========================================================================
  // Hook 执行入口
  // =========================================================================

  /**
   * 会话开始时执行
   */
  async onSessionStart(): Promise<HookResult> {
    this.actionCount = 0;

    // 检查是否存在未完成的计划
    const existingPlan = await this.planningService.plan.read();

    if (existingPlan && !this.planningService.plan.isComplete()) {
      const current = this.planningService.plan.getCurrentTask();
      return {
        shouldContinue: true,
        injectContext: this.formatPlanReminder(existingPlan, current),
        notification: `Found existing plan: ${existingPlan.title}`,
      };
    }

    return { shouldContinue: true };
  }

  /**
   * 工具调用前执行 (Pre-Tool Hook)
   *
   * 关键功能:
   * 1. 在重要决策前重读计划，防止目标漂移
   * 2. 检查错误历史，避免重复失败
   */
  async preToolUse(context: HookContext): Promise<HookResult> {
    const { toolName } = context;

    // 只在关键工具前触发
    const criticalTools = ['write_file', 'edit_file', 'bash'];
    if (!criticalTools.includes(toolName || '')) {
      return { shouldContinue: true };
    }

    // 重读计划
    const plan = await this.planningService.plan.read();
    if (!plan) {
      return { shouldContinue: true };
    }

    // 检查错误历史
    const recentErrors = await this.planningService.errors.getRecentErrors(toolName);

    let injectContext = '';

    // 如果有相关错误历史，提醒 Agent
    if (recentErrors.length > 0) {
      injectContext += `\n\n<error-history>\n`;
      injectContext += `Previous failures with ${toolName}:\n`;
      for (const err of recentErrors) {
        injectContext += `- ${err.message} (${err.count} times)\n`;
      }
      injectContext += `Avoid repeating these mistakes.\n`;
      injectContext += `</error-history>\n`;
    }

    // 添加当前任务提醒
    const currentTask = this.planningService.plan.getCurrentTask();
    if (currentTask) {
      injectContext += `\n<current-task>\n`;
      injectContext += `Phase: ${currentTask.phase.title}\n`;
      injectContext += `Step: ${currentTask.step.content}\n`;
      injectContext += `</current-task>\n`;
    }

    return {
      shouldContinue: true,
      injectContext: injectContext || undefined,
    };
  }

  /**
   * 工具调用后执行 (Post-Tool Hook)
   *
   * 关键功能:
   * 1. 2-Action Rule: 每 2 个操作提醒保存发现
   * 2. 自动更新进度
   * 3. 记录错误
   */
  async postToolUse(context: HookContext): Promise<HookResult> {
    const { toolName, toolResult } = context;

    // 更新动作计数
    this.actionCount++;

    // 记录错误
    if (toolResult && !toolResult.success && toolResult.error) {
      await this.planningService.errors.log({
        toolName: toolName || 'unknown',
        message: toolResult.error,
        params: context.toolParams,
        timestamp: Date.now(),
      });
    }

    // 2-Action Rule: 每 2 个操作提醒
    if (this.actionCount >= this.ACTION_THRESHOLD) {
      this.actionCount = 0;  // 重置计数

      const viewTools = ['read_file', 'glob', 'grep', 'list_directory', 'web_fetch'];
      if (viewTools.includes(toolName || '')) {
        return {
          shouldContinue: true,
          injectContext: `<reminder>\n` +
            `You've performed ${this.ACTION_THRESHOLD} view operations. ` +
            `Consider saving important findings to findings.md before continuing.\n` +
            `</reminder>`,
        };
      }
    }

    // 写入操作后提醒更新计划
    const writeTools = ['write_file', 'edit_file'];
    if (writeTools.includes(toolName || '') && toolResult?.success) {
      return {
        shouldContinue: true,
        injectContext: `<reminder>\n` +
          `File operation completed. Consider updating task_plan.md status if a step was completed.\n` +
          `</reminder>`,
      };
    }

    return { shouldContinue: true };
  }

  /**
   * Agent 停止前执行 (Stop Hook)
   *
   * 关键功能:
   * 1. 验证所有阶段是否完成
   * 2. 检查是否有遗漏任务
   */
  async onStop(): Promise<HookResult> {
    const plan = await this.planningService.plan.read();

    if (!plan) {
      return { shouldContinue: true };
    }

    // 检查是否所有任务完成
    if (!this.planningService.plan.isComplete()) {
      const incomplete = this.getIncompleteItems(plan);

      return {
        shouldContinue: false,  // 阻止停止
        injectContext: `<completion-check>\n` +
          `WARNING: Plan is not complete!\n\n` +
          `Incomplete items:\n${incomplete}\n\n` +
          `Please complete all tasks or explicitly mark them as skipped before stopping.\n` +
          `</completion-check>`,
        notification: 'Plan incomplete - verification required',
      };
    }

    // 计划完成，允许停止
    return {
      shouldContinue: true,
      notification: `Plan completed: ${plan.metadata.completedSteps}/${plan.metadata.totalSteps} steps`,
    };
  }

  /**
   * 错误发生时执行
   */
  async onError(context: HookContext): Promise<HookResult> {
    const { error, toolName } = context;

    // 记录错误
    await this.planningService.errors.log({
      toolName: toolName || 'unknown',
      message: error?.message || 'Unknown error',
      stack: error?.stack,
      timestamp: Date.now(),
    });

    // 检查 3-Strike Rule
    const errorCount = await this.planningService.errors.getErrorCount(
      toolName || 'unknown',
      error?.message || ''
    );

    if (errorCount >= 3) {
      return {
        shouldContinue: true,
        injectContext: `<three-strike-warning>\n` +
          `This error has occurred ${errorCount} times!\n` +
          `You must try a DIFFERENT approach. Do not repeat the same action.\n` +
          `Consider:\n` +
          `1. Checking error history in errors.md\n` +
          `2. Re-reading the task_plan.md for alternative approaches\n` +
          `3. Asking the user for guidance\n` +
          `</three-strike-warning>`,
      };
    }

    return { shouldContinue: true };
  }

  // =========================================================================
  // 辅助方法
  // =========================================================================

  private formatPlanReminder(plan: TaskPlan, current: { phase: TaskPhase; step: TaskStep } | null): string {
    let reminder = `<existing-plan>\n`;
    reminder += `Plan: ${plan.title}\n`;
    reminder += `Objective: ${plan.objective}\n`;
    reminder += `Progress: ${plan.metadata.completedSteps}/${plan.metadata.totalSteps}\n\n`;

    if (current) {
      reminder += `Current task:\n`;
      reminder += `- Phase: ${current.phase.title}\n`;
      reminder += `- Step: ${current.step.content}\n`;
    }

    reminder += `\nPlease continue from where you left off.\n`;
    reminder += `</existing-plan>`;

    return reminder;
  }

  private getIncompleteItems(plan: TaskPlan): string {
    const items: string[] = [];

    for (const phase of plan.phases) {
      if (phase.status !== 'completed') {
        items.push(`Phase: ${phase.title}`);
        for (const step of phase.steps) {
          if (step.status !== 'completed' && step.status !== 'skipped') {
            items.push(`  - ${step.content}`);
          }
        }
      }
    }

    return items.join('\n');
  }
}
```

### 3.4 ErrorTracker - 错误追踪器

```typescript
// src/main/planning/ErrorTracker.ts

export interface ErrorRecord {
  id: string;
  toolName: string;
  message: string;
  params?: Record<string, unknown>;
  stack?: string;
  timestamp: number;
  count: number;  // 相同错误的出现次数
}

export class ErrorTracker {
  private errorsPath: string;
  private errors: Map<string, ErrorRecord> = new Map();

  constructor(config: PlanningConfig) {
    this.errorsPath = path.join(
      config.workingDirectory,
      '.code-agent',
      'plans',
      config.sessionId,
      'errors.md'
    );
  }

  /**
   * 记录错误
   */
  async log(error: Omit<ErrorRecord, 'id' | 'count'>): Promise<void> {
    const key = this.getErrorKey(error.toolName, error.message);

    const existing = this.errors.get(key);
    if (existing) {
      existing.count++;
      existing.timestamp = error.timestamp;
    } else {
      this.errors.set(key, {
        ...error,
        id: this.generateId(),
        count: 1,
      });
    }

    await this.saveToFile();
  }

  /**
   * 获取指定工具的最近错误
   */
  async getRecentErrors(toolName?: string, limit: number = 5): Promise<ErrorRecord[]> {
    await this.loadFromFile();

    let errors = Array.from(this.errors.values());

    if (toolName) {
      errors = errors.filter(e => e.toolName === toolName);
    }

    return errors
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit);
  }

  /**
   * 获取特定错误的出现次数 (用于 3-Strike Rule)
   */
  async getErrorCount(toolName: string, message: string): Promise<number> {
    const key = this.getErrorKey(toolName, message);
    const record = this.errors.get(key);
    return record?.count || 0;
  }

  /**
   * 清除错误记录
   */
  async clear(): Promise<void> {
    this.errors.clear();
    await this.saveToFile();
  }

  // =========================================================================
  // 文件操作
  // =========================================================================

  private async saveToFile(): Promise<void> {
    let md = `# Error Log\n\n`;
    md += `> This file tracks errors to avoid repeating the same mistakes.\n\n`;

    const sortedErrors = Array.from(this.errors.values())
      .sort((a, b) => b.timestamp - a.timestamp);

    for (const error of sortedErrors) {
      md += `## ${error.toolName} - ${new Date(error.timestamp).toISOString()}\n\n`;
      md += `**Count:** ${error.count} times\n\n`;
      md += `**Message:** ${error.message}\n\n`;
      if (error.params) {
        md += `**Params:**\n\`\`\`json\n${JSON.stringify(error.params, null, 2)}\n\`\`\`\n\n`;
      }
      md += `---\n\n`;
    }

    await fs.mkdir(path.dirname(this.errorsPath), { recursive: true });
    await fs.writeFile(this.errorsPath, md, 'utf-8');
  }

  private async loadFromFile(): Promise<void> {
    try {
      const content = await fs.readFile(this.errorsPath, 'utf-8');
      // 解析 Markdown 恢复错误记录
      // ...
    } catch {
      // 文件不存在，使用空记录
    }
  }

  private getErrorKey(toolName: string, message: string): string {
    // 提取错误消息的关键部分作为 key
    const normalizedMessage = message.replace(/\d+/g, 'N').substring(0, 100);
    return `${toolName}:${normalizedMessage}`;
  }

  private generateId(): string {
    return `err-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
```

### 3.5 FindingsManager - 发现管理器

```typescript
// src/main/planning/FindingsManager.ts

export interface Finding {
  id: string;
  category: 'code' | 'architecture' | 'dependency' | 'issue' | 'insight';
  title: string;
  content: string;
  source?: string;  // 来源文件或 URL
  timestamp: number;
}

export class FindingsManager {
  private findingsPath: string;
  private findings: Finding[] = [];

  constructor(config: PlanningConfig) {
    this.findingsPath = path.join(
      config.workingDirectory,
      '.code-agent',
      'plans',
      config.sessionId,
      'findings.md'
    );
  }

  /**
   * 添加发现
   */
  async add(finding: Omit<Finding, 'id' | 'timestamp'>): Promise<Finding> {
    const newFinding: Finding = {
      ...finding,
      id: this.generateId(),
      timestamp: Date.now(),
    };

    this.findings.push(newFinding);
    await this.saveToFile();

    return newFinding;
  }

  /**
   * 获取所有发现
   */
  async getAll(): Promise<Finding[]> {
    await this.loadFromFile();
    return [...this.findings];
  }

  /**
   * 按类别获取发现
   */
  async getByCategory(category: Finding['category']): Promise<Finding[]> {
    await this.loadFromFile();
    return this.findings.filter(f => f.category === category);
  }

  /**
   * 生成发现摘要 (用于注入 context)
   */
  async getSummary(): Promise<string> {
    await this.loadFromFile();

    if (this.findings.length === 0) {
      return '';
    }

    let summary = '<findings-summary>\n';
    summary += `Total findings: ${this.findings.length}\n\n`;

    const byCategory = this.groupByCategory();
    for (const [category, items] of Object.entries(byCategory)) {
      summary += `**${category}:**\n`;
      for (const item of items.slice(0, 3)) {  // 每类最多 3 条
        summary += `- ${item.title}\n`;
      }
      summary += '\n';
    }

    summary += '</findings-summary>';
    return summary;
  }

  // =========================================================================
  // 文件操作
  // =========================================================================

  private async saveToFile(): Promise<void> {
    let md = `# Findings & Notes\n\n`;
    md += `> Research findings and important discoveries.\n\n`;

    const byCategory = this.groupByCategory();

    for (const [category, items] of Object.entries(byCategory)) {
      md += `## ${this.capitalize(category)}\n\n`;

      for (const item of items) {
        md += `### ${item.title}\n\n`;
        md += `${item.content}\n\n`;
        if (item.source) {
          md += `*Source: ${item.source}*\n\n`;
        }
      }
    }

    await fs.mkdir(path.dirname(this.findingsPath), { recursive: true });
    await fs.writeFile(this.findingsPath, md, 'utf-8');
  }

  private async loadFromFile(): Promise<void> {
    try {
      const content = await fs.readFile(this.findingsPath, 'utf-8');
      // 解析 Markdown 恢复发现记录
      // ...
    } catch {
      // 文件不存在
    }
  }

  private groupByCategory(): Record<string, Finding[]> {
    const grouped: Record<string, Finding[]> = {};
    for (const finding of this.findings) {
      if (!grouped[finding.category]) {
        grouped[finding.category] = [];
      }
      grouped[finding.category].push(finding);
    }
    return grouped;
  }

  private capitalize(str: string): string {
    return str.charAt(0).toUpperCase() + str.slice(1);
  }

  private generateId(): string {
    return `find-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
```

---

## 四、AgentLoop 集成

### 4.1 增强后的 AgentLoop

```typescript
// src/main/agent/AgentLoop.ts (修改)

import { PlanningService } from '../planning/PlanningService';

export class AgentLoop {
  // ... 现有属性 ...
  private planningService?: PlanningService;

  constructor(config: AgentLoopConfig) {
    // ... 现有初始化 ...

    // 初始化 Planning Service (可选)
    if (config.enablePlanning) {
      this.planningService = new PlanningService({
        workingDirectory: config.workingDirectory,
        sessionId: config.sessionId,
        autoCreatePlan: true,
        syncToTodoWrite: true,
      });
    }
  }

  async run(userMessage: string): Promise<void> {
    // ========== 新增: Session Start Hook ==========
    if (this.planningService) {
      const startResult = await this.planningService.hooks.onSessionStart();
      if (startResult.injectContext) {
        // 注入已有计划信息到 context
        this.injectToContext(startResult.injectContext);
      }
    }

    let iterations = 0;

    while (!this.isCancelled && iterations < this.maxIterations) {
      iterations++;

      const response = await this.inference();

      if (response.type === 'text' && response.content) {
        // ========== 新增: Stop Hook ==========
        if (this.planningService) {
          const stopResult = await this.planningService.hooks.onStop();
          if (!stopResult.shouldContinue) {
            // 计划未完成，注入警告并继续
            this.injectToContext(stopResult.injectContext || '');
            continue;
          }
        }

        const assistantMessage = this.createMessage(response.content);
        this.messages.push(assistantMessage);
        this.onEvent({ type: 'message', data: assistantMessage });
        break;
      }

      if (response.type === 'tool_use' && response.toolCalls) {
        // ... 创建 assistant message ...

        // 执行工具 (带 Hooks)
        const toolResults = await this.executeToolsWithHooks(response.toolCalls);

        // ... 后续处理 ...
      }
    }
  }

  /**
   * 带 Hooks 的工具执行
   */
  private async executeToolsWithHooks(toolCalls: ToolCall[]): Promise<ToolResult[]> {
    const results: ToolResult[] = [];

    for (const toolCall of toolCalls) {
      if (this.isCancelled) break;

      // ========== 新增: Pre-Tool Hook ==========
      if (this.planningService) {
        const preResult = await this.planningService.hooks.preToolUse({
          toolName: toolCall.name,
          toolParams: toolCall.arguments,
        });

        if (preResult.injectContext) {
          this.injectToContext(preResult.injectContext);
        }
      }

      this.onEvent({ type: 'tool_call_start', data: toolCall });

      const startTime = Date.now();

      try {
        const result = await this.toolExecutor.execute(
          toolCall.name,
          toolCall.arguments,
          { generation: this.generation }
        );

        const toolResult: ToolResult = {
          toolCallId: toolCall.id,
          success: result.success,
          output: result.output,
          error: result.error,
          duration: Date.now() - startTime,
        };

        results.push(toolResult);

        // ========== 新增: Post-Tool Hook ==========
        if (this.planningService) {
          const postResult = await this.planningService.hooks.postToolUse({
            toolName: toolCall.name,
            toolParams: toolCall.arguments,
            toolResult: result,
          });

          if (postResult.injectContext) {
            this.injectToContext(postResult.injectContext);
          }
        }

        this.onEvent({ type: 'tool_call_end', data: toolResult });

      } catch (error) {
        // ========== 新增: Error Hook ==========
        if (this.planningService) {
          await this.planningService.hooks.onError({
            toolName: toolCall.name,
            error: error as Error,
          });
        }

        // ... 错误处理 ...
      }
    }

    return results;
  }

  /**
   * 注入内容到 context (通过系统消息)
   */
  private injectToContext(content: string): void {
    this.messages.push({
      id: this.generateId(),
      role: 'system',
      content: content,
      timestamp: Date.now(),
    });
  }
}
```

---

## 五、增强版 TodoWrite 工具

### 5.1 新版 TodoWrite (支持持久化)

```typescript
// src/main/tools/gen3/todoWrite.ts (修改)

import { PlanManager, TaskPlan, TaskStep } from '../../planning/PlanManager';

export interface TodoWriteParams {
  todos: Array<{
    content: string;
    status: TodoStatus;
    activeForm: string;
    phaseId?: string;  // 新增: 关联到计划阶段
  }>;
  persist?: boolean;  // 新增: 是否持久化到文件
  planTitle?: string; // 新增: 计划标题 (首次创建时)
}

export const todoWriteTool: Tool = {
  name: 'todo_write',
  description: 'Create or update a todo list to track task progress. ' +
    'Set persist=true to save to task_plan.md file for long-term tracking.',
  generations: ['gen3', 'gen4'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Array of todo items',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Task description' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed'],
            },
            activeForm: { type: 'string', description: 'Present continuous form' },
            phaseId: { type: 'string', description: 'Phase ID for persistent plans' },
          },
          required: ['content', 'status', 'activeForm'],
        },
      },
      persist: {
        type: 'boolean',
        description: 'Save to task_plan.md file (default: false)',
        default: false,
      },
      planTitle: {
        type: 'string',
        description: 'Title for the plan (required when persist=true for new plans)',
      },
    },
    required: ['todos'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const { todos, persist, planTitle } = params as TodoWriteParams;

    // 验证 todos
    if (!Array.isArray(todos)) {
      return { success: false, error: 'todos must be an array' };
    }

    // 更新内存中的 todos (保持向后兼容)
    currentTodos = todos.map((t) => ({
      content: t.content,
      status: t.status,
      activeForm: t.activeForm,
    }));

    if (context.emit) {
      context.emit('todo_update', currentTodos);
    }

    // ========== 新增: 持久化到文件 ==========
    if (persist && context.planningService) {
      try {
        const existingPlan = await context.planningService.plan.read();

        if (existingPlan) {
          // 更新现有计划
          for (const todo of todos) {
            if (todo.phaseId) {
              // 找到对应的步骤并更新
              // ...
            }
          }
        } else {
          // 创建新计划
          if (!planTitle) {
            return {
              success: false,
              error: 'planTitle is required when creating a new persistent plan',
            };
          }

          const plan = await context.planningService.plan.create({
            title: planTitle,
            objective: 'Task objectives extracted from todos',
            phases: [{
              id: 'main',
              title: 'Main Tasks',
              status: 'pending',
              steps: todos.map(t => ({
                id: `step-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                content: t.content,
                status: t.status === 'completed' ? 'completed' :
                        t.status === 'in_progress' ? 'in_progress' : 'pending',
                activeForm: t.activeForm,
              })),
            }],
          });

          return {
            success: true,
            output: `Plan created and saved to task_plan.md:\n` +
              `Title: ${plan.title}\n` +
              `Steps: ${plan.metadata.totalSteps}\n` +
              `Path: ${context.planningService.plan.planPath}`,
          };
        }
      } catch (error) {
        return {
          success: false,
          error: `Failed to persist plan: ${error instanceof Error ? error.message : 'Unknown error'}`,
        };
      }
    }

    // 格式化输出 (保持原有逻辑)
    const statusIcons = { pending: '○', in_progress: '◐', completed: '●' };
    const formatted = currentTodos
      .map((t) => `${statusIcons[t.status]} ${t.content}`)
      .join('\n');

    const completed = currentTodos.filter((t) => t.status === 'completed').length;
    const total = currentTodos.length;

    return {
      success: true,
      output: `Todo list updated (${completed}/${total} completed):\n${formatted}` +
        (persist ? '\n\n(Saved to task_plan.md)' : ''),
    };
  },
};
```

---

## 六、新增工具

### 6.1 plan_read - 读取计划

```typescript
// src/main/tools/gen3/planRead.ts

export const planReadTool: Tool = {
  name: 'plan_read',
  description: 'Read the current task plan from task_plan.md. ' +
    'Use this to review your progress and objectives.',
  generations: ['gen3', 'gen4'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      includeCompleted: {
        type: 'boolean',
        description: 'Include completed steps in output (default: false)',
        default: false,
      },
    },
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const { includeCompleted } = params;

    if (!context.planningService) {
      return {
        success: false,
        error: 'Planning service not available',
      };
    }

    const plan = await context.planningService.plan.read();

    if (!plan) {
      return {
        success: true,
        output: 'No plan exists. Use todo_write with persist=true to create one.',
      };
    }

    // 格式化输出
    let output = `# ${plan.title}\n\n`;
    output += `**Objective:** ${plan.objective}\n`;
    output += `**Progress:** ${plan.metadata.completedSteps}/${plan.metadata.totalSteps}\n\n`;

    for (const phase of plan.phases) {
      const icon = phase.status === 'completed' ? '●' :
                   phase.status === 'in_progress' ? '◐' : '○';
      output += `## ${icon} ${phase.title}\n\n`;

      for (const step of phase.steps) {
        if (!includeCompleted && step.status === 'completed') continue;

        const stepIcon = step.status === 'completed' ? '●' :
                        step.status === 'in_progress' ? '◐' : '○';
        output += `- ${stepIcon} ${step.content}\n`;
      }
      output += '\n';
    }

    return { success: true, output };
  },
};
```

### 6.2 findings_write - 写入发现

```typescript
// src/main/tools/gen3/findingsWrite.ts

export const findingsWriteTool: Tool = {
  name: 'findings_write',
  description: 'Save important findings and research notes to findings.md. ' +
    'Use this to persist discoveries that should not be lost.',
  generations: ['gen3', 'gen4'],
  requiresPermission: false,
  permissionLevel: 'read',
  inputSchema: {
    type: 'object',
    properties: {
      category: {
        type: 'string',
        enum: ['code', 'architecture', 'dependency', 'issue', 'insight'],
        description: 'Category of the finding',
      },
      title: {
        type: 'string',
        description: 'Brief title for the finding',
      },
      content: {
        type: 'string',
        description: 'Detailed content of the finding',
      },
      source: {
        type: 'string',
        description: 'Source file or URL (optional)',
      },
    },
    required: ['category', 'title', 'content'],
  },

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const { category, title, content, source } = params as {
      category: Finding['category'];
      title: string;
      content: string;
      source?: string;
    };

    if (!context.planningService) {
      return { success: false, error: 'Planning service not available' };
    }

    const finding = await context.planningService.findings.add({
      category,
      title,
      content,
      source,
    });

    return {
      success: true,
      output: `Finding saved to findings.md:\n` +
        `Category: ${category}\n` +
        `Title: ${title}\n` +
        `ID: ${finding.id}`,
    };
  },
};
```

---

## 七、目录结构

```
src/main/
├── planning/                    # 新增: 规划系统
│   ├── PlanningService.ts      # 主服务
│   ├── PlanManager.ts          # 计划管理
│   ├── HooksEngine.ts          # 钩子引擎
│   ├── ErrorTracker.ts         # 错误追踪
│   ├── FindingsManager.ts      # 发现管理
│   └── index.ts                # 导出
│
├── tools/
│   └── gen3/
│       ├── todoWrite.ts        # 增强 (支持持久化)
│       ├── planRead.ts         # 新增
│       ├── findingsWrite.ts    # 新增
│       └── ...
│
└── agent/
    └── AgentLoop.ts            # 修改 (集成 Hooks)
```

---

## 八、使用示例

### 8.1 创建持久化计划

```
用户: 帮我重构 UserService，添加缓存功能

Agent: 我来创建一个计划来追踪这个任务。

[调用 todo_write]
{
  "todos": [
    {"content": "分析现有 UserService 实现", "status": "pending", "activeForm": "分析中"},
    {"content": "设计缓存策略", "status": "pending", "activeForm": "设计中"},
    {"content": "实现缓存层", "status": "pending", "activeForm": "实现中"},
    {"content": "更新 UserService 使用缓存", "status": "pending", "activeForm": "更新中"},
    {"content": "编写测试", "status": "pending", "activeForm": "测试中"}
  ],
  "persist": true,
  "planTitle": "UserService 缓存重构"
}

输出: Plan created and saved to task_plan.md
```

### 8.2 生成的 task_plan.md

```markdown
# UserService 缓存重构

> **Objective:** Task objectives extracted from todos

> **Progress:** 0/5 steps completed

---

## ○ Phase: Main Tasks

- [ ] ○ 分析现有 UserService 实现
- [ ] ○ 设计缓存策略
- [ ] ○ 实现缓存层
- [ ] ○ 更新 UserService 使用缓存
- [ ] ○ 编写测试

---
*Last updated: 2026-01-14T10:30:00.000Z*
```

### 8.3 Hooks 触发示例

```
# Pre-Tool Hook 触发 (在调用 edit_file 前)

<current-task>
Phase: Main Tasks
Step: 实现缓存层
</current-task>

<error-history>
Previous failures with edit_file:
- File not found: src/cache/RedisCache.ts (2 times)
Avoid repeating these mistakes.
</error-history>
```

```
# Post-Tool Hook 触发 (2-Action Rule)

<reminder>
You've performed 2 view operations.
Consider saving important findings to findings.md before continuing.
</reminder>
```

```
# Stop Hook 触发 (计划未完成时)

<completion-check>
WARNING: Plan is not complete!

Incomplete items:
Phase: Main Tasks
  - 编写测试

Please complete all tasks or explicitly mark them as skipped before stopping.
</completion-check>
```

---

## 九、配置选项

```typescript
// src/shared/types.ts

export interface PlanningConfig {
  enabled: boolean;              // 是否启用规划系统
  autoCreatePlan: boolean;       // 是否自动创建计划
  syncToTodoWrite: boolean;      // 是否同步到内存 TodoWrite

  hooks: {
    preToolUse: boolean;         // 启用 Pre-Tool Hook
    postToolUse: boolean;        // 启用 Post-Tool Hook
    onStop: boolean;             // 启用 Stop Hook
  };

  rules: {
    actionThreshold: number;     // 2-Action Rule 的阈值 (默认 2)
    errorStrikeLimit: number;    // 3-Strike Rule 的阈值 (默认 3)
  };

  cleanup: {
    autoCleanup: boolean;        // 自动清理旧计划
    retentionDays: number;       // 保留天数 (默认 7)
  };
}
```

---

## 十、与现有系统的兼容性

| 组件 | 兼容策略 |
|-----|---------|
| `todo_write` | 完全向后兼容，`persist` 参数可选 |
| `AgentLoop` | 规划服务可选注入，不影响现有逻辑 |
| `ToolExecutor` | 无需修改 |
| 前端 UI | 可展示 task_plan.md 文件内容 |

---

## 十一、总结

本设计方案实现了 Manus 风格的持久化规划系统，主要特点:

1. **持久化计划**: task_plan.md, findings.md, errors.md
2. **Hooks 机制**: Pre-Tool, Post-Tool, Stop, Error
3. **规则引擎**: 2-Action Rule, 3-Strike Rule
4. **向后兼容**: 增强现有 todo_write，不破坏原有功能
5. **可配置**: 所有功能可通过配置开关

实现优先级建议:

1. **P0**: PlanManager + 增强 todo_write
2. **P1**: HooksEngine + AgentLoop 集成
3. **P2**: ErrorTracker + FindingsManager
4. **P3**: 前端可视化 + 清理机制
