// ============================================================================
// Generation Manager Tests
// Tests the core generation management functionality
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import { GenerationManager } from '../../src/main/generation/GenerationManager';

describe('GenerationManager', () => {
  let manager: GenerationManager;

  beforeEach(() => {
    manager = new GenerationManager();
  });

  // --------------------------------------------------------------------------
  // Basic Functionality Tests
  // --------------------------------------------------------------------------
  describe('Basic Functionality', () => {
    it('should initialize with default generation (gen3)', () => {
      const current = manager.getCurrentGeneration();
      expect(current.id).toBe('gen3');
    });

    it('should get all generations', () => {
      const generations = manager.getAllGenerations();
      expect(generations.length).toBe(8);

      const ids = generations.map(g => g.id);
      expect(ids).toContain('gen1');
      expect(ids).toContain('gen2');
      expect(ids).toContain('gen3');
      expect(ids).toContain('gen4');
      expect(ids).toContain('gen5');
      expect(ids).toContain('gen6');
      expect(ids).toContain('gen7');
      expect(ids).toContain('gen8');
    });

    it('should get generation by ID', () => {
      const gen1 = manager.getGeneration('gen1');
      expect(gen1).toBeDefined();
      expect(gen1?.id).toBe('gen1');
      expect(gen1?.name).toBe('基础工具期');
    });

    it('should return undefined for invalid generation ID', () => {
      const invalid = manager.getGeneration('gen99' as any);
      expect(invalid).toBeUndefined();
    });
  });

  // --------------------------------------------------------------------------
  // Generation Switching Tests
  // --------------------------------------------------------------------------
  describe('Generation Switching', () => {
    it('should switch to gen1', () => {
      const gen = manager.switchGeneration('gen1');
      expect(gen.id).toBe('gen1');
      expect(manager.getCurrentGeneration().id).toBe('gen1');
    });

    it('should switch to gen8', () => {
      const gen = manager.switchGeneration('gen8');
      expect(gen.id).toBe('gen8');
      expect(manager.getCurrentGeneration().id).toBe('gen8');
    });

    it('should throw for invalid generation', () => {
      expect(() => manager.switchGeneration('gen99' as any)).toThrow('Unknown generation');
    });

    it('should switch through all generations', () => {
      const genIds = ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'] as const;

      for (const id of genIds) {
        const gen = manager.switchGeneration(id);
        expect(gen.id).toBe(id);
        expect(manager.getCurrentGeneration().id).toBe(id);
      }
    });
  });

  // --------------------------------------------------------------------------
  // Generation Properties Tests
  // --------------------------------------------------------------------------
  describe('Generation Properties', () => {
    it('gen1 should have correct properties', () => {
      const gen = manager.getGeneration('gen1');
      expect(gen?.version).toBe('v1.0');
      expect(gen?.tools).toContain('bash');
      expect(gen?.tools).toContain('read_file');
      expect(gen?.tools).toContain('write_file');
      expect(gen?.tools).toContain('edit_file');
      expect(gen?.tools.length).toBe(4);
    });

    it('gen2 should add search tools', () => {
      const gen = manager.getGeneration('gen2');
      expect(gen?.tools).toContain('glob');
      expect(gen?.tools).toContain('grep');
      expect(gen?.tools).toContain('list_directory');
    });

    it('gen3 should add planning tools', () => {
      const gen = manager.getGeneration('gen3');
      expect(gen?.tools).toContain('task');
      expect(gen?.tools).toContain('todo_write');
      expect(gen?.tools).toContain('ask_user_question');
    });

    it('gen4 should add skill and web tools', () => {
      const gen = manager.getGeneration('gen4');
      expect(gen?.tools).toContain('skill');
      expect(gen?.tools).toContain('web_fetch');
    });

    it('gen5 should add memory tools', () => {
      const gen = manager.getGeneration('gen5');
      expect(gen?.tools).toContain('memory_store');
      expect(gen?.tools).toContain('memory_search');
      expect(gen?.tools).toContain('code_index');
      expect(gen?.tools).toContain('auto_learn');
    });

    it('gen6 should add computer use tools', () => {
      const gen = manager.getGeneration('gen6');
      expect(gen?.tools).toContain('screenshot');
      expect(gen?.tools).toContain('computer_use');
      expect(gen?.tools).toContain('browser_navigate');
      expect(gen?.tools).toContain('browser_action');
    });

    it('gen7 should add multi-agent tools', () => {
      const gen = manager.getGeneration('gen7');
      expect(gen?.tools).toContain('spawn_agent');
      expect(gen?.tools).toContain('agent_message');
      expect(gen?.tools).toContain('workflow_orchestrate');
    });

    it('gen8 should add self-evolution tools', () => {
      const gen = manager.getGeneration('gen8');
      expect(gen?.tools).toContain('strategy_optimize');
      expect(gen?.tools).toContain('tool_create');
      expect(gen?.tools).toContain('self_evaluate');
      expect(gen?.tools).toContain('learn_pattern');
    });
  });

  // --------------------------------------------------------------------------
  // System Prompt Tests
  // --------------------------------------------------------------------------
  describe('System Prompts', () => {
    it('should get prompt for each generation', () => {
      const genIds = ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'] as const;

      for (const id of genIds) {
        const prompt = manager.getPrompt(id);
        expect(prompt).toBeDefined();
        expect(prompt.length).toBeGreaterThan(100);
      }
    });

    it('gen1 prompt should contain basic tool descriptions', () => {
      const prompt = manager.getPrompt('gen1');
      expect(prompt).toContain('bash');
      expect(prompt).toContain('read_file');
      expect(prompt).toContain('write_file');
      expect(prompt).toContain('edit_file');
    });

    it('gen5 prompt should contain memory system description', () => {
      const prompt = manager.getPrompt('gen5');
      expect(prompt).toContain('memory_store');
      expect(prompt).toContain('memory_search');
      expect(prompt).toContain('记忆');
    });

    it('gen8 prompt should contain self-evolution description', () => {
      const prompt = manager.getPrompt('gen8');
      expect(prompt).toContain('strategy_optimize');
      expect(prompt).toContain('自我进化');
    });

    it('should throw for invalid generation prompt', () => {
      expect(() => manager.getPrompt('gen99' as any)).toThrow('Unknown generation');
    });

    it('all prompts should contain HTML generation rules', () => {
      const genIds = ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'] as const;

      for (const id of genIds) {
        const prompt = manager.getPrompt(id);
        expect(prompt).toContain('HTML');
      }
    });
  });

  // --------------------------------------------------------------------------
  // Generation Tools Tests
  // --------------------------------------------------------------------------
  describe('Generation Tools', () => {
    it('should get tools for generation', () => {
      const tools = manager.getGenerationTools('gen1');
      expect(tools).toContain('bash');
      expect(tools).toContain('read_file');
    });

    it('should return empty array for invalid generation', () => {
      const tools = manager.getGenerationTools('gen99' as any);
      expect(tools).toEqual([]);
    });

    it('later generations should have more tools', () => {
      const gen1Tools = manager.getGenerationTools('gen1');
      const gen4Tools = manager.getGenerationTools('gen4');
      const gen8Tools = manager.getGenerationTools('gen8');

      expect(gen4Tools.length).toBeGreaterThan(gen1Tools.length);
      expect(gen8Tools.length).toBeGreaterThan(gen4Tools.length);
    });
  });

  // --------------------------------------------------------------------------
  // Generation Comparison Tests
  // --------------------------------------------------------------------------
  describe('Generation Comparison', () => {
    it('should compare two generations', () => {
      const diff = manager.compareGenerations('gen1', 'gen2');
      expect(diff).toHaveProperty('added');
      expect(diff).toHaveProperty('removed');
      expect(diff).toHaveProperty('modified');
    });

    it('should detect additions from gen1 to gen2', () => {
      const diff = manager.compareGenerations('gen1', 'gen2');
      // gen2 adds glob, grep, list_directory
      expect(diff.added.some(line => line.includes('glob'))).toBe(true);
    });

    it('should throw for invalid comparison', () => {
      expect(() => manager.compareGenerations('gen1', 'gen99' as any)).toThrow('Invalid generation');
    });
  });

  // --------------------------------------------------------------------------
  // Metadata Tests
  // --------------------------------------------------------------------------
  describe('Metadata', () => {
    it('each generation should have promptMetadata', () => {
      const generations = manager.getAllGenerations();

      for (const gen of generations) {
        expect(gen.promptMetadata).toBeDefined();
        expect(gen.promptMetadata.lineCount).toBeGreaterThan(0);
        expect(gen.promptMetadata.toolCount).toBeGreaterThan(0);
        expect(gen.promptMetadata.ruleCount).toBeGreaterThan(0);
      }
    });

    it('metadata should increase with generations', () => {
      const gen1 = manager.getGeneration('gen1');
      const gen8 = manager.getGeneration('gen8');

      expect(gen8!.promptMetadata.lineCount).toBeGreaterThan(gen1!.promptMetadata.lineCount);
      expect(gen8!.promptMetadata.toolCount).toBeGreaterThan(gen1!.promptMetadata.toolCount);
    });

    it('each generation should have description', () => {
      const generations = manager.getAllGenerations();

      for (const gen of generations) {
        expect(gen.description).toBeDefined();
        expect(gen.description.length).toBeGreaterThan(10);
      }
    });
  });
});
