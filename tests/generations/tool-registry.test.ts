// ============================================================================
// Tool Registry Tests
// Tests the tool registry functionality
// ============================================================================

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock isolated-vm (causes Node version issues in tests)
vi.mock('isolated-vm', () => ({}));

import { ToolRegistry } from '../../src/main/tools/toolRegistry';

describe('ToolRegistry', () => {
  let registry: ToolRegistry;

  beforeEach(() => {
    registry = new ToolRegistry();
  });

  // --------------------------------------------------------------------------
  // Basic Functionality Tests
  // --------------------------------------------------------------------------
  describe('Basic Functionality', () => {
    it('should initialize with all tools registered', () => {
      const tools = registry.getAllTools();
      expect(tools.length).toBeGreaterThan(0);
    });

    it('should get tool by name', () => {
      const bash = registry.get('Bash');
      expect(bash).toBeDefined();
      expect(bash?.name).toBe('Bash');
    });

    it('should return undefined for unknown tool', () => {
      const unknown = registry.get('nonexistent_tool');
      expect(unknown).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Gen1 Tools Tests
  // --------------------------------------------------------------------------
  describe('Gen1 Tools', () => {
    it('should have bash tool', () => {
      const tool = registry.get('Bash');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('Bash');
    });

    it('should have read_file tool', () => {
      const tool = registry.get('Read');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('Read');
    });

    it('should have write_file tool', () => {
      const tool = registry.get('Write');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('Write');
    });

    it('should have edit_file tool', () => {
      const tool = registry.get('Edit');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('Edit');
    });
  });

  // --------------------------------------------------------------------------
  // Gen2 Tools Tests
  // --------------------------------------------------------------------------
  describe('Gen2 Tools', () => {
    it('should have glob tool', () => {
      const tool = registry.get('Glob');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('Glob');
    });

    it('should have grep tool', () => {
      const tool = registry.get('Grep');
      expect(tool).toBeDefined();
      expect(tool?.name).toBe('Grep');
    });

    it('should have list_directory tool', () => {
      const tool = registry.get('list_directory');
      expect(tool).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Gen3 Tools Tests
  // --------------------------------------------------------------------------
  describe('Gen3 Tools', () => {
    it('should have task tool', () => {
      const tool = registry.get('task');
      expect(tool).toBeDefined();
    });

    it('should have todo_write tool', () => {
      const tool = registry.get('todo_write');
      expect(tool).toBeDefined();
    });

    it('should have ask_user_question tool', () => {
      // ask_user_question is aliased or renamed to AskUserQuestion
      const tool = registry.get('AskUserQuestion');
      expect(tool).toBeDefined();
    });

    it('should have plan_read tool', () => {
      const tool = registry.get('plan_read');
      expect(tool).toBeDefined();
    });

    it('should have plan_update tool', () => {
      const tool = registry.get('plan_update');
      expect(tool).toBeDefined();
    });

    it('should have findings_write tool', () => {
      const tool = registry.get('findings_write');
      expect(tool).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Gen4 Tools Tests
  // --------------------------------------------------------------------------
  describe('Gen4 Tools', () => {
    it('should have skill tool', () => {
      const tool = registry.get('skill');
      expect(tool).toBeDefined();
    });

    it('should have web_fetch tool', () => {
      const tool = registry.get('web_fetch');
      expect(tool).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Gen5 Tools Tests
  // --------------------------------------------------------------------------
  describe('Gen5 Tools', () => {
    it('should have memory tool (unified from memory_store + memory_search)', () => {
      const tool = registry.get('memory');
      expect(tool).toBeDefined();
      // Old names should resolve via aliases
      const viaAlias = registry.get('memory_store');
      expect(viaAlias).toBeDefined();
    });

    it('should have code_index tool', () => {
      const tool = registry.get('code_index');
      expect(tool).toBeDefined();
    });

    it('should have auto_learn tool', () => {
      const tool = registry.get('auto_learn');
      expect(tool).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Gen6 Tools Tests
  // --------------------------------------------------------------------------
  describe('Gen6 Tools', () => {
    it('should have screenshot tool', () => {
      const tool = registry.get('screenshot');
      expect(tool).toBeDefined();
    });

    it('should have computer_use tool', () => {
      const tool = registry.get('computer_use');
      expect(tool).toBeDefined();
    });

    it('should have browser_navigate tool', () => {
      const tool = registry.get('browser_navigate');
      expect(tool).toBeDefined();
    });

    it('should have browser_action tool', () => {
      const tool = registry.get('browser_action');
      expect(tool).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Gen7 Tools Tests
  // --------------------------------------------------------------------------
  describe('Gen7 Tools', () => {
    it('should have spawn_agent tool (via alias)', () => {
      // spawn_agent is aliased to AgentSpawn
      const tool = registry.get('spawn_agent');
      expect(tool).toBeDefined();
    });

    it('should have agent_message tool (via alias)', () => {
      const tool = registry.get('agent_message');
      expect(tool).toBeDefined();
    });

    it('should have workflow_orchestrate tool (via alias)', () => {
      const tool = registry.get('workflow_orchestrate');
      expect(tool).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Gen8 Tools Tests
  // --------------------------------------------------------------------------
  describe('Gen8 Tools', () => {
    it('should have strategy_optimize tool', () => {
      const tool = registry.get('strategy_optimize');
      expect(tool).toBeDefined();
    });

    it('should have tool_create tool', () => {
      const tool = registry.get('tool_create');
      expect(tool).toBeDefined();
    });

    it('should have self_evaluate tool', () => {
      const tool = registry.get('self_evaluate');
      expect(tool).toBeDefined();
    });

    it('should have learn_pattern tool', () => {
      const tool = registry.get('learn_pattern');
      expect(tool).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // Generation Filtering Tests
  // --------------------------------------------------------------------------
  describe('Generation Filtering', () => {
    it('should filter tools for gen1', () => {
      const tools = registry.getForGeneration('gen1');
      // Gen1 includes: bash, read_file, write_file, edit_file, kill_shell, task_output, notebook_edit, lsp
      expect(tools.length).toBeGreaterThanOrEqual(4);
    });

    it('should filter tools for gen3', () => {
      const tools = registry.getForGeneration('gen3');
      // gen1 (4) + gen2 (3) + gen3 (6) = 13 or more
      expect(tools.length).toBeGreaterThanOrEqual(10);
    });

    it('should filter tools for gen8', () => {
      const tools = registry.getForGeneration('gen8');
      // Should have the most tools
      expect(tools.length).toBeGreaterThanOrEqual(25);
    });

    it('all generations return same tools (gen8)', () => {
      const gen1Tools = registry.getForGeneration('gen1');
      const gen4Tools = registry.getForGeneration('gen4');
      const gen8Tools = registry.getForGeneration('gen8');

      // All return gen8 tools after simplification
      expect(gen1Tools.length).toBe(gen8Tools.length);
      expect(gen4Tools.length).toBe(gen8Tools.length);
    });
  });

  // --------------------------------------------------------------------------
  // Tool Definitions Tests
  // --------------------------------------------------------------------------
  describe('Tool Definitions', () => {
    it('should get tool definitions for generation', () => {
      const definitions = registry.getToolDefinitions('gen1');
      // Gen1 includes base tools plus utility tools
      expect(definitions.length).toBeGreaterThanOrEqual(4);

      for (const def of definitions) {
        expect(def.name).toBeDefined();
        expect(def.description).toBeDefined();
        expect(def.inputSchema).toBeDefined();
      }
    });

    it('all tools should have valid input schema', () => {
      const tools = registry.getAllTools();

      for (const tool of tools) {
        expect(tool.inputSchema).toBeDefined();
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema.properties).toBeDefined();
      }
    });

    it('all tools should have execute function', () => {
      const tools = registry.getAllTools();

      for (const tool of tools) {
        expect(typeof tool.execute).toBe('function');
      }
    });
  });

  // --------------------------------------------------------------------------
  // Permission Tests
  // --------------------------------------------------------------------------
  describe('Permission Levels', () => {
    it('bash should require permission', () => {
      const tool = registry.get('bash');
      expect(tool?.requiresPermission).toBe(true);
      expect(tool?.permissionLevel).toBe('execute');
    });

    it('read_file should not require high permission', () => {
      const tool = registry.get('read_file');
      expect(tool?.permissionLevel).toBe('read');
    });

    it('write_file should require write permission', () => {
      const tool = registry.get('write_file');
      expect(tool?.permissionLevel).toBe('write');
    });

    it('computer_use tools should require permission', () => {
      const screenshot = registry.get('screenshot');
      const computerUse = registry.get('computer_use');

      expect(screenshot?.requiresPermission).toBe(true);
      expect(computerUse?.requiresPermission).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Tool Registration Tests
  // --------------------------------------------------------------------------
  describe('Tool Registration', () => {
    it('should allow registering new tools', () => {
      const customTool = {
        name: 'custom_tool',
        description: 'A custom test tool',
        // generations removed in Sprint 2
        requiresPermission: false,
        permissionLevel: 'read' as const,
        inputSchema: {
          type: 'object' as const,
          properties: {},
        },
        execute: async () => ({ success: true, output: 'custom output' }),
      };

      registry.register(customTool);

      const retrieved = registry.get('custom_tool');
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('custom_tool');
    });
  });
});
