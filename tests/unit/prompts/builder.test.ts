// ============================================================================
// Prompt Builder Tests
// ============================================================================
//
// Tests for the system prompt builder module.
// Tests cover:
// - Building the system prompt
// - Pre-built SYSTEM_PROMPT cache
// - Prompt structure validation
// - Dynamic prompt building
// - Path-specific rules
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  buildPrompt,
  SYSTEM_PROMPT,
  getPromptForTask,
  buildDynamicPrompt,
  buildDynamicPromptV2,
  buildPromptWithRules,
} from '../../../src/main/prompts/builder';
import { TOOLS_PROMPT } from '../../../src/main/prompts/base';
import {
  BASH_TOOL_DESCRIPTION,
  EDIT_TOOL_DESCRIPTION,
  TASK_TOOL_DESCRIPTION,
} from '../../../src/main/prompts/tools';

describe('Prompt Builder', () => {
  // --------------------------------------------------------------------------
  // buildPrompt
  // --------------------------------------------------------------------------
  describe('buildPrompt', () => {
    it('should build a valid prompt', () => {
      const prompt = buildPrompt();
      expect(prompt).toBeDefined();
      expect(typeof prompt).toBe('string');
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('should include identity in prompt', () => {
      const prompt = buildPrompt();
      expect(prompt).toContain('Code Agent');
    });

    it('should include base TOOLS_PROMPT', () => {
      const prompt = buildPrompt();
      expect(prompt).toContain(TOOLS_PROMPT);
    });

    it('should include bash tool description', () => {
      const prompt = buildPrompt();
      expect(prompt).toContain(BASH_TOOL_DESCRIPTION);
    });

    it('should include edit tool description', () => {
      const prompt = buildPrompt();
      expect(prompt).toContain(EDIT_TOOL_DESCRIPTION);
    });

    it('should include task tool description', () => {
      const prompt = buildPrompt();
      expect(prompt).toContain(TASK_TOOL_DESCRIPTION);
    });

    it('should return consistent results across calls', () => {
      const prompt1 = buildPrompt();
      const prompt2 = buildPrompt();
      expect(prompt1).toBe(prompt2);
    });

    it('should build prompt in consistent order', () => {
      const prompt = buildPrompt();
      const toolsPromptContent = TOOLS_PROMPT.substring(0, 50);
      const toolsPromptStart = prompt.indexOf(toolsPromptContent);
      expect(toolsPromptStart).toBeGreaterThan(-1);
    });
  });

  // --------------------------------------------------------------------------
  // SYSTEM_PROMPT (pre-built cache)
  // --------------------------------------------------------------------------
  describe('SYSTEM_PROMPT', () => {
    it('should be pre-built and available', () => {
      expect(SYSTEM_PROMPT).toBeDefined();
      expect(typeof SYSTEM_PROMPT).toBe('string');
    });

    it('should be non-empty', () => {
      expect(SYSTEM_PROMPT.length).toBeGreaterThan(0);
    });

    it('should match buildPrompt output', () => {
      expect(SYSTEM_PROMPT).toBe(buildPrompt());
    });

    it('should be a stable reference', () => {
      const ref1 = SYSTEM_PROMPT;
      const ref2 = SYSTEM_PROMPT;
      expect(ref1).toBe(ref2);
    });
  });

  // --------------------------------------------------------------------------
  // getPromptForTask
  // --------------------------------------------------------------------------
  describe('getPromptForTask', () => {
    it('should return the system prompt', () => {
      const prompt = getPromptForTask();
      expect(prompt).toBe(SYSTEM_PROMPT);
    });
  });

  // --------------------------------------------------------------------------
  // Prompt Structure
  // --------------------------------------------------------------------------
  describe('Prompt Structure', () => {
    it('should have reasonable size', () => {
      const prompt = buildPrompt();
      expect(prompt.length).toBeGreaterThan(1000);
      expect(prompt.length).toBeLessThan(100000);
    });

    it('should include identity components', () => {
      const prompt = buildPrompt();
      expect(prompt).toContain('Code Agent');
    });

    it('should have substantial content', () => {
      const prompt = buildPrompt();
      expect(prompt.length).toBeGreaterThan(2000);
    });
  });

  // --------------------------------------------------------------------------
  // Dynamic Prompt Building
  // --------------------------------------------------------------------------
  describe('buildDynamicPrompt', () => {
    it('should return a DynamicPromptResult', () => {
      const result = buildDynamicPrompt('fix a bug in main.ts');
      expect(result).toHaveProperty('systemPrompt');
      expect(result).toHaveProperty('userMessage');
      expect(result).toHaveProperty('features');
      expect(result).toHaveProperty('mode');
      expect(result).toHaveProperty('modeConfig');
    });

    it('should use the system prompt as base', () => {
      const result = buildDynamicPrompt('fix a bug');
      expect(result.systemPrompt).toBe(SYSTEM_PROMPT);
    });

    it('should include the task in the user message', () => {
      const task = 'add a new feature to the parser';
      const result = buildDynamicPrompt(task);
      expect(result.userMessage).toContain(task);
    });
  });

  // --------------------------------------------------------------------------
  // Dynamic Prompt Building V2
  // --------------------------------------------------------------------------
  describe('buildDynamicPromptV2', () => {
    it('should return a DynamicPromptResultV2', () => {
      const result = buildDynamicPromptV2('refactor the auth module');
      expect(result).toHaveProperty('systemPrompt');
      expect(result).toHaveProperty('userMessage');
      expect(result).toHaveProperty('features');
      expect(result).toHaveProperty('mode');
      expect(result).toHaveProperty('modeConfig');
      expect(result).toHaveProperty('reminderStats');
      expect(result).toHaveProperty('tokensUsed');
      expect(result).toHaveProperty('tokenBudget');
    });

    it('should use the system prompt as base', () => {
      const result = buildDynamicPromptV2('fix a bug');
      expect(result.systemPrompt).toBe(SYSTEM_PROMPT);
    });

    it('should accept options', () => {
      const result = buildDynamicPromptV2('write tests', {
        toolsUsedInTurn: ['Read', 'Edit'],
        iterationCount: 3,
        hasError: false,
        maxReminderTokens: 500,
      });
      expect(result.tokenBudget).toBe(500);
    });
  });

  // --------------------------------------------------------------------------
  // buildPromptWithRules
  // --------------------------------------------------------------------------
  describe('buildPromptWithRules', () => {
    it('should return base prompt when no rules loaded', () => {
      const prompt = buildPromptWithRules([]);
      expect(prompt).toBe(buildPrompt());
    });

    it('should return base prompt for empty file list', () => {
      const prompt = buildPromptWithRules([]);
      expect(prompt).toBe(buildPrompt());
    });

    it('should return base prompt when no rules match', () => {
      // Without loadRules being called, cachedRules is null
      const prompt = buildPromptWithRules(['some/file.ts']);
      expect(prompt).toBe(buildPrompt());
    });
  });

  // --------------------------------------------------------------------------
  // Performance
  // --------------------------------------------------------------------------
  describe('Performance', () => {
    it('should build prompt quickly', () => {
      const start = Date.now();
      buildPrompt();
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(100);
    });

    it('should use cached SYSTEM_PROMPT for performance', () => {
      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        const _ = SYSTEM_PROMPT;
      }
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(10);
    });

    it('should handle repeated buildPrompt calls', () => {
      const start = Date.now();
      for (let i = 0; i < 100; i++) {
        buildPrompt();
      }
      const duration = Date.now() - start;
      expect(duration).toBeLessThan(500);
    });
  });
});
