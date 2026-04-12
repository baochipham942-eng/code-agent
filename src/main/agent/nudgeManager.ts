// ============================================================================
// NudgeManager - Extracted from AgentLoop
// Manages all nudge state variables and P1-P5/P7/P0/P4 nudge check logic.
// ============================================================================

import { existsSync, readdirSync } from 'fs';
import { basename } from 'path';
import { spawnSync } from 'child_process';
import { createLogger } from '../services/infra/logger';
import { logCollector } from '../mcp/logCollector.js';
import { AntiPatternDetector } from './antiPattern/detector';
import { GoalTracker } from './goalTracker';
import { getSessionTodos as getCurrentTodos } from './todoParser';
import { getIncompleteTasks } from '../tools/planning/taskStore';
import { READ_ONLY_TOOLS, WRITE_TOOLS, VERIFY_TOOLS, type TaskProgressState } from './loopTypes';
import type { Message } from '../../shared/contract';

const logger = createLogger('NudgeManager');

/**
 * Context passed to NudgeManager methods from AgentLoop.
 * Avoids holding a reference to the loop itself.
 */
export interface NudgeCheckContext {
  toolsUsedInTurn: string[];
  isSimpleTaskMode: boolean;
  sessionId: string;
  iterations: number;
  workingDirectory: string;
  /** Inject a system message into the conversation */
  injectSystemMessage: (content: string) => void;
  /** Emit an agent event (notification, etc.) */
  onEvent: (event: { type: string; data: unknown }) => void;
  /** GoalTracker instance for F4 checks */
  goalTracker: GoalTracker;
}

/**
 * NudgeManager encapsulates all nudge-related state and check logic
 * previously embedded in AgentLoop.
 */
export class NudgeManager {
  // ── P1 Nudge: Read-only stop pattern detection ──
  private readOnlyNudgeCount: number = 0;
  private maxReadOnlyNudges: number = 3;

  // ── P2 Nudge: Todo completion ──
  private todoNudgeCount: number = 0;
  private maxTodoNudges: number = 2;

  // ── P3 Nudge: File completion tracking ──
  private fileNudgeCount: number = 0;
  private maxFileNudges: number = 2;
  private targetFiles: string[] = [];
  private modifiedFiles: Set<string> = new Set();

  // ── P2 Checkpoint: Task progress state tracking ──
  private consecutiveExploringCount: number = 0;
  private maxConsecutiveExploring: number = 3;
  private lastProgressState: TaskProgressState = 'exploring';

  // ── F4: Goal-based completion verification ──
  private goalVerificationCount: number = 0;
  private maxGoalVerifications: number = 2;

  // ── P4: Subtask completion verification (Excel multi-subtask) ──
  private _subtaskNudgeCount: number = 0;
  private maxSubtaskNudges: number = 2;
  private _extractedSubtasks: string[] = [];

  // ── P5: Output file existence verification ──
  private expectedOutputFiles: string[] = [];
  private outputFileNudgeCount: number = 0;
  private maxOutputFileNudges: number = 3;
  private _userExpectsOutput: boolean = false;
  private _initialDataFiles: Set<string> = new Set();

  // ── P7 + P0: Output validation ──
  private _outputValidationDone: boolean = false;
  private _originalUserPrompt: string = '';
  private _requirementVerificationDone: boolean = false;
  private _enhancedValidationDone: boolean = false;
  private _lastStructureInfo: string | null = null;

  // ── Shared detector ──
  private antiPatternDetector: AntiPatternDetector;

  constructor() {
    this.antiPatternDetector = new AntiPatternDetector();
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Lifecycle
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Reset all nudge state at the beginning of each run().
   * @param targetFiles - files mentioned in the user prompt that should be modified
   * @param userMessage - the raw user message (for output-expectation detection)
   * @param workingDirectory - current working directory
   * @param expectedOutputFiles - absolute paths that don't yet exist on disk
   */
  reset(
    targetFiles: string[],
    userMessage: string,
    workingDirectory: string,
    expectedOutputFiles: string[],
  ): void {
    this.targetFiles = targetFiles;
    this.modifiedFiles.clear();
    this.fileNudgeCount = 0;

    this.readOnlyNudgeCount = 0;
    this.todoNudgeCount = 0;
    this.goalVerificationCount = 0;
    this._subtaskNudgeCount = 0;
    this._extractedSubtasks = this._extractSubtasksFromPrompt(userMessage);
    this.outputFileNudgeCount = 0;

    this._outputValidationDone = false;
    this._originalUserPrompt = userMessage;
    this._requirementVerificationDone = false;
    this._enhancedValidationDone = false;
    this._lastStructureInfo = null;
    this._userExpectsOutput = /保存|导出|生成.*文件|输出.*文件|写入|\.xlsx|\.csv|\.png|\.pdf|export|save/i.test(userMessage);

    // P5-3: snapshot initial data files
    try {
      this._initialDataFiles = new Set(
        readdirSync(workingDirectory).filter(f =>
          f.endsWith('.xlsx') || f.endsWith('.xls') || f.endsWith('.csv') || f.endsWith('.png')
        )
      );
    } catch { this._initialDataFiles = new Set(); }

    this.expectedOutputFiles = expectedOutputFiles;

    // P2 checkpoint state
    this.consecutiveExploringCount = 0;
    this.lastProgressState = 'exploring';
  }

  // ──────────────────────────────────────────────────────────────────────────
  // File tracking
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Track a file that was successfully modified (edit_file / write_file).
   */
  trackModifiedFile(filePath: string): void {
    const normalizedPath = filePath.replace(/^\.\//, '').replace(/^\//, '');
    this.modifiedFiles.add(normalizedPath);
    logger.debug(`[NudgeManager] P3 Nudge: Tracked modified file: ${normalizedPath}`);
  }

  /** Get the set of modified files (read-only snapshot). */
  getModifiedFiles(): Set<string> {
    return this.modifiedFiles;
  }

  /** Get target files list. */
  getTargetFiles(): string[] {
    return this.targetFiles;
  }

  /** Get expected output files list. */
  getExpectedOutputFiles(): string[] {
    return this.expectedOutputFiles;
  }

  /** Whether user expects output files. */
  get userExpectsOutput(): boolean {
    return this._userExpectsOutput;
  }

  /** Get initial data files snapshot. */
  get initialDataFiles(): Set<string> {
    return this._initialDataFiles;
  }

  /** Whether output validation (P7) has been done. */
  get outputValidationDone(): boolean {
    return this._outputValidationDone;
  }

  /** Current output file nudge count. */
  get currentOutputFileNudgeCount(): number {
    return this.outputFileNudgeCount;
  }

  /** Max output file nudges. */
  get maxOutputFileNudgeCount(): number {
    return this.maxOutputFileNudges;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // P1-P5 (incl. P4) Nudge checks
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * P1-P5 nudge checks: detect premature stops and nudge the agent to continue.
   * P4 (subtask completion) is inserted between F4 and P5.
   * Returns true if a nudge was injected (caller should continue the loop).
   */
  runNudgeChecks(ctx: NudgeCheckContext): boolean {
    // P1 Nudge: Detect read-only stop pattern
    if (ctx.toolsUsedInTurn.length > 0 && this.readOnlyNudgeCount < this.maxReadOnlyNudges) {
      const nudgeMessage = this.antiPatternDetector.detectReadOnlyStopPattern(ctx.toolsUsedInTurn);
      if (nudgeMessage) {
        this.readOnlyNudgeCount++;
        logger.debug(`[NudgeManager] Read-only stop pattern detected, nudge ${this.readOnlyNudgeCount}/${this.maxReadOnlyNudges}`);
        logCollector.agent('INFO', `Read-only stop pattern detected, nudge ${this.readOnlyNudgeCount}/${this.maxReadOnlyNudges}`);
        ctx.injectSystemMessage(nudgeMessage);
        ctx.onEvent({
          type: 'notification',
          data: { message: `检测到只读模式，提示继续执行修改 (${this.readOnlyNudgeCount}/${this.maxReadOnlyNudges})...` },
        });
        return true;
      }
    }

    // P2 Nudge: Check for incomplete todos AND tasks in complex tasks
    if (!ctx.isSimpleTaskMode && this.todoNudgeCount < this.maxTodoNudges) {
      const todos = getCurrentTodos(ctx.sessionId);
      const incompleteTodos = todos.filter(t => t.status !== 'completed');
      const incompleteTasks = getIncompleteTasks(ctx.sessionId);

      const totalIncomplete = incompleteTodos.length + incompleteTasks.length;

      if (totalIncomplete > 0) {
        this.todoNudgeCount++;

        const itemList: string[] = [];
        if (incompleteTodos.length > 0) {
          itemList.push(...incompleteTodos.map(t => `- [Todo] ${t.content}`));
        }
        if (incompleteTasks.length > 0) {
          itemList.push(...incompleteTasks.map(t => `- [Task #${t.id}] ${t.subject}`));
        }
        const combinedList = itemList.join('\n');

        logger.debug(`[NudgeManager] Incomplete items detected, nudge ${this.todoNudgeCount}/${this.maxTodoNudges}`);
        logCollector.agent('INFO', `Incomplete items detected: ${totalIncomplete} items`, {
          nudgeCount: this.todoNudgeCount,
          incompleteTodos: incompleteTodos.map(t => t.content),
          incompleteTasks: incompleteTasks.map(t => ({ id: t.id, subject: t.subject })),
        });
        ctx.injectSystemMessage(
          `<task-completion-check>\n` +
          `STOP! You have ${totalIncomplete} incomplete item(s):\n${combinedList}\n\n` +
          `You MUST complete these tasks before finishing. Do NOT provide a final summary until all items are marked as completed.\n` +
          `- 未完成的 Todo 项会在工具执行后自动推进状态\n` +
          `- For Tasks: use task_update with status="completed" (or status="deleted" if no longer needed)\n` +
          `Continue working on the remaining items NOW.\n` +
          `</task-completion-check>`
        );
        ctx.onEvent({
          type: 'notification',
          data: { message: `检测到 ${totalIncomplete} 个未完成的任务，提示继续执行 (${this.todoNudgeCount}/${this.maxTodoNudges})...` },
        });
        return true;
      }
    }

    // P3 Nudge: Check if all target files have been modified
    if (this.targetFiles.length > 0 && this.fileNudgeCount < this.maxFileNudges) {
      const missingFiles: string[] = [];
      for (const targetFile of this.targetFiles) {
        const normalizedTarget = targetFile.replace(/^\.\//, '').replace(/^\//, '');
        const found = Array.from(this.modifiedFiles).some(modFile =>
          modFile === normalizedTarget ||
          modFile.endsWith(normalizedTarget) ||
          normalizedTarget.endsWith(modFile)
        );
        if (!found) {
          missingFiles.push(targetFile);
        }
      }

      if (missingFiles.length > 0) {
        this.fileNudgeCount++;
        const fileList = missingFiles.map(f => `- ${f}`).join('\n');
        logger.debug(`[NudgeManager] P3 Nudge: Missing files detected, nudge ${this.fileNudgeCount}/${this.maxFileNudges}`);
        logCollector.agent('INFO', `P3 Nudge: Missing file modifications`, {
          nudgeCount: this.fileNudgeCount,
          missingFiles,
          modifiedFiles: Array.from(this.modifiedFiles),
          targetFiles: this.targetFiles,
        });
        ctx.injectSystemMessage(
          `<file-completion-check>\n` +
          `STOP! The following files were mentioned in the task but have not been modified:\n${fileList}\n\n` +
          `Modified files so far: ${Array.from(this.modifiedFiles).join(', ') || 'none'}\n\n` +
          `You MUST modify ALL required files before finishing. Continue working on the missing files NOW.\n` +
          `</file-completion-check>`
        );
        ctx.onEvent({
          type: 'notification',
          data: { message: `检测到 ${missingFiles.length} 个文件未修改，提示继续执行 (${this.fileNudgeCount}/${this.maxFileNudges})...` },
        });
        return true;
      }
    }

    // F4 Nudge: Goal-based completion verification
    if (ctx.goalTracker.isInitialized()
      && !ctx.isSimpleTaskMode
      && this.goalVerificationCount < this.maxGoalVerifications) {
      const summary = ctx.goalTracker.getGoalSummary();
      const hasWriteAction = summary.completed.some(a =>
        a === 'edit_file' || a === 'Edit' || a === 'write_file' || a === 'Write' || a === 'bash' || a === 'Bash'
      );
      if (!hasWriteAction && ctx.iterations > 1) {
        this.goalVerificationCount++;
        ctx.injectSystemMessage(
          `<goal-completion-check>\n` +
          `STOP! 任务尚未完成。\n` +
          `原始目标: ${summary.goal}\n` +
          `已执行工具: ${summary.completed.join(', ') || '无'}\n` +
          `尚未进行任何文件修改。请继续完成任务，或明确说明为什么要提前停止。\n` +
          `</goal-completion-check>`
        );
        ctx.onEvent({
          type: 'notification',
          data: { message: `目标完成度检查：尚无写操作 (${this.goalVerificationCount}/${this.maxGoalVerifications})` },
        });
        return true;
      }
    }

    // P4 Nudge: Subtask completion verification (Excel multi-subtask scenarios)
    if (this._userExpectsOutput
      && this._extractedSubtasks.length > 1
      && this._subtaskNudgeCount < this.maxSubtaskNudges) {
      // Read current xlsx structure to compare against subtasks
      const existingXlsx = this.expectedOutputFiles.filter(
        f => existsSync(f) && (f.endsWith('.xlsx') || f.endsWith('.xls'))
      );
      // Also check for newly created xlsx in workingDirectory
      let newXlsx: string[] = [];
      try {
        const allFiles = readdirSync(ctx.workingDirectory);
        newXlsx = allFiles
          .filter(f => (f.endsWith('.xlsx') || f.endsWith('.xls')) && !this._initialDataFiles.has(f))
          .map(f => `${ctx.workingDirectory}/${f}`);
      } catch { /* ignore */ }
      const allOutputXlsx = [...new Set([...existingXlsx, ...newXlsx])];

      if (allOutputXlsx.length > 0) {
        const structureInfo = this._readOutputXlsxStructure(allOutputXlsx);
        if (structureInfo) {
          const incomplete = this._verifySubtaskCompletion(this._extractedSubtasks, structureInfo);
          if (incomplete.length > 0) {
            this._subtaskNudgeCount++;
            const subtaskList = incomplete.map(s => `- ${s}`).join('\n');
            logger.debug(`[NudgeManager] P4: TRIGGER (incomplete=${incomplete.length}/${this._extractedSubtasks.length}, nudge=${this._subtaskNudgeCount}/${this.maxSubtaskNudges})`);
            logCollector.agent('INFO', `P4 Nudge: Incomplete subtasks detected`, {
              nudgeCount: this._subtaskNudgeCount,
              totalSubtasks: this._extractedSubtasks.length,
              incompleteSubtasks: incomplete,
            });
            ctx.injectSystemMessage(
              `<subtask-completion-check>\n` +
              `STOP! 用户要求了 ${this._extractedSubtasks.length} 个子任务，但以下子任务尚未在输出中体现:\n${subtaskList}\n\n` +
              `当前输出结构:\n${structureInfo}\n\n` +
              `请立即完成剩余子任务，确保每个子任务都有对应的 sheet 或数据输出。\n` +
              `</subtask-completion-check>`
            );
            ctx.onEvent({
              type: 'notification',
              data: { message: `检测到 ${incomplete.length}/${this._extractedSubtasks.length} 个子任务未完成，提示继续 (${this._subtaskNudgeCount}/${this.maxSubtaskNudges})` },
            });
            return true;
          } else {
            logger.debug(`[NudgeManager] P4: SKIP (all ${this._extractedSubtasks.length} subtasks verified)`);
          }
        }
      } else {
        logger.debug(`[NudgeManager] P4: SKIP (no output xlsx yet)`);
      }
    }

    // P5 Nudge: Verify expected output files exist on disk
    // Check 1: explicit path missing
    if (this.expectedOutputFiles.length > 0 && this.outputFileNudgeCount < this.maxOutputFileNudges) {
      const missingOutputFiles = this.expectedOutputFiles.filter(f => !existsSync(f));
      if (missingOutputFiles.length > 0) {
        this.outputFileNudgeCount++;
        const fileList = missingOutputFiles.map(f => `- ${f}`).join('\n');
        logger.debug(`[NudgeManager] P5-1: TRIGGER (missing=${missingOutputFiles.length}, nudge=${this.outputFileNudgeCount}/${this.maxOutputFileNudges})`);
        logCollector.agent('INFO', `P5 Nudge: Expected output files missing`, {
          nudgeCount: this.outputFileNudgeCount,
          missingFiles: missingOutputFiles,
        });
        ctx.injectSystemMessage(
          `<output-file-check>\n` +
          `STOP! 用户要求的输出文件不存在:\n${fileList}\n\n` +
          `你声称任务已完成，但这些文件在磁盘上并未找到。请立即生成这些文件。\n` +
          `</output-file-check>`
        );
        ctx.onEvent({
          type: 'notification',
          data: { message: `检测到 ${missingOutputFiles.length} 个输出文件缺失，提示继续 (${this.outputFileNudgeCount}/${this.maxOutputFileNudges})` },
        });
        return true;
      } else {
        logger.debug(`[NudgeManager] P5-1: SKIP (explicit=${this.expectedOutputFiles.length}, allExist=true)`);
      }
    } else {
      logger.debug(`[NudgeManager] P5-1: SKIP (explicit=${this.expectedOutputFiles.length}, nudgeCount=${this.outputFileNudgeCount}/${this.maxOutputFileNudges})`);
    }

    // P5 Check 3: detect unexecuted Python scripts
    if (this._userExpectsOutput && this.outputFileNudgeCount < this.maxOutputFileNudges) {
      try {
        const allFiles = readdirSync(ctx.workingDirectory);
        const scriptFiles = allFiles.filter(f => f.endsWith('.py'));
        const newDataFiles = allFiles.filter(f =>
          (f.endsWith('.xlsx') || f.endsWith('.xls') || f.endsWith('.csv') || f.endsWith('.png'))
          && !this._initialDataFiles.has(f)
        );
        if (scriptFiles.length > 0 && newDataFiles.length === 0) {
          this.outputFileNudgeCount++;
          const scripts = scriptFiles.map(f => basename(f)).join(', ');
          logger.debug(`[NudgeManager] P5-3: TRIGGER (scripts=${scriptFiles.length}, dataFiles=0)`);
          logCollector.agent('INFO', `P5 Nudge: Python scripts not executed`, { scripts: scriptFiles });
          ctx.injectSystemMessage(
            `<output-file-check>\n` +
            `STOP! 你创建了 Python 脚本 (${scripts}) 但还没有成功执行它。\n` +
            `输出目录中没有检测到任何数据文件（xlsx/csv/png）。\n` +
            `请立即用 bash 工具执行该脚本: python3 <脚本路径>\n` +
            `如果脚本执行出错，请修复错误后重新执行。\n` +
            `</output-file-check>`
          );
          return true;
        } else {
          logger.debug(`[NudgeManager] P5-3: SKIP (scripts=${scriptFiles.length}, newDataFiles=${newDataFiles.length})`);
        }
      } catch { /* ignore readdir errors */ }
    }

    return false;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // P2 Checkpoint: progress state tracking (called after tool execution)
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Evaluate task progress state and nudge if stuck in exploring.
   * Called after each tool execution turn.
   */
  checkProgressState(
    toolsUsedInTurn: string[],
    injectSystemMessage: (content: string) => void,
  ): void {
    const currentState = this.evaluateProgressState(toolsUsedInTurn);
    if (currentState === 'exploring') {
      this.consecutiveExploringCount++;
      if (this.consecutiveExploringCount >= this.maxConsecutiveExploring) {
        logger.debug(`[NudgeManager] P2 Checkpoint: ${this.consecutiveExploringCount} consecutive exploring iterations, injecting nudge`);
        logCollector.agent('INFO', `P2 Checkpoint nudge: ${this.consecutiveExploringCount} exploring iterations`);
        injectSystemMessage(this.generateExploringNudge());
        this.consecutiveExploringCount = 0;
      }
    } else {
      this.consecutiveExploringCount = 0;
    }
    this.lastProgressState = currentState;
  }

  /**
   * P5 checks after force-execute path.
   * When the model wanted to stop (text response) but was force-executed,
   * verify output files after tool execution.
   */
  checkPostForceExecute(
    workingDirectory: string,
    injectSystemMessage: (content: string) => void,
  ): void {
    if (this.outputFileNudgeCount >= this.maxOutputFileNudges) return;

    // Check 1: explicit path missing
    if (this.expectedOutputFiles.length > 0) {
      const missingOutputFiles = this.expectedOutputFiles.filter(f => !existsSync(f));
      if (missingOutputFiles.length > 0) {
        this.outputFileNudgeCount++;
        const fileList = missingOutputFiles.map(f => `- ${f}`).join('\n');
        logger.debug(`[NudgeManager] P5 Nudge (post force-execute): Missing output files, nudge ${this.outputFileNudgeCount}/${this.maxOutputFileNudges}`);
        logCollector.agent('INFO', `P5 Nudge (post force-execute): Expected output files missing`, {
          nudgeCount: this.outputFileNudgeCount,
          missingFiles: missingOutputFiles,
        });
        injectSystemMessage(
          `<output-file-check>\n` +
          `用户要求的输出文件尚未生成:\n${fileList}\n\n` +
          `请确保在完成任务前生成这些文件。\n` +
          `</output-file-check>`
        );
        return;
      }
    }
    // Check 2: unexecuted Python scripts
    else if (this._userExpectsOutput) {
      try {
        const allFiles = readdirSync(workingDirectory);
        const scriptFiles = allFiles.filter(f => f.endsWith('.py'));
        const newDataFiles = allFiles.filter(f =>
          (f.endsWith('.xlsx') || f.endsWith('.xls') || f.endsWith('.csv') || f.endsWith('.png'))
          && !this._initialDataFiles.has(f)
        );
        if (scriptFiles.length > 0 && newDataFiles.length === 0) {
          this.outputFileNudgeCount++;
          const scripts = scriptFiles.map(f => basename(f)).join(', ');
          logger.debug(`[NudgeManager] P5-3 (post force-execute): TRIGGER (scripts=${scriptFiles.length}, newDataFiles=0)`);
          logCollector.agent('INFO', `P5 Nudge (post force-execute): scripts not executed`, { scripts: scriptFiles });
          injectSystemMessage(
            `<output-file-check>\n` +
            `你创建了 Python 脚本 (${scripts}) 但还没有成功执行它。\n` +
            `请用 bash 执行: python3 <脚本路径>\n` +
            `</output-file-check>`
          );
        }
      } catch { /* ignore readdir errors */ }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // P7 + P0: Output validation
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * P7 structure validation + P0 requirement re-injection.
   * Returns true if validation was injected (caller should continue the loop).
   */
  runOutputValidation(
    injectSystemMessage: (content: string) => void,
  ): boolean {
    // P7: Output structure validation
    if (!this._outputValidationDone) {
      const existingXlsx = this.expectedOutputFiles.filter(
        f => existsSync(f) && (f.endsWith('.xlsx') || f.endsWith('.xls'))
      );
      if (existingXlsx.length > 0) {
        this._outputValidationDone = true;
        const structureInfo = this._readOutputXlsxStructure(existingXlsx);
        this._lastStructureInfo = structureInfo;
        if (structureInfo) {
          logger.debug(`[NudgeManager] P7: TRIGGER (xlsxCount=${existingXlsx.length})`);
          logCollector.agent('INFO', `P7 Validation: output structure check`, { files: existingXlsx });
          injectSystemMessage(
            `<output-validation>\n` +
            `系统已自动读取你生成的输出文件结构：\n\n${structureInfo}\n\n` +
            `请对照用户的原始需求逐条核对：\n` +
            `1. 是否所有要求的 sheet/列/指标都已包含？\n` +
            `2. 行数是否合理（非空表、非仅表头）？\n` +
            `3. 列名是否清晰（无 Unnamed:0 等默认名）？\n` +
            `4. 去重是否用了 subset 参数指定主键列？\n` +
            `5. 阶梯累进计算（提成/税率）是否分段累加？\n` +
            `如有遗漏或问题，请立即修复。如全部满足，结束任务。\n` +
            `</output-validation>`
          );
          return true;
        }
      } else {
        logger.debug(`[NudgeManager] P7: SKIP (xlsxCount=0)`);
      }
    }

    // P7-Enhanced: Deep column & data completeness validation
    if (this._outputValidationDone && !this._enhancedValidationDone && this._lastStructureInfo) {
      this._enhancedValidationDone = true;

      const detectedColumns = this._extractColumnsFromStructure(this._lastStructureInfo);
      const columnIssues = this._validateColumnNames(this._originalUserPrompt, detectedColumns);
      const completenessIssues = this._validateDataCompleteness(this._lastStructureInfo);
      const allIssues = [...columnIssues, ...completenessIssues];

      if (allIssues.length > 0) {
        const issueList = allIssues.map(i => `- ${i}`).join('\n');
        logger.debug(`[NudgeManager] P7-Enhanced: TRIGGER (issues=${allIssues.length})`);
        logCollector.agent('INFO', `P7-Enhanced Validation: detected issues`, { issues: allIssues });
        injectSystemMessage(
          `<output-validation-enhanced>\n` +
          `系统深度检查发现以下问题：\n\n${issueList}\n\n` +
          `请立即修复上述问题后重新生成输出文件。\n` +
          `</output-validation-enhanced>`
        );
        return true;
      } else {
        logger.debug(`[NudgeManager] P7-Enhanced: SKIP (no issues)`);
      }
    }

    // P0: Requirement re-injection verification (Ralph Loop pattern)
    if (this._outputValidationDone && !this._requirementVerificationDone
        && this._originalUserPrompt) {
      this._requirementVerificationDone = true;

      const allExisting = this.expectedOutputFiles.filter(f => existsSync(f));
      const currentXlsx = allExisting.filter(f =>
        f.endsWith('.xlsx') || f.endsWith('.xls')
      );
      const fileList = allExisting.map(f => basename(f)).join(', ');
      const structureInfo = currentXlsx.length > 0
        ? this._readOutputXlsxStructure(currentXlsx)
        : null;

      logger.debug(`[NudgeManager] P0: TRIGGER (existingFiles=${allExisting.length})`);
      injectSystemMessage(
        `<requirement-verification>\n` +
        `请重新阅读用户的原始需求，逐条核对是否都已完成:\n\n` +
        `"""\n${this._originalUserPrompt}\n"""\n\n` +
        `当前输出文件: ${fileList || '无'}\n` +
        (structureInfo ? `当前输出结构:\n${structureInfo}\n\n` : '\n') +
        `逐条确认每项需求都有对应输出。如有遗漏，立即补充。如全部满足，结束任务。\n` +
        `</requirement-verification>`
      );
      return true;
    }

    return false;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Internal helpers
  // ──────────────────────────────────────────────────────────────────────────

  private evaluateProgressState(toolsUsed: string[]): TaskProgressState {
    const hasReadTools = toolsUsed.some(t => READ_ONLY_TOOLS.includes(t));
    const hasWriteTools = toolsUsed.some(t => WRITE_TOOLS.includes(t));
    const hasVerifyTools = toolsUsed.some(t => VERIFY_TOOLS.includes(t) || t === 'bash' || t === 'Bash');

    if (hasVerifyTools && !hasWriteTools) {
      return 'verifying';
    }
    if (hasWriteTools) {
      return 'modifying';
    }
    if (hasReadTools) {
      return 'exploring';
    }
    return 'exploring';
  }

  private generateExploringNudge(): string {
    return (
      `<checkpoint-nudge priority="medium">\n` +
      `已连续 ${this.maxConsecutiveExploring} 轮只读取未修改。\n` +
      `如果已充分了解问题，请开始用 edit_file 或 write_file 实施修改。\n` +
      `如果仍需调查，请在 <think> 中说明还需要了解什么，然后有针对性地读取。\n` +
      `</checkpoint-nudge>`
    );
  }

  /**
   * P7: Read output xlsx file structures using Python pandas.
   */
  private _readOutputXlsxStructure(xlsxFiles: string[]): string | null {
    try {
      const fileListPy = xlsxFiles.map(f => `'${f.replace(/'/g, "\\'")}'`).join(', ');
      const pyScript = [
        'import pandas as pd',
        'import numpy as np',
        `for f in [${fileListPy}]:`,
        '    try:',
        '        xl = pd.ExcelFile(f)',
        '        print(f"File: {f}")',
        '        for name in xl.sheet_names:',
        '            df = pd.read_excel(xl, name)',
        '            print(f"  Sheet \'{name}\': {len(df)} rows x {len(df.columns)} cols")',
        '            print(f"  Columns: {list(df.columns)}")',
        '            if len(df) > 0:',
        '                print("  Sample (first 2 rows):")',
        '                print(df.head(2).to_string(index=False))',
        '                print("  Column stats:")',
        '                for c in df.columns:',
        '                    col = df[c]',
        '                    nn = col.notna().sum()',
        '                    if pd.api.types.is_numeric_dtype(col):',
        '                        print(f"    {c}: dtype={col.dtype}, non_null={nn}/{len(df)}, min={col.min()}, max={col.max()}, mean={col.mean():.2f}")',
        '                    else:',
        '                        nuniq = col.nunique()',
        '                        print(f"    {c}: dtype={col.dtype}, non_null={nn}/{len(df)}, unique={nuniq}")',
        '                        if 2 <= nuniq <= 20:',
        '                            vc = col.value_counts()',
        '                            dist = ", ".join(f"{k}:{v}" for k,v in vc.head(10).items())',
        '                            print(f"      distribution: {dist}")',
        '            print()',
        '    except Exception as e:',
        '        print(f"  Error: {e}")',
      ].join('\n');

      const result = spawnSync('python3', ['-'], {
        input: pyScript,
        timeout: 15000,
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024,
      });

      if (result.status === 0 && result.stdout) {
        return result.stdout.trim() || null;
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * P4: Extract subtask list from user prompt using simple heuristics.
   * Recognizes numbered lists (1. 2. 3.), Chinese enumeration (A、B、C),
   * and keywords like "分别"/"各" that imply multiple parallel subtasks.
   */
  _extractSubtasksFromPrompt(userPrompt: string): string[] {
    const subtasks: string[] = [];

    // Pattern 1: Numbered list — "1. xxx  2. xxx" (inline or newline-separated)
    // Split by numbered prefix to handle both inline and multi-line formats
    const numberedParts = userPrompt.split(/(?:^|\s)(\d+)\s*[.)\、）]\s*/);
    // numberedParts: [prefix, "1", content1, "2", content2, ...]
    let m: RegExpExecArray | null;
    for (let i = 1; i < numberedParts.length; i += 2) {
      const content = (numberedParts[i + 1] || '').trim().split('\n')[0].trim();
      if (content.length >= 2) {
        subtasks.push(content);
      }
    }
    if (subtasks.length >= 2) return subtasks;

    // Pattern 2: Chinese enumeration with 、 — "按地区、按产品、按月份" or "地区、产品、月份"
    // Look for "分别" or "各" or "按...汇总/统计/分析" pattern
    const fenbieMatch = userPrompt.match(/(?:分别|各)\s*(?:按|对|将|把|从)?\s*(.+?)(?:进行|做|汇总|统计|分析|计算|生成|输出|导出|整理)/);
    if (fenbieMatch) {
      const enumPart = fenbieMatch[1].trim();
      const parts = enumPart.split(/[、，,和与及\s]+/).filter(p => p.length >= 1);
      if (parts.length >= 2) {
        return parts.map(p => p.trim());
      }
    }

    // Pattern 3: "按X、Y、Z汇总/统计/分析" without "分别"
    const byEnumMatch = userPrompt.match(/按\s*(.+?)(?:分别|各自)?\s*(?:汇总|统计|分析|计算|生成|输出|整理)/);
    if (byEnumMatch) {
      const enumPart = byEnumMatch[1].trim();
      const parts = enumPart.split(/[、，,和与及\s]+/).filter(p => p.length >= 1);
      if (parts.length >= 2) {
        return parts.map(p => p.trim());
      }
    }

    // Pattern 4: Dash/bullet list — - xxx  or * xxx
    const bulletRegex = /(?:^|\n)\s*[-*]\s+(.+)/g;
    const bullets: string[] = [];
    while ((m = bulletRegex.exec(userPrompt)) !== null) {
      const content = m[1].trim();
      if (content.length >= 2) {
        bullets.push(content);
      }
    }
    if (bullets.length >= 2) return bullets;

    return subtasks;
  }

  /**
   * P4: Verify subtask completion by comparing subtasks against xlsx output structure.
   * Returns the list of subtasks that are NOT yet reflected in the output.
   */
  _verifySubtaskCompletion(subtasks: string[], xlsxStructure: string): string[] {
    if (subtasks.length === 0) return [];

    const structureLower = xlsxStructure.toLowerCase();

    // Extract sheet names from structure
    const sheetNames: string[] = [];
    const sheetRegex = /Sheet '([^']+)'/g;
    let sm: RegExpExecArray | null;
    while ((sm = sheetRegex.exec(xlsxStructure)) !== null) {
      sheetNames.push(sm[1].toLowerCase());
    }

    // Extract column names from structure
    const columnNames: string[] = [];
    const colRegex = /Columns:\s*\[([^\]]*)\]/g;
    let cm: RegExpExecArray | null;
    while ((cm = colRegex.exec(xlsxStructure)) !== null) {
      const colStr = cm[1];
      const nameRegex = /['"]([^'"]+)['"]/g;
      let nm: RegExpExecArray | null;
      while ((nm = nameRegex.exec(colStr)) !== null) {
        columnNames.push(nm[1].toLowerCase());
      }
    }

    const incomplete: string[] = [];
    for (const subtask of subtasks) {
      const subtaskLower = subtask.toLowerCase();

      // Extract key terms from subtask (2+ char Chinese/English words)
      const keyTerms = subtaskLower.match(/[\u4e00-\u9fa5]{2,}|[a-z]{2,}/g) || [subtaskLower];

      // Check if any key term appears in sheet names, column names, or structure text
      const found = keyTerms.some(term =>
        sheetNames.some(s => s.includes(term) || term.includes(s)) ||
        columnNames.some(c => c.includes(term) || term.includes(c)) ||
        structureLower.includes(term)
      );

      if (!found) {
        incomplete.push(subtask);
      }
    }

    return incomplete;
  }

  /**
   * Extract column names from P7 pandas structure output.
   * Parses lines like "  Columns: ['col1', 'col2', ...]"
   */
  private _extractColumnsFromStructure(structureInfo: string): string[] {
    const columns: string[] = [];
    const colRegex = /Columns:\s*\[([^\]]*)\]/g;
    let match: RegExpExecArray | null;
    while ((match = colRegex.exec(structureInfo)) !== null) {
      const colStr = match[1];
      const nameRegex = /['"]([^'"]+)['"]/g;
      let nameMatch: RegExpExecArray | null;
      while ((nameMatch = nameRegex.exec(colStr)) !== null) {
        columns.push(nameMatch[1]);
      }
    }
    return columns;
  }

  /**
   * P7-Enhanced: Validate column names against user prompt.
   * Checks for Unnamed columns, data-value headers, and missing user-requested columns.
   */
  private _validateColumnNames(userPrompt: string, detectedColumns: string[]): string[] {
    const issues: string[] = [];
    if (detectedColumns.length === 0) return issues;

    // 1. Check for problematic column names
    const unnamed = detectedColumns.filter(c => /^Unnamed/i.test(c));
    if (unnamed.length > 0) {
      issues.push(`检测到 ${unnamed.length} 个未命名列 (${unnamed.join(', ')})，可能是装饰行或索引列泄露到表头`);
    }

    // Check for columns that look like data values leaked into header
    const suspectHeaders = detectedColumns.filter(c =>
      /^\d{4}[-/]\d{1,2}[-/]\d{1,2}$/.test(c) ||
      /^\d+(\.\d+)?$/.test(c)
    );
    if (suspectHeaders.length > 0) {
      issues.push(`检测到 ${suspectHeaders.length} 个疑似数据值作为列名 (${suspectHeaders.slice(0, 5).join(', ')})，可能是 header 行偏移`);
    }

    // 2. Extract candidate column names from user prompt
    const promptCandidates = this._extractColumnCandidates(userPrompt);
    if (promptCandidates.length === 0) return issues;

    // 3. Fuzzy match: check if user-requested columns are present
    const detectedLower = detectedColumns.map(c => c.toLowerCase().trim());
    const missing: string[] = [];
    for (const candidate of promptCandidates) {
      const candidateLower = candidate.toLowerCase().trim();
      const found = detectedLower.some(d =>
        d === candidateLower ||
        d.includes(candidateLower) ||
        candidateLower.includes(d)
      );
      if (!found) {
        missing.push(candidate);
      }
    }
    if (missing.length > 0) {
      issues.push(`用户提到的以下列名/字段在输出中未找到匹配: ${missing.join(', ')}`);
    }

    return issues;
  }

  /**
   * Extract candidate column/field names from user prompt.
   * Uses simple heuristic patterns for both Chinese and English.
   */
  private _extractColumnCandidates(prompt: string): string[] {
    const candidates = new Set<string>();
    let m: RegExpExecArray | null;

    // Pattern 1: Chinese field indicators
    const zhColRegex = /(?:包含|包括|需要|添加|有|含|列出)\s*[：:]*\s*([\u4e00-\u9fa5a-zA-Z0-9_/、，,]+)/g;
    while ((m = zhColRegex.exec(prompt)) !== null) {
      const parts = m[1].split(/[、，,/\s]+/).filter(Boolean);
      for (const p of parts) {
        const cleaned = p.replace(/[列字段栏]$/, '').trim();
        if (cleaned.length >= 2) candidates.add(cleaned);
      }
    }

    // Pattern 2: Quoted names
    const quotedRegex = /[""「『']([\u4e00-\u9fa5a-zA-Z0-9_ ]+)[""」』']/g;
    while ((m = quotedRegex.exec(prompt)) !== null) {
      const val = m[1].trim();
      if (val.length >= 2) candidates.add(val);
    }

    // Pattern 3: Explicit column listing
    const explicitRegex = /(?:列名?|字段|columns?|headers?)[：:\s]+([^\n。.]+)/gi;
    while ((m = explicitRegex.exec(prompt)) !== null) {
      const parts = m[1].split(/[、，,/\s]+/).filter(Boolean);
      for (const p of parts) {
        const cleaned = p.replace(/[列字段栏]$/, '').trim();
        if (cleaned.length >= 2) candidates.add(cleaned);
      }
    }

    return Array.from(candidates);
  }

  /**
   * P7-Enhanced: Validate data completeness from P7 pandas structure output.
   * Checks for empty sheets, all-null columns, and all-same-value columns.
   */
  private _validateDataCompleteness(structureInfo: string): string[] {
    const issues: string[] = [];

    // 1. Check for empty sheets (0 rows)
    const sheetRegex = /Sheet '([^']+)':\s*(\d+)\s*rows?\s*x\s*(\d+)\s*cols?/g;
    let sm: RegExpExecArray | null;
    while ((sm = sheetRegex.exec(structureInfo)) !== null) {
      const sheetName = sm[1];
      const rowCount = parseInt(sm[2], 10);
      if (rowCount === 0) {
        issues.push(`Sheet '${sheetName}' 行数为 0（空表），请检查数据写入逻辑`);
      }
    }

    // 2. Check for all-null columns (non_null=0/N)
    const nullColRegex = /(\S+):\s*dtype=\S+,\s*non_null=0\/(\d+)/g;
    let nm: RegExpExecArray | null;
    while ((nm = nullColRegex.exec(structureInfo)) !== null) {
      const colName = nm[1];
      const totalRows = parseInt(nm[2], 10);
      if (totalRows > 0) {
        issues.push(`列 '${colName}' 全部为空值 (non_null=0/${totalRows})，该列可能未正确填充数据`);
      }
    }

    // 3. Check for all-same-value columns (unique=1 with meaningful row count)
    const uniqueRegex = /(\S+):\s*dtype=\S+,\s*non_null=(\d+)\/(\d+),\s*unique=1(?:\b|$)/g;
    let um: RegExpExecArray | null;
    while ((um = uniqueRegex.exec(structureInfo)) !== null) {
      const colName = um[1];
      const nonNull = parseInt(um[2], 10);
      if (nonNull > 1) {
        issues.push(`列 '${colName}' 所有 ${nonNull} 行值完全相同 (unique=1)，可能是赋值逻辑有误`);
      }
    }

    return issues;
  }

  /** Expose antiPatternDetector for AgentLoop (still needed for force-execute detection). */
  getAntiPatternDetector(): AntiPatternDetector {
    return this.antiPatternDetector;
  }
}
