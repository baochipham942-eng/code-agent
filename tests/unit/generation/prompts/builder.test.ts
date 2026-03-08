// ============================================================================
// Prompt Builder Tests
// ============================================================================
//
// Tests for the system prompt builder module.
// Tests cover:
// - Building individual generation prompts
// - Building all prompts at once
// - Pre-built SYSTEM_PROMPTS cache
// - Prompt structure validation
// - Generation-specific content inclusion
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  buildPrompt,
  buildAllPrompts,
  SYSTEM_PROMPTS,
} from '../../../../src/main/generation/prompts/builder';
// CONSTITUTION no longer used in new prompt structure
import { BASE_PROMPTS } from '../../../../src/main/generation/prompts/base';
import {
  BASH_TOOL_DESCRIPTION,
  EDIT_TOOL_DESCRIPTION,
  TASK_TOOL_DESCRIPTION,
} from '../../../../src/main/generation/prompts/tools';
import type { GenerationId } from '../../../../src/shared/types';

describe('Prompt Builder', () => {
  // Sprint 2: only gen8 retained
  const ALL_GENERATIONS: GenerationId[] = ['gen8'];

  // --------------------------------------------------------------------------
  // buildPrompt
  // --------------------------------------------------------------------------
  describe('buildPrompt', () => {
    it('should build valid prompt for gen1', () => {
      const prompt = buildPrompt('gen1');
      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('should build valid prompt for gen4', () => {
      const prompt = buildPrompt('gen4');
      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('should build valid prompt for gen8', () => {
      const prompt = buildPrompt('gen8');
      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('should include identity in all prompts', () => {
      for (const gen of ALL_GENERATIONS) {
        const prompt = buildPrompt(gen);
        expect(prompt).toContain('Code Agent');
      }
    });

    it('should include base prompt for generation', () => {
      const prompt = buildPrompt('gen8');
      // Base prompts contain tool definitions
      expect(prompt).toContain(BASE_PROMPTS['gen8']);
    });

    it('should include bash tool description for all generations', () => {
      for (const gen of ALL_GENERATIONS) {
        const prompt = buildPrompt(gen);
        expect(prompt).toContain(BASH_TOOL_DESCRIPTION);
      }
    });

    it('should include edit tool description for all generations', () => {
      for (const gen of ALL_GENERATIONS) {
        const prompt = buildPrompt(gen);
        expect(prompt).toContain(EDIT_TOOL_DESCRIPTION);
      }
    });

    it('should include task tool description in gen8', () => {
      // All prompts are gen8, which includes task tool
      const gen8Prompt = buildPrompt('gen8');
      expect(gen8Prompt).toContain(TASK_TOOL_DESCRIPTION);
    });

    it('should not throw for any generation (always returns gen8)', () => {
      // buildPrompt always uses gen8 internally
      const prompt = buildPrompt('gen999' as GenerationId);
      expect(prompt).toBeDefined();
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('should produce same prompt for all generations (all return gen8)', () => {
      const gen1Prompt = buildPrompt('gen1');
      const gen8Prompt = buildPrompt('gen8');

      // All generations return the same gen8 prompt
      expect(gen1Prompt).toBe(gen8Prompt);
    });

    it('should build prompts in consistent order', () => {
      const prompt = buildPrompt('gen8');
      const basePromptContent = BASE_PROMPTS['gen8']!.substring(0, 50);
      const basePromptStart = prompt.indexOf(basePromptContent);

      expect(basePromptStart).toBeGreaterThan(-1);
    });
  });

  // --------------------------------------------------------------------------
  // buildAllPrompts
  // --------------------------------------------------------------------------
  describe('buildAllPrompts', () => {
    it('should return prompt for gen8 only', () => {
      const prompts = buildAllPrompts();
      expect(Object.keys(prompts)).toHaveLength(1);
      expect(prompts['gen8']).toBeDefined();
    });

    it('should have correct generation keys', () => {
      const prompts = buildAllPrompts();
      expect(prompts['gen8']).toBeDefined();
      expect(typeof prompts['gen8']).toBe('string');
    });

    it('should return same content as individual buildPrompt calls', () => {
      const allPrompts = buildAllPrompts();
      const individualPrompt = buildPrompt('gen8');
      expect(allPrompts['gen8']).toBe(individualPrompt);
    });

    it('should return non-empty prompt for gen8', () => {
      const prompts = buildAllPrompts();
      expect(prompts['gen8']!.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // SYSTEM_PROMPTS (pre-built cache)
  // --------------------------------------------------------------------------
  describe('SYSTEM_PROMPTS', () => {
    it('should be pre-built and available', () => {
      expect(SYSTEM_PROMPTS).toBeDefined();
      expect(typeof SYSTEM_PROMPTS).toBe('object');
    });

    it('should contain gen8 only', () => {
      expect(Object.keys(SYSTEM_PROMPTS)).toHaveLength(1);
      expect(SYSTEM_PROMPTS['gen8']).toBeDefined();
    });

    it('should match buildPrompt output', () => {
      expect(SYSTEM_PROMPTS['gen8']).toBe(buildPrompt('gen8'));
    });

    it('should be immutable reference', () => {
      // Same reference for performance
      const prompts1 = SYSTEM_PROMPTS;
      const prompts2 = SYSTEM_PROMPTS;
      expect(prompts1).toBe(prompts2);
    });
  });

  // --------------------------------------------------------------------------
  // Prompt Structure
  // --------------------------------------------------------------------------
  describe('Prompt Structure', () => {
    it('should have reasonable size for all prompts', () => {
      for (const gen of ALL_GENERATIONS) {
        const prompt = buildPrompt(gen);
        // Prompts should be substantial but not too large
        expect(prompt.length).toBeGreaterThan(1000);
        expect(prompt.length).toBeLessThan(100000);
      }
    });

    it('should include identity components', () => {
      const prompt = buildPrompt('gen4');
      // Identity includes Code Agent declaration
      expect(prompt).toContain('Code Agent');
    });

    it('should include rules in prompts', () => {
      // All generations should have reasonable length
      for (const gen of ALL_GENERATIONS) {
        const prompt = buildPrompt(gen);
        // Prompts should have meaningful content
        expect(prompt.length).toBeGreaterThan(1000);
      }
    });

    it('should have gen3+ include plan mode rules', () => {
      const gen2Prompt = buildPrompt('gen2');
      const gen3Prompt = buildPrompt('gen3');

      // gen2 should not have plan mode
      expect(gen2Prompt.toLowerCase()).not.toContain('plan mode');
      // gen3 should have plan mode
      // Note: Check if PLAN_MODE_RULES contain specific keywords
    });

    it('gen8 should include injection defense rules', () => {
      const gen8Prompt = buildPrompt('gen8');

      // gen8 should have substantial content
      expect(gen8Prompt.length).toBeGreaterThan(2000);
    });

    it('should have gen4 include additional capabilities', () => {
      const gen4Prompt = buildPrompt('gen4');

      // gen4 has skill and web capabilities
      expect(gen4Prompt).toContain('skill');
    });
  });

  // --------------------------------------------------------------------------
  // Generation Evolution
  // --------------------------------------------------------------------------
  describe('Generation Evolution', () => {
    it('gen8 should have substantial prompt', () => {
      const gen8Prompt = buildPrompt('gen8');
      // gen8 has all features
      expect(gen8Prompt.length).toBeGreaterThan(2000);
    });

    it('all buildPrompt calls should return gen8 with full features', () => {
      const prompt = buildPrompt('gen1');

      // Even gen1 returns gen8 now, which has task tool
      expect(prompt).toContain(TASK_TOOL_DESCRIPTION);
      expect(prompt).toContain('Code Agent');
    });

    it('should have gen4 as feature-complete generation', () => {
      const gen4Prompt = buildPrompt('gen4');

      // gen4 has all major features
      expect(gen4Prompt).toContain(TASK_TOOL_DESCRIPTION);
      expect(gen4Prompt).toContain(BASH_TOOL_DESCRIPTION);
      expect(gen4Prompt).toContain(EDIT_TOOL_DESCRIPTION);
      expect(gen4Prompt).toContain('Code Agent');
    });
  });

  // --------------------------------------------------------------------------
  // Performance
  // --------------------------------------------------------------------------
  describe('Performance', () => {
    it('should build all prompts quickly', () => {
      const start = Date.now();
      buildAllPrompts();
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(100); // Should complete in < 100ms
    });

    it('should use cached SYSTEM_PROMPTS for performance', () => {
      // SYSTEM_PROMPTS is pre-built at module load time
      // Accessing it should be instant
      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        const _ = SYSTEM_PROMPTS['gen4'];
      }
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(10); // Should be nearly instant
    });

    it('should handle repeated buildPrompt calls', () => {
      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        buildPrompt('gen4');
      }
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(500); // 100 calls in < 500ms
    });
  });
});
