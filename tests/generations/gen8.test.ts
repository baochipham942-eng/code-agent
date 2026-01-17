// ============================================================================
// Gen8 Tests - 自我进化期 (Self-Evolution Era)
// Tests: strategy_optimize, tool_create, self_evaluate, learn_pattern
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Import tools
import { strategyOptimizeTool } from '../../src/main/tools/gen8/strategyOptimize';
import { toolCreateTool, getDynamicTools } from '../../src/main/tools/gen8/toolCreate';
import { selfEvaluateTool, getPerformanceHistory } from '../../src/main/tools/gen8/selfEvaluate';
import { learnPatternTool, getLearnedPatterns, getReliablePatterns } from '../../src/main/tools/gen8/learnPattern';

// Mock memory services
vi.mock('../../src/main/memory/MemoryService', () => ({
  getMemoryService: () => ({
    saveProjectKnowledge: vi.fn(),
    searchKnowledge: vi.fn().mockResolvedValue([]),
    getProjectKnowledge: vi.fn().mockReturnValue(null),
  }),
}));

vi.mock('../../src/main/memory/VectorStore', () => ({
  getVectorStore: () => ({
    addKnowledge: vi.fn().mockResolvedValue(undefined),
    search: vi.fn().mockResolvedValue([]),
  }),
}));

// Mock context
const createMockContext = (workingDirectory: string) => ({
  workingDirectory,
  generation: { id: 'gen8' as const },
  requestPermission: async () => true,
  emit: () => {},
});

describe('Gen8 - Self-Evolution Era', () => {
  let testDir: string;
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen8-test-'));
    context = createMockContext(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Strategy Optimize Tool Tests
  // --------------------------------------------------------------------------
  describe('strategy_optimize', () => {
    it('should have correct metadata', () => {
      expect(strategyOptimizeTool.generations).toContain('gen8');
      expect(strategyOptimizeTool.name).toBe('strategy_optimize');
    });

    it('should require action parameter', async () => {
      const result = await strategyOptimizeTool.execute(
        {},
        context
      );

      expect(result.success).toBe(false);
    });

    it('should list strategies', async () => {
      const result = await strategyOptimizeTool.execute(
        { action: 'list' },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should create strategy', async () => {
      const result = await strategyOptimizeTool.execute(
        {
          action: 'create',
          name: 'Bug Fix Strategy',
          description: 'Steps to fix bugs efficiently',
          steps: [
            'Reproduce the bug',
            'Identify root cause',
            'Write failing test',
            'Fix the code',
            'Verify fix passes',
          ],
          tags: ['bug', 'fix', 'debug'],
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('Bug Fix Strategy');
    });

    it('should require name, description, and steps for create', async () => {
      const result = await strategyOptimizeTool.execute(
        {
          action: 'create',
          name: 'Incomplete Strategy',
        },
        context
      );

      expect(result.success).toBe(false);
    });

    it('should record feedback', async () => {
      // First create a strategy
      const createResult = await strategyOptimizeTool.execute(
        {
          action: 'create',
          name: 'Test Strategy',
          description: 'Test description',
          steps: ['Step 1', 'Step 2'],
        },
        context
      );

      // Extract strategy ID from output
      const idMatch = createResult.output?.match(/ID: (strategy_\w+)/);
      const strategyId = idMatch ? idMatch[1] : null;

      if (strategyId) {
        const feedbackResult = await strategyOptimizeTool.execute(
          {
            action: 'feedback',
            strategyId,
            success: true,
            duration: 5000,
            notes: 'Worked well',
          },
          context
        );

        expect(feedbackResult.success).toBe(true);
      }
    });

    it('should recommend strategies for task', async () => {
      const result = await strategyOptimizeTool.execute(
        {
          action: 'recommend',
          task: 'Fix a memory leak bug',
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should analyze strategy', async () => {
      // Create and then analyze
      const createResult = await strategyOptimizeTool.execute(
        {
          action: 'create',
          name: 'Analysis Strategy',
          description: 'For analysis test',
          steps: ['Step 1'],
          tags: ['test'],
        },
        context
      );

      const idMatch = createResult.output?.match(/ID: (strategy_\w+)/);
      const strategyId = idMatch ? idMatch[1] : null;

      if (strategyId) {
        const analyzeResult = await strategyOptimizeTool.execute(
          {
            action: 'analyze',
            strategyId,
          },
          context
        );

        expect(analyzeResult.success).toBe(true);
      }
    });

    it('should delete strategy', async () => {
      // Create and then delete
      const createResult = await strategyOptimizeTool.execute(
        {
          action: 'create',
          name: 'Delete Strategy',
          description: 'For deletion test',
          steps: ['Step 1'],
        },
        context
      );

      const idMatch = createResult.output?.match(/ID: (strategy_\w+)/);
      const strategyId = idMatch ? idMatch[1] : null;

      if (strategyId) {
        const deleteResult = await strategyOptimizeTool.execute(
          {
            action: 'delete',
            strategyId,
          },
          context
        );

        expect(deleteResult.success).toBe(true);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Tool Create Tool Tests
  // --------------------------------------------------------------------------
  describe('tool_create', () => {
    it('should have correct metadata', () => {
      expect(toolCreateTool.generations).toContain('gen8');
      expect(toolCreateTool.name).toBe('tool_create');
      expect(toolCreateTool.requiresPermission).toBe(true);
    });

    it('should require action parameter', async () => {
      const result = await toolCreateTool.execute(
        {},
        context
      );

      expect(result.success).toBe(false);
    });

    it('should list dynamic tools', async () => {
      const result = await toolCreateTool.execute(
        { action: 'list' },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should create bash_script tool', async () => {
      const result = await toolCreateTool.execute(
        {
          action: 'create',
          name: 'count_files',
          description: 'Count files in directory',
          type: 'bash_script',
          config: {
            script: 'find . -type f | wc -l',
          },
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should validate tool name format', async () => {
      const result = await toolCreateTool.execute(
        {
          action: 'create',
          name: 'Invalid Name With Spaces',
          description: 'Test',
          type: 'bash_script',
          config: { script: 'echo test' },
        },
        context
      );

      expect(result.success).toBe(false);
    });

    it('should create http_api tool', async () => {
      const result = await toolCreateTool.execute(
        {
          action: 'create',
          name: 'fetch_api_data',
          description: 'Fetch data from API',
          type: 'http_api',
          config: {
            url: 'https://api.example.com/data',
            method: 'GET',
          },
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should create file_processor tool', async () => {
      const result = await toolCreateTool.execute(
        {
          action: 'create',
          name: 'md_stats',
          description: 'Get markdown file statistics',
          type: 'file_processor',
          config: {
            pattern: '*.md',
            operation: 'aggregate',
          },
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should execute created tool', async () => {
      // First create a tool
      await toolCreateTool.execute(
        {
          action: 'create',
          name: 'test_echo',
          description: 'Echo test',
          type: 'bash_script',
          config: { script: 'echo "hello"' },
        },
        context
      );

      // Then execute it
      const result = await toolCreateTool.execute(
        {
          action: 'execute',
          toolId: 'test_echo',
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should delete dynamic tool', async () => {
      // Create and then delete
      await toolCreateTool.execute(
        {
          action: 'create',
          name: 'delete_me',
          description: 'To be deleted',
          type: 'bash_script',
          config: { script: 'echo delete' },
        },
        context
      );

      const result = await toolCreateTool.execute(
        {
          action: 'delete',
          toolId: 'delete_me',
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should get dynamic tools list', () => {
      const tools = getDynamicTools();
      expect(Array.isArray(tools)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Self Evaluate Tool Tests
  // --------------------------------------------------------------------------
  describe('self_evaluate', () => {
    it('should have correct metadata', () => {
      expect(selfEvaluateTool.generations).toContain('gen8');
      expect(selfEvaluateTool.name).toBe('self_evaluate');
    });

    it('should require action parameter', async () => {
      const result = await selfEvaluateTool.execute(
        {},
        context
      );

      expect(result.success).toBe(false);
    });

    it('should record task metrics', async () => {
      const result = await selfEvaluateTool.execute(
        {
          action: 'record',
          taskType: 'bug_fix',
          success: true,
          duration: 120000,
          iterations: 5,
          toolsUsed: ['read_file', 'edit_file', 'bash'],
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should analyze performance', async () => {
      const result = await selfEvaluateTool.execute(
        { action: 'analyze' },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should get insights', async () => {
      const result = await selfEvaluateTool.execute(
        { action: 'insights' },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should compare performance periods', async () => {
      const result = await selfEvaluateTool.execute(
        {
          action: 'compare',
          period: 24,
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should get performance history', () => {
      const history = getPerformanceHistory();
      expect(Array.isArray(history)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Learn Pattern Tool Tests
  // --------------------------------------------------------------------------
  describe('learn_pattern', () => {
    it('should have correct metadata', () => {
      expect(learnPatternTool.generations).toContain('gen8');
      expect(learnPatternTool.name).toBe('learn_pattern');
    });

    it('should require action parameter', async () => {
      const result = await learnPatternTool.execute(
        {},
        context
      );

      expect(result.success).toBe(false);
    });

    it('should learn success pattern', async () => {
      const result = await learnPatternTool.execute(
        {
          action: 'learn',
          type: 'success',
          name: 'Effective Debugging',
          pattern: 'Read error first, then check related files',
          context: 'bug_fix',
          confidence: 0.8,
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should learn failure pattern', async () => {
      const result = await learnPatternTool.execute(
        {
          action: 'learn',
          type: 'failure',
          name: 'Avoid Multiple File Edits',
          pattern: 'Editing many files at once leads to errors',
          context: 'refactoring',
          confidence: 0.7,
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should learn optimization pattern', async () => {
      const result = await learnPatternTool.execute(
        {
          action: 'learn',
          type: 'optimization',
          name: 'Parallel Tool Calls',
          pattern: 'Run independent tool calls in parallel',
          context: 'performance',
          confidence: 0.9,
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should search patterns', async () => {
      const result = await learnPatternTool.execute(
        {
          action: 'search',
          query: 'debugging',
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should list all patterns', async () => {
      const result = await learnPatternTool.execute(
        { action: 'list' },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should apply pattern by query', async () => {
      // First learn a pattern
      await learnPatternTool.execute(
        {
          action: 'learn',
          type: 'success',
          name: 'Apply Test Pattern',
          pattern: 'Apply test pattern description',
          context: 'apply_test',
          confidence: 0.8,
        },
        context
      );

      // Apply patterns by query
      const applyResult = await learnPatternTool.execute(
        {
          action: 'apply',
          query: 'apply_test',
        },
        context
      );

      expect(applyResult.success).toBe(true);
    });

    it('should get learned patterns', () => {
      const patterns = getLearnedPatterns();
      expect(Array.isArray(patterns)).toBe(true);
    });

    it('should get reliable patterns', () => {
      const reliable = getReliablePatterns();
      expect(Array.isArray(reliable)).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Tool Metadata Tests
  // --------------------------------------------------------------------------
  describe('Tool Metadata', () => {
    it('all gen8 tools should be gen8 only', () => {
      const gen8Tools = [strategyOptimizeTool, toolCreateTool, selfEvaluateTool, learnPatternTool];

      for (const tool of gen8Tools) {
        expect(tool.generations).toContain('gen8');
        expect(tool.generations.length).toBe(1);
      }
    });

    it('tool_create should require permission', () => {
      expect(toolCreateTool.requiresPermission).toBe(true);
      expect(toolCreateTool.permissionLevel).toBe('execute');
    });
  });

  // --------------------------------------------------------------------------
  // Integration Tests
  // --------------------------------------------------------------------------
  describe('Self-Evolution Integration', () => {
    it('should support complete self-improvement loop', async () => {
      // 1. Create a strategy
      const strategyResult = await strategyOptimizeTool.execute(
        {
          action: 'create',
          name: 'Quick Fix Strategy',
          description: 'Fast bug fix approach',
          steps: ['Identify', 'Fix', 'Test'],
          tags: ['fix', 'quick'],
        },
        context
      );
      expect(strategyResult.success).toBe(true);

      // 2. Learn a pattern
      const patternResult = await learnPatternTool.execute(
        {
          action: 'learn',
          type: 'success',
          name: 'Quick Fix Success',
          pattern: 'Quick fixes work for simple bugs',
          context: 'bug_fix',
          confidence: 0.7,
        },
        context
      );
      expect(patternResult.success).toBe(true);

      // 3. Record evaluation
      const evalResult = await selfEvaluateTool.execute(
        {
          action: 'record',
          taskType: 'bug_fix',
          success: true,
          duration: 30000,
          iterations: 2,
          toolsUsed: ['read_file', 'edit_file'],
        },
        context
      );
      expect(evalResult.success).toBe(true);

      // 4. Get insights
      const insightsResult = await selfEvaluateTool.execute(
        { action: 'insights' },
        context
      );
      expect(insightsResult.success).toBe(true);
    });
  });
});
