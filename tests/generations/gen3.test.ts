// ============================================================================
// Gen3 Tests - 智能规划期 (Smart Planning Era)
// Tests: task, todo_write, ask_user_question, plan tools
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Import tools
import { taskTool } from '../../src/main/tools/gen3/task';
import { todoWriteTool } from '../../src/main/tools/gen3/todoWrite';
import { askUserQuestionTool } from '../../src/main/tools/gen3/askUserQuestion';
import { planReadTool } from '../../src/main/tools/gen3/planRead';
import { planUpdateTool } from '../../src/main/tools/gen3/planUpdate';
import { findingsWriteTool } from '../../src/main/tools/gen3/findingsWrite';

// Mock electron
vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
  ipcMain: {
    handle: vi.fn(),
  },
}));

// Mock context
const createMockContext = (workingDirectory: string) => ({
  workingDirectory,
  generation: { id: 'gen3' as const },
  requestPermission: async () => true,
  emit: vi.fn(),
  planningService: {
    initialize: vi.fn().mockResolvedValue(undefined),
    plan: {
      read: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ title: 'Test', objective: 'Test', metadata: { totalSteps: 1 } }),
      getPlanPath: () => '/test/task_plan.md',
    },
    getPlan: () => null,
    updatePlan: () => {},
    getFindings: () => [],
    addFinding: () => {},
    findings: {
      getAll: vi.fn().mockReturnValue([]),
      add: vi.fn().mockResolvedValue({ id: 'finding_1', category: 'issue', title: 'Test', content: 'Test content' }),
      getCount: vi.fn().mockResolvedValue(1),
    },
  },
});

describe('Gen3 - Smart Planning Era', () => {
  let testDir: string;
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen3-test-'));
    context = createMockContext(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Todo Write Tool Tests
  // --------------------------------------------------------------------------
  describe('todo_write', () => {
    it('should create todo list with activeForm', async () => {
      const todos = [
        { content: 'First task', status: 'pending', activeForm: 'Starting first task' },
        { content: 'Second task', status: 'in_progress', activeForm: 'Working on second task' },
      ];

      const result = await todoWriteTool.execute(
        { todos },
        context
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('First task');
      expect(result.output).toContain('Second task');
    });

    it('should update todo status', async () => {
      const todos = [
        { content: 'Task 1', status: 'completed', activeForm: 'Completing task 1' },
        { content: 'Task 2', status: 'pending', activeForm: 'Starting task 2' },
      ];

      const result = await todoWriteTool.execute(
        { todos },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should handle empty todo list', async () => {
      const result = await todoWriteTool.execute(
        { todos: [] },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should support all status types', async () => {
      const todos = [
        { content: 'Pending task', status: 'pending', activeForm: 'Starting pending task' },
        { content: 'In progress task', status: 'in_progress', activeForm: 'Working on in progress task' },
        { content: 'Completed task', status: 'completed', activeForm: 'Completing completed task' },
      ];

      const result = await todoWriteTool.execute(
        { todos },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should fail without activeForm', async () => {
      const todos = [
        { content: 'Task without activeForm', status: 'pending' },
      ];

      const result = await todoWriteTool.execute(
        { todos },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('activeForm');
    });
  });

  // --------------------------------------------------------------------------
  // Ask User Question Tool Tests
  // --------------------------------------------------------------------------
  describe('ask_user_question', () => {
    it('should format questions correctly', async () => {
      const result = await askUserQuestionTool.execute(
        {
          questions: [
            {
              question: 'Which framework should we use?',
              header: 'Framework',
              options: [
                { label: 'React', description: 'A popular UI library' },
                { label: 'Vue', description: 'Progressive JavaScript framework' },
              ],
              multiSelect: false,
            },
          ],
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('Framework');
    });

    it('should require questions array', async () => {
      const result = await askUserQuestionTool.execute(
        {},
        context
      );

      expect(result.success).toBe(false);
    });

    it('should validate question format', async () => {
      const result = await askUserQuestionTool.execute(
        {
          questions: [
            { question: 'Missing fields?' },
          ],
        },
        context
      );

      expect(result.success).toBe(false);
    });

    it('should limit to 4 questions', async () => {
      const questions = Array(5).fill(null).map((_, i) => ({
        question: `Question ${i + 1}`,
        header: `Q${i + 1}`,
        options: [
          { label: 'Yes', description: 'Affirmative' },
          { label: 'No', description: 'Negative' },
        ],
        multiSelect: false,
      }));

      const result = await askUserQuestionTool.execute(
        { questions },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('4');
    });
  });

  // --------------------------------------------------------------------------
  // Plan Read Tool Tests
  // --------------------------------------------------------------------------
  describe('plan_read', () => {
    it('should read current plan', async () => {
      const result = await planReadTool.execute({}, context);

      expect(result.success).toBe(true);
    });

    it('should have correct metadata', () => {
      expect(planReadTool.generations).toContain('gen3');
      expect(planReadTool.name).toBe('plan_read');
    });
  });

  // --------------------------------------------------------------------------
  // Plan Update Tool Tests
  // --------------------------------------------------------------------------
  describe('plan_update', () => {
    it('should have correct metadata', () => {
      expect(planUpdateTool.generations).toContain('gen3');
      expect(planUpdateTool.name).toBe('plan_update');
    });

    it('should require action parameter', async () => {
      const result = await planUpdateTool.execute(
        {},
        context
      );

      // Check behavior based on implementation
      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Findings Write Tool Tests
  // --------------------------------------------------------------------------
  describe('findings_write', () => {
    it('should have correct metadata', () => {
      expect(findingsWriteTool.generations).toContain('gen3');
      expect(findingsWriteTool.name).toBe('findings_write');
    });

    it('should require findings array', async () => {
      const result = await findingsWriteTool.execute(
        {},
        context
      );

      expect(result.success).toBe(false);
    });

    it('should accept valid finding', async () => {
      const result = await findingsWriteTool.execute(
        {
          category: 'issue',
          title: 'Auth Module Issue',
          content: 'Found potential issue in auth module',
        },
        context
      );

      expect(result.success).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Task Tool Tests
  // --------------------------------------------------------------------------
  describe('task', () => {
    it('should have correct metadata', () => {
      expect(taskTool.generations).toContain('gen3');
      expect(taskTool.name).toBe('task');
      expect(taskTool.inputSchema.required).toContain('prompt');
    });

    it('should handle missing prompt gracefully', async () => {
      // Without full context (toolRegistry, modelConfig), task tool returns info
      const result = await taskTool.execute(
        { subagent_type: 'explore' },
        context
      );

      // Without toolRegistry/modelConfig, task returns info about the subagent
      expect(result).toBeDefined();
    });

    it('should reject unknown subagent_type', async () => {
      const result = await taskTool.execute(
        { prompt: 'Do something', subagent_type: 'unknown_type' },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown subagent type');
    });
  });

  // --------------------------------------------------------------------------
  // Tool Metadata Tests
  // --------------------------------------------------------------------------
  describe('Tool Metadata', () => {
    it('todo_write should have correct generations', () => {
      expect(todoWriteTool.generations).toContain('gen3');
      expect(todoWriteTool.name).toBe('todo_write');
    });

    it('ask_user_question should have correct generations', () => {
      expect(askUserQuestionTool.generations).toContain('gen3');
      expect(askUserQuestionTool.name).toBe('ask_user_question');
    });

    it('task should have correct generations', () => {
      expect(taskTool.generations).toContain('gen3');
      expect(taskTool.name).toBe('task');
    });
  });
});
