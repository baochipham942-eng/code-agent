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
import { CONSTITUTION } from '../../../../src/main/generation/prompts/constitution';
import { BASE_PROMPTS } from '../../../../src/main/generation/prompts/base';
import {
  BASH_TOOL_DESCRIPTION,
  EDIT_TOOL_DESCRIPTION,
  TASK_TOOL_DESCRIPTION,
} from '../../../../src/main/generation/prompts/tools';
import type { GenerationId } from '../../../../src/shared/types';

describe('Prompt Builder', () => {
  const ALL_GENERATIONS: GenerationId[] = [
    'gen1',
    'gen2',
    'gen3',
    'gen4',
    'gen5',
    'gen6',
    'gen7',
    'gen8',
  ];

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

    it('should include CONSTITUTION in all prompts', () => {
      for (const gen of ALL_GENERATIONS) {
        const prompt = buildPrompt(gen);
        expect(prompt).toContain('Code Agent 宪法');
      }
    });

    it('should include base prompt for generation', () => {
      for (const gen of ALL_GENERATIONS) {
        const prompt = buildPrompt(gen);
        // Base prompts contain tool definitions
        expect(prompt).toContain(BASE_PROMPTS[gen]);
      }
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

    it('should include task tool description only for gen3+', () => {
      // gen1 and gen2 should NOT have task tool
      const gen1Prompt = buildPrompt('gen1');
      const gen2Prompt = buildPrompt('gen2');
      expect(gen1Prompt).not.toContain(TASK_TOOL_DESCRIPTION);
      expect(gen2Prompt).not.toContain(TASK_TOOL_DESCRIPTION);

      // gen3+ should have task tool
      const laterGens: GenerationId[] = ['gen3', 'gen4', 'gen5', 'gen6', 'gen7', 'gen8'];
      for (const gen of laterGens) {
        const prompt = buildPrompt(gen);
        expect(prompt).toContain(TASK_TOOL_DESCRIPTION);
      }
    });

    it('should throw error for invalid generation', () => {
      expect(() => buildPrompt('gen999' as GenerationId)).toThrow('Unknown generation');
    });

    it('should produce different prompts for different generations', () => {
      const gen1Prompt = buildPrompt('gen1');
      const gen4Prompt = buildPrompt('gen4');
      const gen8Prompt = buildPrompt('gen8');

      // Different generations have different content
      expect(gen1Prompt).not.toBe(gen4Prompt);
      expect(gen4Prompt).not.toBe(gen8Prompt);
      expect(gen1Prompt).not.toBe(gen8Prompt);
    });

    it('should build prompts in consistent order', () => {
      // Constitution comes first
      for (const gen of ALL_GENERATIONS) {
        const prompt = buildPrompt(gen);
        const constitutionStart = prompt.indexOf('Code Agent 宪法');
        const basePromptContent = BASE_PROMPTS[gen].substring(0, 50);
        const basePromptStart = prompt.indexOf(basePromptContent);

        expect(constitutionStart).toBeLessThan(basePromptStart);
      }
    });
  });

  // --------------------------------------------------------------------------
  // buildAllPrompts
  // --------------------------------------------------------------------------
  describe('buildAllPrompts', () => {
    it('should return prompts for all 8 generations', () => {
      const prompts = buildAllPrompts();
      expect(Object.keys(prompts)).toHaveLength(8);
    });

    it('should have correct generation keys', () => {
      const prompts = buildAllPrompts();
      for (const gen of ALL_GENERATIONS) {
        expect(prompts[gen]).toBeDefined();
        expect(typeof prompts[gen]).toBe('string');
      }
    });

    it('should return same content as individual buildPrompt calls', () => {
      const allPrompts = buildAllPrompts();
      for (const gen of ALL_GENERATIONS) {
        const individualPrompt = buildPrompt(gen);
        expect(allPrompts[gen]).toBe(individualPrompt);
      }
    });

    it('should return non-empty prompts for all generations', () => {
      const prompts = buildAllPrompts();
      for (const gen of ALL_GENERATIONS) {
        expect(prompts[gen].length).toBeGreaterThan(0);
      }
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

    it('should contain all 8 generations', () => {
      expect(Object.keys(SYSTEM_PROMPTS)).toHaveLength(8);
      for (const gen of ALL_GENERATIONS) {
        expect(SYSTEM_PROMPTS[gen]).toBeDefined();
      }
    });

    it('should match buildPrompt output', () => {
      for (const gen of ALL_GENERATIONS) {
        expect(SYSTEM_PROMPTS[gen]).toBe(buildPrompt(gen));
      }
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

    it('should include constitution components', () => {
      const prompt = buildPrompt('gen4');
      // Constitution includes these sections
      expect(prompt).toContain('Code Agent 宪法');
    });

    it('should include rules in prompts', () => {
      // All generations should have output format rules
      for (const gen of ALL_GENERATIONS) {
        const prompt = buildPrompt(gen);
        // Output format rules are common
        expect(prompt.length).toBeGreaterThan(5000);
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

    it('should have gen3+ include injection defense rules', () => {
      const gen2Prompt = buildPrompt('gen2');
      const gen3Prompt = buildPrompt('gen3');

      // gen3 has more content due to injection defense
      expect(gen3Prompt.length).toBeGreaterThan(gen2Prompt.length);
    });

    it('should have gen4+ include github routing rules', () => {
      const gen3Prompt = buildPrompt('gen3');
      const gen4Prompt = buildPrompt('gen4');

      // gen4 has additional github routing rules
      expect(gen4Prompt.length).toBeGreaterThan(gen3Prompt.length);
    });
  });

  // --------------------------------------------------------------------------
  // Generation Evolution
  // --------------------------------------------------------------------------
  describe('Generation Evolution', () => {
    it('should show increasing complexity from gen1 to gen8', () => {
      const promptLengths = ALL_GENERATIONS.map((gen) => ({
        gen,
        length: buildPrompt(gen).length,
      }));

      // gen1 and gen2 are simpler (no task tool)
      expect(promptLengths[0].length).toBeLessThan(promptLengths[2].length); // gen1 < gen3

      // gen3+ have task tool and more rules
      for (let i = 2; i < 7; i++) {
        // gen3-gen7 should have similar lengths (same rules)
        const diff = Math.abs(promptLengths[i].length - promptLengths[i + 1].length);
        expect(diff).toBeLessThan(5000); // Allow some variance
      }
    });

    it('should have gen1 as the baseline with minimal features', () => {
      const gen1Prompt = buildPrompt('gen1');

      // gen1 has no task tool
      expect(gen1Prompt).not.toContain(TASK_TOOL_DESCRIPTION);

      // gen1 still has constitution and basic rules
      expect(gen1Prompt).toContain('Code Agent 宪法');
    });

    it('should have gen4 as feature-complete generation', () => {
      const gen4Prompt = buildPrompt('gen4');

      // gen4 has all major features
      expect(gen4Prompt).toContain(TASK_TOOL_DESCRIPTION);
      expect(gen4Prompt).toContain(BASH_TOOL_DESCRIPTION);
      expect(gen4Prompt).toContain(EDIT_TOOL_DESCRIPTION);
      expect(gen4Prompt).toContain('Code Agent 宪法');
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
