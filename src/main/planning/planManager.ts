// ============================================================================
// PlanManager - Manages persistent task plans
// ============================================================================

import * as fs from 'fs/promises';
import * as path from 'path';
import type {
  TaskPlan,
  TaskPhase,
  TaskStep,
  TaskStepStatus,
  TaskPhaseStatus,
  TaskPlanMetadata,
  PlanningConfig,
} from './types';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('PlanManager');

// ----------------------------------------------------------------------------
// Status Icons
// ----------------------------------------------------------------------------

const STATUS_ICONS = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  blocked: '✖',
  skipped: '⊘',
} as const;

// ----------------------------------------------------------------------------
// PlanManager
// ----------------------------------------------------------------------------

export class PlanManager {
  private planPath: string;
  private currentPlan: TaskPlan | null = null;

  constructor(private config: PlanningConfig) {
    this.planPath = path.join(
      config.workingDirectory,
      '.code-agent',
      'plans',
      config.sessionId,
      'task_plan.md'
    );
  }

  // ==========================================================================
  // Public Getters
  // ==========================================================================

  getPlanPath(): string {
    return this.planPath;
  }

  getCurrentPlan(): TaskPlan | null {
    return this.currentPlan;
  }

  // ==========================================================================
  // Core Methods
  // ==========================================================================

  /**
   * Create a new plan
   */
  async create(
    plan: Omit<TaskPlan, 'id' | 'createdAt' | 'updatedAt' | 'metadata'>
  ): Promise<TaskPlan> {
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
   * Read plan from file
   */
  async read(): Promise<TaskPlan | null> {
    if (!(await this.exists())) {
      return null;
    }

    try {
      const content = await fs.readFile(this.planPath, 'utf-8');
      this.currentPlan = this.parseMarkdown(content);
      return this.currentPlan;
    } catch (error) {
      logger.error('Failed to read plan:', error);
      return null;
    }
  }

  /**
   * Check if plan file exists
   */
  async exists(): Promise<boolean> {
    try {
      await fs.access(this.planPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Update step status
   */
  async updateStepStatus(
    phaseId: string,
    stepId: string,
    status: TaskStepStatus
  ): Promise<void> {
    if (!this.currentPlan) await this.read();
    if (!this.currentPlan) throw new Error('No plan exists');

    const phase = this.currentPlan.phases.find((p) => p.id === phaseId);
    if (!phase) throw new Error(`Phase ${phaseId} not found`);

    const step = phase.steps.find((s) => s.id === stepId);
    if (!step) throw new Error(`Step ${stepId} not found`);

    step.status = status;
    this.autoUpdatePhaseStatus(phase);

    this.currentPlan.updatedAt = Date.now();
    this.currentPlan.metadata = this.calculateMetadata(this.currentPlan.phases);

    await this.savePlanToFile();
  }

  /**
   * Update phase status
   */
  async updatePhaseStatus(
    phaseId: string,
    status: TaskPhaseStatus
  ): Promise<void> {
    if (!this.currentPlan) await this.read();
    if (!this.currentPlan) throw new Error('No plan exists');

    const phase = this.currentPlan.phases.find((p) => p.id === phaseId);
    if (!phase) throw new Error(`Phase ${phaseId} not found`);

    phase.status = status;
    this.currentPlan.updatedAt = Date.now();

    await this.savePlanToFile();
  }

  /**
   * Add a step to a phase
   */
  async addStep(
    phaseId: string,
    step: Omit<TaskStep, 'id'>
  ): Promise<TaskStep> {
    if (!this.currentPlan) await this.read();
    if (!this.currentPlan) throw new Error('No plan exists');

    const phase = this.currentPlan.phases.find((p) => p.id === phaseId);
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
   * Add a new phase
   */
  async addPhase(
    phase: Omit<TaskPhase, 'id' | 'status'>
  ): Promise<TaskPhase> {
    if (!this.currentPlan) await this.read();
    if (!this.currentPlan) throw new Error('No plan exists');

    const newPhase: TaskPhase = {
      ...phase,
      id: this.generateId(),
      status: 'pending',
    };

    this.currentPlan.phases.push(newPhase);
    this.currentPlan.updatedAt = Date.now();
    this.currentPlan.metadata = this.calculateMetadata(this.currentPlan.phases);

    await this.savePlanToFile();
    return newPhase;
  }

  /**
   * Check if plan is complete
   */
  isComplete(): boolean {
    if (!this.currentPlan) return false;
    return this.currentPlan.phases.every(
      (phase) => phase.status === 'completed'
    );
  }

  /**
   * Get current in-progress task
   */
  getCurrentTask(): { phase: TaskPhase; step: TaskStep } | null {
    if (!this.currentPlan) return null;

    for (const phase of this.currentPlan.phases) {
      if (phase.status === 'in_progress') {
        const step = phase.steps.find((s) => s.status === 'in_progress');
        if (step) {
          return { phase, step };
        }
      }
    }
    return null;
  }

  /**
   * Get next pending task
   */
  getNextPendingTask(): { phase: TaskPhase; step: TaskStep } | null {
    if (!this.currentPlan) return null;

    for (const phase of this.currentPlan.phases) {
      if (phase.status === 'pending' || phase.status === 'in_progress') {
        const step = phase.steps.find((s) => s.status === 'pending');
        if (step) {
          return { phase, step };
        }
      }
    }
    return null;
  }

  /**
   * Get incomplete items summary
   */
  getIncompleteItems(): string {
    if (!this.currentPlan) return '';

    const items: string[] = [];

    for (const phase of this.currentPlan.phases) {
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

  // ==========================================================================
  // File Operations
  // ==========================================================================

  private async savePlanToFile(): Promise<void> {
    if (!this.currentPlan) return;

    const markdown = this.toMarkdown(this.currentPlan);
    await fs.mkdir(path.dirname(this.planPath), { recursive: true });
    await fs.writeFile(this.planPath, markdown, 'utf-8');
  }

  // ==========================================================================
  // Markdown Conversion
  // ==========================================================================

  /**
   * Convert plan to Markdown format
   */
  private toMarkdown(plan: TaskPlan): string {
    let md = `# ${plan.title}\n\n`;
    md += `> **Objective:** ${plan.objective}\n\n`;
    md += `> **Progress:** ${plan.metadata.completedSteps}/${plan.metadata.totalSteps} steps completed\n\n`;
    md += `---\n\n`;

    for (const phase of plan.phases) {
      const phaseIcon = STATUS_ICONS[phase.status];
      md += `## ${phaseIcon} Phase: ${phase.title}\n\n`;

      if (phase.notes) {
        md += `> ${phase.notes}\n\n`;
      }

      for (const step of phase.steps) {
        const checked = step.status === 'completed' ? 'x' : ' ';
        const stepIcon = STATUS_ICONS[step.status];
        md += `- [${checked}] ${stepIcon} ${step.content}\n`;
      }

      md += '\n';
    }

    md += `---\n\n`;
    md += `<!-- Plan ID: ${plan.id} -->\n`;
    md += `<!-- Created: ${new Date(plan.createdAt).toISOString()} -->\n`;
    md += `*Last updated: ${new Date(plan.updatedAt).toISOString()}*\n`;

    return md;
  }

  /**
   * Parse Markdown to plan object
   */
  private parseMarkdown(content: string): TaskPlan {
    const lines = content.split('\n');

    let title = '';
    let objective = '';
    let planId = this.generateId();
    let createdAt = Date.now();
    const phases: TaskPhase[] = [];
    let currentPhase: TaskPhase | null = null;

    for (const line of lines) {
      // Parse title
      if (line.startsWith('# ')) {
        title = line.slice(2).trim();
        continue;
      }

      // Parse objective
      if (line.includes('**Objective:**')) {
        const match = line.match(/\*\*Objective:\*\*\s*(.+)/);
        if (match) {
          objective = match[1].trim();
        }
        continue;
      }

      // Parse plan ID from comment
      if (line.includes('<!-- Plan ID:')) {
        const match = line.match(/<!-- Plan ID: (.+) -->/);
        if (match) {
          planId = match[1].trim();
        }
        continue;
      }

      // Parse created date from comment
      if (line.includes('<!-- Created:')) {
        const match = line.match(/<!-- Created: (.+) -->/);
        if (match) {
          createdAt = new Date(match[1].trim()).getTime();
        }
        continue;
      }

      // Parse phase header
      if (line.startsWith('## ')) {
        const phaseMatch = line.match(/## [○◐●✖⊘] Phase: (.+)/);
        if (phaseMatch) {
          if (currentPhase) {
            phases.push(currentPhase);
          }
          currentPhase = {
            id: this.generateId(),
            title: phaseMatch[1].trim(),
            status: this.parsePhaseStatus(line),
            steps: [],
          };
        }
        continue;
      }

      // Parse steps
      if (line.startsWith('- [') && currentPhase) {
        const stepMatch = line.match(/- \[([x ])\] ([○◐●✖⊘]) (.+)/);
        if (stepMatch) {
          const isCompleted = stepMatch[1] === 'x';
          const statusIcon = stepMatch[2];
          const stepContent = stepMatch[3].trim();

          currentPhase.steps.push({
            id: this.generateId(),
            content: stepContent,
            status: this.parseStepStatus(statusIcon, isCompleted),
          });
        }
        continue;
      }

      // Parse phase notes
      if (line.startsWith('> ') && currentPhase && !line.includes('**')) {
        currentPhase.notes = line.slice(2).trim();
        continue;
      }
    }

    // Push last phase
    if (currentPhase) {
      phases.push(currentPhase);
    }

    const plan: TaskPlan = {
      id: planId,
      title: title || 'Untitled Plan',
      objective: objective || '',
      phases,
      createdAt,
      updatedAt: Date.now(),
      metadata: this.calculateMetadata(phases),
    };

    return plan;
  }

  private parsePhaseStatus(line: string): TaskPhaseStatus {
    if (line.includes('●')) return 'completed';
    if (line.includes('◐')) return 'in_progress';
    if (line.includes('✖')) return 'blocked';
    return 'pending';
  }

  private parseStepStatus(icon: string, isCompleted: boolean): TaskStepStatus {
    if (isCompleted || icon === '●') return 'completed';
    if (icon === '◐') return 'in_progress';
    if (icon === '⊘') return 'skipped';
    return 'pending';
  }

  // ==========================================================================
  // Helper Methods
  // ==========================================================================

  private calculateMetadata(phases: TaskPhase[]): TaskPlanMetadata {
    let totalSteps = 0;
    let completedSteps = 0;
    let blockedSteps = 0;

    for (const phase of phases) {
      totalSteps += phase.steps.length;
      completedSteps += phase.steps.filter(
        (s) => s.status === 'completed'
      ).length;
      blockedSteps += phase.steps.filter((s) => s.status === 'skipped').length;
    }

    return { totalSteps, completedSteps, blockedSteps };
  }

  private autoUpdatePhaseStatus(phase: TaskPhase): void {
    const allCompleted = phase.steps.every(
      (s) => s.status === 'completed' || s.status === 'skipped'
    );
    const anyInProgress = phase.steps.some((s) => s.status === 'in_progress');

    if (allCompleted && phase.steps.length > 0) {
      phase.status = 'completed';
    } else if (anyInProgress) {
      phase.status = 'in_progress';
    }
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}
