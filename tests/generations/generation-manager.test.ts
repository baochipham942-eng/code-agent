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
    it('should initialize with default generation (gen8)', () => {
      const current = manager.getCurrentGeneration();
      expect(current.id).toBe('gen8');
    });

    it('should get all generations', () => {
      const generations = manager.getAllGenerations();
      // Sprint 2: only gen8 retained
      expect(generations.length).toBe(1);

      const ids = generations.map(g => g.id);
      expect(ids).toContain('gen8');
    });

    it('should get generation by ID', () => {
      const gen8 = manager.getGeneration('gen8');
      expect(gen8).toBeDefined();
      expect(gen8?.id).toBe('gen8');
      expect(gen8?.name).toBe('自我进化期');
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
    it('should switch to gen1 (returns gen8)', () => {
      // switchGeneration always returns gen8 after Sprint 2 simplification
      const gen = manager.switchGeneration('gen1');
      expect(gen.id).toBe('gen8');
      expect(manager.getCurrentGeneration().id).toBe('gen8');
    });

    it('should switch to gen8', () => {
      const gen = manager.switchGeneration('gen8');
      expect(gen.id).toBe('gen8');
      expect(manager.getCurrentGeneration().id).toBe('gen8');
    });

    it('should not throw for any generation (always returns gen8)', () => {
      // switchGeneration always returns gen8, no throwing
      const gen = manager.switchGeneration('gen99' as any);
      expect(gen.id).toBe('gen8');
    });

    it('should always return gen8 regardless of input', () => {
      const genIds = ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'] as const;

      for (const id of genIds) {
        const gen = manager.switchGeneration(id);
        expect(gen.id).toBe('gen8');
        expect(manager.getCurrentGeneration().id).toBe('gen8');
      }
    });
  });

  // --------------------------------------------------------------------------
  // Generation Properties Tests
  // --------------------------------------------------------------------------
  describe('Generation Properties', () => {
    it('gen8 should contain all tool categories', () => {
      const gen = manager.getGeneration('gen8');
      expect(gen?.version).toBe('v8.0');
      // gen8 contains all tools from all previous generations
      expect(gen?.tools).toContain('bash');
      expect(gen?.tools).toContain('read_file');
      expect(gen?.tools).toContain('glob');
      expect(gen?.tools).toContain('grep');
      expect(gen?.tools).toContain('task');
      expect(gen?.tools).toContain('skill');
      expect(gen?.tools).toContain('memory_store');
      expect(gen?.tools).toContain('screenshot');
      expect(gen?.tools).toContain('spawn_agent');
    });

    it('gen1-gen7 should not exist', () => {
      for (const id of ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7'] as const) {
        expect(manager.getGeneration(id)).toBeUndefined();
      }
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

    it('gen8 prompt should contain memory system description', () => {
      // All prompts now return gen8 content
      const prompt = manager.getPrompt('gen5');
      expect(prompt).toContain('memory');
    });

    it('gen8 prompt should contain advanced tool descriptions', () => {
      const prompt = manager.getPrompt('gen8');
      // v0.16.18 prompt 重构后，gen8 使用精简 prompt
      expect(prompt).toContain('task');
      expect(prompt).toContain('edit_file');
    });

    it('should not throw for any generation prompt (returns gen8)', () => {
      // getPrompt always returns gen8 prompt
      const prompt = manager.getPrompt('gen99' as any);
      expect(prompt).toBeDefined();
      expect(prompt.length).toBeGreaterThan(100);
    });

    it('all prompts should contain identity and tool descriptions', () => {
      const genIds = ['gen1', 'gen2', 'gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'] as const;

      for (const id of genIds) {
        const prompt = manager.getPrompt(id);
        // v0.16.18 prompt 重构后，所有 prompt 包含 identity + bash 工具描述
        expect(prompt).toContain('bash');
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

    it('should return gen8 tools for any generation', () => {
      // getGenerationTools always returns gen8 tools
      const tools = manager.getGenerationTools('gen99' as any);
      expect(tools.length).toBeGreaterThan(0);
      expect(tools).toContain('bash');
    });

    it('all generations return same tools (gen8)', () => {
      const gen1Tools = manager.getGenerationTools('gen1');
      const gen4Tools = manager.getGenerationTools('gen4');
      const gen8Tools = manager.getGenerationTools('gen8');

      // All return gen8 tools
      expect(gen1Tools.length).toBe(gen8Tools.length);
      expect(gen4Tools.length).toBe(gen8Tools.length);
    });
  });

  // --------------------------------------------------------------------------
  // Generation Comparison Tests
  // --------------------------------------------------------------------------
  describe('Generation Comparison', () => {
    it('compareGenerations removed after gen simplification', () => {
      // compareGenerations method removed in Sprint 2
      expect((manager as any).compareGenerations).toBeUndefined();
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

    it('gen8 should have valid metadata', () => {
      const gen8 = manager.getGeneration('gen8');

      expect(gen8!.promptMetadata.lineCount).toBeGreaterThan(0);
      expect(gen8!.promptMetadata.toolCount).toBeGreaterThan(0);
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
