// ============================================================================
// NudgeManager - Extracted from AgentLoop
// Manages all nudge state variables and P1-P5/P7/P0 nudge check logic.
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
import type { Message } from '../../shared/types';

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
    this.outputFileNudgeCount = 0;

    this._outputValidationDone = false;
    this._originalUserPrompt = userMessage;
    this._requirementVerificationDone = false;

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
  // P1-P5 Nudge checks
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * P1-P5 nudge checks: detect premature stops and nudge the agent to continue.
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

  /** Expose antiPatternDetector for AgentLoop (still needed for force-execute detection). */
  getAntiPatternDetector(): AntiPatternDetector {
    return this.antiPatternDetector;
  }
}
