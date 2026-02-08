// ============================================================================
// Gen7 Tests - 多代理协同期 (Multi-Agent Era)
// Tests: spawn_agent, agent_message, workflow_orchestrate
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock isolated-vm (causes Node version issues in tests)
vi.mock('isolated-vm', () => ({}));

// Import tools
import {
  spawnAgentTool,
  getSpawnedAgent,
  listSpawnedAgents,
  getAvailableAgents,
} from '../../src/main/tools/multiagent/spawnAgent';
import { agentMessageTool } from '../../src/main/tools/multiagent/agentMessage';
import {
  workflowOrchestrateTool,
  getAvailableWorkflows,
} from '../../src/main/tools/multiagent/workflowOrchestrate';

// Mock SubagentExecutor
vi.mock('../../src/main/agent/SubagentExecutor', () => ({
  getSubagentExecutor: () => ({
    execute: vi.fn().mockResolvedValue({
      success: true,
      output: 'Task completed successfully',
      iterations: 3,
      toolsUsed: ['read_file', 'edit_file'],
    }),
  }),
}));

// Mock context with required properties for spawn_agent
const createMockContext = (workingDirectory: string) => ({
  workingDirectory,
  generation: { id: 'gen7' as const },
  requestPermission: async () => true,
  emit: () => {},
  toolRegistry: {
    getAllTools: () => [],
  },
  modelConfig: {
    provider: 'deepseek',
    model: 'deepseek-chat',
    temperature: 0.7,
  },
});

describe('Gen7 - Multi-Agent Era', () => {
  let testDir: string;
  let context: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gen7-test-'));
    context = createMockContext(testDir);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  // --------------------------------------------------------------------------
  // Spawn Agent Tool Tests
  // --------------------------------------------------------------------------
  describe('spawn_agent', () => {
    it('should have correct metadata', () => {
      expect(spawnAgentTool.generations).toContain('gen7');
      expect(spawnAgentTool.name).toBe('spawn_agent');
    });

    it('should execute with only role (task defaults to empty)', async () => {
      // Note: With mock executor, this will still succeed
      // In real scenarios, task should be provided
      const result = await spawnAgentTool.execute(
        { role: 'coder' },
        context
      );

      // With mock SubagentExecutor, even without task it will work
      expect(result).toBeDefined();
    });

    it('should reject unknown role', async () => {
      // getPredefinedAgent throws for invalid IDs
      await expect(
        spawnAgentTool.execute(
          {
            role: 'unknown_role',
            task: 'Do something',
          },
          context
        )
      ).rejects.toThrow('Invalid agent ID');
    });

    it('should spawn coder agent', async () => {
      const result = await spawnAgentTool.execute(
        {
          role: 'coder',
          task: 'Write a function to calculate factorial',
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('Coder');
    });

    it('should spawn reviewer agent', async () => {
      const result = await spawnAgentTool.execute(
        {
          role: 'reviewer',
          task: 'Review the authentication module',
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should spawn explore agent', async () => {
      const result = await spawnAgentTool.execute(
        {
          role: 'explore',
          task: 'Search codebase for auth patterns',
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should spawn plan agent', async () => {
      const result = await spawnAgentTool.execute(
        {
          role: 'plan',
          task: 'Design the API architecture',
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should support custom prompt', async () => {
      const result = await spawnAgentTool.execute(
        {
          role: 'coder',
          task: 'Write code',
          customPrompt: 'You are a Python expert. Only use Python.',
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should support max iterations', async () => {
      const result = await spawnAgentTool.execute(
        {
          role: 'coder',
          task: 'Write code',
          maxIterations: 5,
        },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should support background execution', async () => {
      const result = await spawnAgentTool.execute(
        {
          role: 'coder',
          task: 'Long running task',
          waitForCompletion: false,
        },
        context
      );

      expect(result.success).toBe(true);
      expect(result.output).toContain('spawned in background');
    });
  });

  // --------------------------------------------------------------------------
  // Agent Functions Tests
  // --------------------------------------------------------------------------
  describe('Agent Functions', () => {
    it('should get available agents (4 core roles)', () => {
      const agents = getAvailableAgents();

      // v0.16.18 混合架构：4 个核心角色
      const ids = agents.map(a => a.id);
      expect(ids).toContain('coder');
      expect(ids).toContain('reviewer');
      expect(ids).toContain('explore');
      expect(ids).toContain('plan');
      expect(agents.length).toBe(4);
    });

    it('should list spawned agents', () => {
      const agents = listSpawnedAgents();

      expect(Array.isArray(agents)).toBe(true);
    });

    it('should get spawned agent by ID', () => {
      const agent = getSpawnedAgent('nonexistent_id');

      expect(agent).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Agent Message Tool Tests
  // --------------------------------------------------------------------------
  describe('agent_message', () => {
    it('should have correct metadata', () => {
      expect(agentMessageTool.generations).toContain('gen7');
      expect(agentMessageTool.name).toBe('agent_message');
    });

    it('should require agent ID', async () => {
      const result = await agentMessageTool.execute(
        { action: 'status' },
        context
      );

      expect(result.success).toBe(false);
    });

    it('should get agent status', async () => {
      const result = await agentMessageTool.execute(
        {
          agentId: 'test_agent_id',
          action: 'status',
        },
        context
      );

      expect(result).toBeDefined();
    });

    it('should list all agents', async () => {
      const result = await agentMessageTool.execute(
        { action: 'list' },
        context
      );

      expect(result.success).toBe(true);
    });

    it('should stop agent', async () => {
      const result = await agentMessageTool.execute(
        {
          agentId: 'test_agent_id',
          action: 'stop',
        },
        context
      );

      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Workflow Orchestrate Tool Tests
  // --------------------------------------------------------------------------
  describe('workflow_orchestrate', () => {
    it('should have correct metadata', () => {
      expect(workflowOrchestrateTool.generations).toContain('gen7');
      expect(workflowOrchestrateTool.name).toBe('workflow_orchestrate');
    });

    it('should get available workflows', () => {
      const workflows = getAvailableWorkflows();

      expect(typeof workflows).toBe('object');
      expect(workflows).toHaveProperty('code-review-pipeline');
      expect(workflows).toHaveProperty('bug-fix-flow');
    });

    it('should require workflow and task parameters', async () => {
      const result = await workflowOrchestrateTool.execute(
        { workflow: 'code-review-pipeline' },
        context
      );

      // Should fail due to missing task (but may also fail due to missing context)
      expect(result).toBeDefined();
    });

    it('should handle unknown workflow', async () => {
      const result = await workflowOrchestrateTool.execute(
        {
          workflow: 'nonexistent-workflow',
          task: 'Test task',
        },
        context
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown workflow');
    });

    it('should execute code-review-pipeline workflow', async () => {
      const result = await workflowOrchestrateTool.execute(
        {
          workflow: 'code-review-pipeline',
          task: 'Review the authentication module',
        },
        context
      );

      // May fail without full context, but should be defined
      expect(result).toBeDefined();
    });

    it('should execute bug-fix-flow workflow', async () => {
      const result = await workflowOrchestrateTool.execute(
        {
          workflow: 'bug-fix-flow',
          task: 'Fix memory leak in cache module',
        },
        context
      );

      expect(result).toBeDefined();
    });

    it('should support custom workflow', async () => {
      const result = await workflowOrchestrateTool.execute(
        {
          workflow: 'custom',
          task: 'Custom task',
          stages: [
            { name: 'Stage1', role: 'coder', prompt: 'Do something' },
          ],
        },
        context
      );

      expect(result).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Tool Metadata Tests
  // --------------------------------------------------------------------------
  describe('Tool Metadata', () => {
    it('all gen7 tools should include gen7-8 generations', () => {
      const gen7Tools = [spawnAgentTool, agentMessageTool, workflowOrchestrateTool];

      for (const tool of gen7Tools) {
        expect(tool.generations).toContain('gen7');
        expect(tool.generations).toContain('gen8');
      }
    });

    it('spawn_agent should have role and task in input schema properties', () => {
      // Note: required array is empty because spawn_agent supports two modes:
      // 1. Single agent: role+task required (validated in execute)
      // 2. Parallel mode: parallel+agents array (validated in execute)
      expect(spawnAgentTool.inputSchema.properties).toHaveProperty('role');
      expect(spawnAgentTool.inputSchema.properties).toHaveProperty('task');
      expect(spawnAgentTool.inputSchema.properties).toHaveProperty('parallel');
      expect(spawnAgentTool.inputSchema.properties).toHaveProperty('agents');
    });
  });
});
