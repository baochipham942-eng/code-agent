// ============================================================================
// NudgeManager Tests
// Tests for P1 (read-only stop), P3 (missing files), P5 (output files),
// and trackModifiedFile functionality.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock logCollector
vi.mock('../../../src/main/mcp/logCollector', () => ({
  logCollector: {
    agent: vi.fn(),
    addLog: vi.fn(),
  },
}));

// Mock planning taskStore (legacy tools/planning/ barrel removed in P1 Wave 3 —
// see src/main/tools/modules/planning/; getIncompleteTasks 直接来自 services)
const mockGetIncompleteTasks = vi.fn().mockReturnValue([]);
vi.mock('../../../src/main/services/planning/taskStore', () => ({
  getIncompleteTasks: (...args: unknown[]) => mockGetIncompleteTasks(...args),
}));

// Mock fs — existsSync / readdirSync
const mockExistsSync = vi.fn().mockReturnValue(false);
const mockReaddirSync = vi.fn().mockReturnValue([]);
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
  };
});

import { NudgeManager } from '../../../src/main/agent/nudgeManager';
import type { NudgeCheckContext } from '../../../src/main/agent/nudgeManager';
import { GoalTracker } from '../../../src/main/agent/goalTracker';

// ── Helpers ──

function createMockContext(overrides: Partial<NudgeCheckContext> = {}): NudgeCheckContext {
  return {
    toolsUsedInTurn: [],
    isSimpleTaskMode: true,
    sessionId: 'test-session',
    iterations: 1,
    workingDirectory: '/tmp/test',
    injectSystemMessage: vi.fn(),
    onEvent: vi.fn(),
    goalTracker: {
      isInitialized: () => false,
      getGoalSummary: () => ({ goal: '', completed: [], pending: [] }),
    } as unknown as GoalTracker,
    ...overrides,
  };
}

// ============================================================================
// Tests
// ============================================================================

describe('NudgeManager', () => {
  let manager: NudgeManager;

  beforeEach(() => {
    manager = new NudgeManager();
    vi.clearAllMocks();
    mockGetIncompleteTasks.mockReturnValue([]);
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
  });

  // ────────────────────────────────────────────────────────────────────────
  // P1: Read-only stop pattern detection
  // ────────────────────────────────────────────────────────────────────────

  describe('P1: Read-only stop', () => {
    it('returns nudge when only read tools used', () => {
      manager.reset([], 'fix the bug', '/tmp/test', []);

      const ctx = createMockContext({
        toolsUsedInTurn: ['read_file', 'grep', 'glob'],
      });

      const result = manager.runNudgeChecks(ctx);

      expect(result).toBe(true);
      expect(ctx.injectSystemMessage).toHaveBeenCalledTimes(1);
      // The nudge message should be injected (content comes from antiPatternDetector)
      expect(ctx.onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'notification',
          data: expect.objectContaining({
            message: expect.stringContaining('只读模式'),
          }),
        }),
      );
    });

    it('uses repair mutation tools in read-only nudge when provided', () => {
      manager.reset([], 'fix the artifact', '/tmp/test', []);

      const ctx = createMockContext({
        toolsUsedInTurn: ['read_file', 'grep'],
        mutationToolPrompt: 'Edit 或 Append',
      });

      const result = manager.runNudgeChecks(ctx);

      expect(result).toBe(true);
      const injectedMessage = (ctx.injectSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(injectedMessage).toContain('Edit 或 Append');
      expect(injectedMessage).not.toContain('write_file');
    });

    it('uses analysis wording for diagnosis prompts', () => {
      manager.reset([], '我本地的 Alma app 对流式输出怎么优化', '/tmp/test', []);

      const ctx = createMockContext({
        toolsUsedInTurn: ['read_file', 'grep', 'glob'],
      });

      const result = manager.runNudgeChecks(ctx);

      expect(result).toBe(true);
      const injectedMessage = (ctx.injectSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(injectedMessage).toContain('analysis-nudge');
      expect(injectedMessage).toContain('收束证据并输出分析');
      expect(injectedMessage).not.toContain('立即执行修改');
      expect(injectedMessage).not.toContain('edit_file');
      expect(injectedMessage).not.toContain('write_file');
      expect(ctx.onEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            message: expect.stringContaining('收束证据'),
          }),
        }),
      );
    });

    it('keeps mutation wording when implementation is expected', () => {
      manager.reset([], '修复这个 bug', '/tmp/test', []);

      const ctx = createMockContext({
        toolsUsedInTurn: ['read_file', 'grep', 'glob'],
      });

      const result = manager.runNudgeChecks(ctx);

      expect(result).toBe(true);
      const injectedMessage = (ctx.injectSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(injectedMessage).toContain('立即执行修改');
    });

    it('returns null when write tools used', () => {
      manager.reset([], 'fix the bug', '/tmp/test', []);

      const ctx = createMockContext({
        toolsUsedInTurn: ['read_file', 'edit_file'],
      });

      const result = manager.runNudgeChecks(ctx);

      // With write tools present, P1 should not trigger (antiPatternDetector returns null)
      // Other nudges (P2-P5) also shouldn't trigger because:
      // - P2: isSimpleTaskMode=true skips it
      // - P3: no targetFiles
      // - P5: no expectedOutputFiles
      expect(result).toBe(false);
      expect(ctx.injectSystemMessage).not.toHaveBeenCalled();
    });

    it('stops nudging after max count', () => {
      manager.reset([], 'fix the bug', '/tmp/test', []);

      // Trigger P1 nudge 3 times (maxReadOnlyNudges = 3)
      for (let i = 0; i < 3; i++) {
        const ctx = createMockContext({
          toolsUsedInTurn: ['read_file'],
        });
        const result = manager.runNudgeChecks(ctx);
        expect(result).toBe(true);
      }

      // 4th attempt should NOT trigger (exhausted)
      const ctx = createMockContext({
        toolsUsedInTurn: ['read_file'],
      });
      const result = manager.runNudgeChecks(ctx);

      // P1 is exhausted; P2/P3/P5 don't apply → returns false
      expect(result).toBe(false);
    });
  });

  describe('P2 Checkpoint progress', () => {
    it('uses repair mutation tools in checkpoint nudge when provided', () => {
      const injectSystemMessage = vi.fn();

      manager.checkProgressState(['read_file'], injectSystemMessage, { mutationToolPrompt: 'Edit 或 Append' });
      manager.checkProgressState(['Read'], injectSystemMessage, { mutationToolPrompt: 'Edit 或 Append' });
      manager.checkProgressState(['read_file'], injectSystemMessage, { mutationToolPrompt: 'Edit 或 Append' });

      expect(injectSystemMessage).toHaveBeenCalledTimes(1);
      const injectedMessage = injectSystemMessage.mock.calls[0][0] as string;
      expect(injectedMessage).toContain('Edit 或 Append');
      expect(injectedMessage).not.toContain('write_file');
    });

    it('uses analysis checkpoint wording for diagnosis prompts', () => {
      const injectSystemMessage = vi.fn();
      manager.reset([], '诊断一下启动为什么慢，只输出分析', '/tmp/test', []);

      manager.checkProgressState(['read_file'], injectSystemMessage);
      manager.checkProgressState(['Read'], injectSystemMessage);
      manager.checkProgressState(['read_file'], injectSystemMessage);

      expect(injectSystemMessage).toHaveBeenCalledTimes(1);
      const injectedMessage = injectSystemMessage.mock.calls[0][0] as string;
      expect(injectedMessage).toContain('收束证据并输出分析');
      expect(injectedMessage).not.toContain('实施修改');
      expect(injectedMessage).not.toContain('edit_file');
      expect(injectedMessage).not.toContain('write_file');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // P2: Task completion nudges
  // ────────────────────────────────────────────────────────────────────────

  describe('P2: Task completion', () => {
    it('does not nudge on unrelated incomplete task-store items', () => {
      manager.reset([], '验证 workflow_orchestrate 是否能返回 ok', '/tmp/test', []);
      mockGetIncompleteTasks.mockReturnValue([{ id: '1', subject: 'stale task' }]);

      const ctx = createMockContext({
        isSimpleTaskMode: false,
        toolsUsedInTurn: ['workflow_orchestrate'],
      });

      const result = manager.runNudgeChecks(ctx);

      expect(result).toBe(false);
      expect(ctx.injectSystemMessage).not.toHaveBeenCalled();
    });

    it('nudges when the user explicitly asks to manage tasks', () => {
      manager.reset([], '把这些任务完成并更新 task 状态', '/tmp/test', []);
      mockGetIncompleteTasks.mockReturnValue([{ id: '1', subject: 'finish smoke' }]);

      const ctx = createMockContext({
        isSimpleTaskMode: false,
        toolsUsedInTurn: ['TaskManager'],
      });

      const result = manager.runNudgeChecks(ctx);

      expect(result).toBe(true);
      expect(ctx.injectSystemMessage).toHaveBeenCalledTimes(1);
      const injectedMessage = (ctx.injectSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(injectedMessage).toContain('task-completion-check');
      expect(injectedMessage).toContain('finish smoke');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // P2 升级: taskGate (roadmap 1.3)
  // ────────────────────────────────────────────────────────────────────────

  describe('P2: taskGate (roadmap 1.3)', () => {
    it('gates stop when the model used task tools this run, even without task keywords', () => {
      manager.reset([], 'do the thing', '/tmp/test', []);
      manager.recordTaskManagerUse();
      mockGetIncompleteTasks.mockReturnValue([{ id: 't1', subject: 'open item', status: 'pending' }]);

      const ctx = createMockContext({
        isSimpleTaskMode: false,
        toolsUsedInTurn: ['write_file'],
      });

      const result = manager.runNudgeChecks(ctx);

      expect(result).toBe(true);
      const injectedMessage = (ctx.injectSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(injectedMessage).toContain('task-completion-check');
      expect(injectedMessage).toContain('open item');
    });

    it('resets the task-tool trigger on each new user input', () => {
      manager.reset([], 'first run', '/tmp/test', []);
      manager.recordTaskManagerUse();
      manager.reset([], 'second run unrelated work', '/tmp/test', []);
      mockGetIncompleteTasks.mockReturnValue([{ id: 't1', subject: 'stale', status: 'pending' }]);

      const ctx = createMockContext({
        isSimpleTaskMode: false,
        toolsUsedInTurn: ['write_file'],
      });

      expect(manager.runNudgeChecks(ctx)).toBe(false);
    });

    it('allows up to 3 reentries for open tasks then lets the model stop (MiMo main cap)', () => {
      manager.reset([], '把这些任务完成并更新 task 状态', '/tmp/test', []);
      mockGetIncompleteTasks.mockReturnValue([{ id: 't1', subject: 'never done', status: 'pending' }]);

      const ctx = createMockContext({
        isSimpleTaskMode: false,
        toolsUsedInTurn: ['write_file'],
      });

      expect(manager.runNudgeChecks(ctx)).toBe(true);
      expect(manager.runNudgeChecks(ctx)).toBe(true);
      expect(manager.runNudgeChecks(ctx)).toBe(true);
      // 第 4 次：达到 main 上限 3，放行停止
      expect(manager.runNudgeChecks(ctx)).toBe(false);
    });
  });

  describe('F4: Goal completion verification', () => {
    it('does not require write actions for appshot analysis prompts', () => {
      manager.reset([], '<appshot app="com.apple.finder" name="Finder">Downloads</appshot> What is in this screenshot?', '/tmp/test', []);

      const ctx = createMockContext({
        isSimpleTaskMode: false,
        iterations: 2,
        goalTracker: {
          isInitialized: () => true,
          getGoalSummary: () => ({ goal: 'What is in this screenshot?', completed: [], failed: [], pending: [] }),
        } as unknown as GoalTracker,
      });

      const result = manager.runNudgeChecks(ctx);

      expect(result).toBe(false);
      expect(ctx.injectSystemMessage).not.toHaveBeenCalled();
    });

    it('still requires write actions for explicit mutation prompts', () => {
      manager.reset([], '修复这个 bug', '/tmp/test', []);

      const ctx = createMockContext({
        isSimpleTaskMode: false,
        iterations: 2,
        goalTracker: {
          isInitialized: () => true,
          getGoalSummary: () => ({ goal: '修复这个 bug', completed: [], failed: [], pending: [] }),
        } as unknown as GoalTracker,
      });

      const result = manager.runNudgeChecks(ctx);

      expect(result).toBe(true);
      const injectedMessage = (ctx.injectSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(injectedMessage).toContain('goal-completion-check');
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // P3: Missing files detection
  // ────────────────────────────────────────────────────────────────────────

  describe('P3: Missing files', () => {
    it('detects unmodified target files', () => {
      // Set target files but don't track any modifications
      manager.reset(['src/app.ts', 'src/utils.ts'], 'fix these files', '/tmp/test', []);

      // Use write tools so P1 doesn't fire first
      const ctx = createMockContext({
        toolsUsedInTurn: ['edit_file'],
      });

      const result = manager.runNudgeChecks(ctx);

      expect(result).toBe(true);
      expect(ctx.injectSystemMessage).toHaveBeenCalledTimes(1);
      const injectedMessage = (ctx.injectSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(injectedMessage).toContain('file-completion-check');
      expect(injectedMessage).toContain('src/app.ts');
      expect(injectedMessage).toContain('src/utils.ts');
    });

    it('skips after files are modified', () => {
      manager.reset(['src/app.ts', 'src/utils.ts'], 'fix these files', '/tmp/test', []);

      // Track both files as modified
      manager.trackModifiedFile('src/app.ts');
      manager.trackModifiedFile('src/utils.ts');

      const ctx = createMockContext({
        toolsUsedInTurn: ['edit_file'],
      });

      const result = manager.runNudgeChecks(ctx);

      // All target files are modified → P3 should not trigger
      expect(result).toBe(false);
      expect(ctx.injectSystemMessage).not.toHaveBeenCalled();
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // P5: Output file existence verification
  // ────────────────────────────────────────────────────────────────────────

  describe('P5: Output files', () => {
    it('detects missing expected output', () => {
      const expectedFiles = ['/tmp/test/output.xlsx', '/tmp/test/report.csv'];
      manager.reset([], '生成报告文件', '/tmp/test', expectedFiles);

      // existsSync returns false → files are missing
      mockExistsSync.mockReturnValue(false);

      // Use write tools so P1 doesn't fire
      const ctx = createMockContext({
        toolsUsedInTurn: ['write_file'],
      });

      const result = manager.runNudgeChecks(ctx);

      expect(result).toBe(true);
      expect(ctx.injectSystemMessage).toHaveBeenCalledTimes(1);
      const injectedMessage = (ctx.injectSystemMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(injectedMessage).toContain('output-file-check');
      expect(injectedMessage).toContain('/tmp/test/output.xlsx');
      expect(injectedMessage).toContain('/tmp/test/report.csv');
    });

    it('stops after max nudges', () => {
      const expectedFiles = ['/tmp/test/output.xlsx'];
      manager.reset([], '生成文件', '/tmp/test', expectedFiles);
      mockExistsSync.mockReturnValue(false);

      // Trigger P5 nudge 3 times (maxOutputFileNudges = 3)
      for (let i = 0; i < 3; i++) {
        const ctx = createMockContext({
          toolsUsedInTurn: ['write_file'],
        });
        const result = manager.runNudgeChecks(ctx);
        expect(result).toBe(true);
      }

      // 4th attempt should NOT trigger
      const ctx = createMockContext({
        toolsUsedInTurn: ['write_file'],
      });
      const result = manager.runNudgeChecks(ctx);

      expect(result).toBe(false);
    });
  });

  // ────────────────────────────────────────────────────────────────────────
  // trackModifiedFile
  // ────────────────────────────────────────────────────────────────────────

  describe('trackModifiedFile', () => {
    it('records modified files correctly', () => {
      manager.reset([], 'task', '/tmp/test', []);

      manager.trackModifiedFile('src/app.ts');
      manager.trackModifiedFile('./src/utils.ts');
      manager.trackModifiedFile('/src/index.ts');

      const modified = manager.getModifiedFiles();

      // All paths should be normalized (leading ./ and / stripped)
      expect(modified.has('src/app.ts')).toBe(true);
      expect(modified.has('src/utils.ts')).toBe(true);
      expect(modified.has('src/index.ts')).toBe(true);
      expect(modified.size).toBe(3);
    });
  });
});
