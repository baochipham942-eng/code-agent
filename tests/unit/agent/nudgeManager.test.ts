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

// Mock todoWrite — return empty by default, tests can override
const mockGetCurrentTodos = vi.fn().mockReturnValue([]);
vi.mock('../../../src/main/tools/planning/todoWrite', () => ({
  getCurrentTodos: (...args: unknown[]) => mockGetCurrentTodos(...args),
}));

// Mock planning taskStore
const mockGetIncompleteTasks = vi.fn().mockReturnValue([]);
vi.mock('../../../src/main/tools/planning', () => ({
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
    mockGetCurrentTodos.mockReturnValue([]);
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
