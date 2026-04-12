// ============================================================================
// AgentModelPolicy Tests
// Tests for per-agent-type model selection with budget awareness
// ============================================================================

import { describe, it, expect } from 'vitest';
import { selectAgentModel } from '../../../src/main/agent/agentModelPolicy';
import type { AgentModelSelection } from '../../../src/main/agent/agentModelPolicy';

describe('selectAgentModel', () => {
  // --------------------------------------------------------------------------
  // Known agent types — default config
  // --------------------------------------------------------------------------
  describe('known agent types return correct defaults', () => {
    it('Code Explorer → moonshot / kimi-k2.5', () => {
      const result = selectAgentModel('Code Explorer');
      expect(result.provider).toBe('moonshot');
      expect(result.model).toBe('kimi-k2.5');
      expect(result.reason).toBeTruthy();
    });

    it('Code Reviewer → deepseek / deepseek-reasoner', () => {
      const result = selectAgentModel('Code Reviewer');
      expect(result.provider).toBe('deepseek');
      expect(result.model).toBe('deepseek-reasoner');
    });

    it('Web Search → perplexity / sonar-pro', () => {
      const result = selectAgentModel('Web Search');
      expect(result.provider).toBe('perplexity');
      expect(result.model).toBe('sonar-pro');
    });

    it('Document Reader → zhipu / glm-4-flash', () => {
      const result = selectAgentModel('Document Reader');
      expect(result.provider).toBe('zhipu');
      expect(result.model).toBe('glm-4.7-flash');
    });

    it('Technical Writer → moonshot / kimi-k2.5', () => {
      const result = selectAgentModel('Technical Writer');
      expect(result.provider).toBe('moonshot');
      expect(result.model).toBe('kimi-k2.5');
    });

    it('Debugger → deepseek / deepseek-reasoner', () => {
      const result = selectAgentModel('Debugger');
      expect(result.provider).toBe('deepseek');
      expect(result.model).toBe('deepseek-reasoner');
    });
  });

  // --------------------------------------------------------------------------
  // Unknown agent type → fallback
  // --------------------------------------------------------------------------
  describe('unknown agent type returns fallback', () => {
    it('returns moonshot/kimi-k2.5 for unknown type', () => {
      const result = selectAgentModel('Some Unknown Agent');
      expect(result.provider).toBe('moonshot');
      expect(result.model).toBe('kimi-k2.5');
      expect(result.reason).toBe('default model for unknown agent type');
    });

    it('returns fallback even when no options provided', () => {
      const result = selectAgentModel('???');
      expect(result).toMatchObject<AgentModelSelection>({
        provider: 'moonshot',
        model: 'kimi-k2.5',
        reason: 'default model for unknown agent type',
      });
    });
  });

  // --------------------------------------------------------------------------
  // User override takes highest priority
  // --------------------------------------------------------------------------
  describe('user override', () => {
    it('user override wins over default for known type', () => {
      const result = selectAgentModel('Code Explorer', {
        userOverride: { 'Code Explorer': { provider: 'openai', model: 'gpt-4o' } },
      });
      expect(result.provider).toBe('openai');
      expect(result.model).toBe('gpt-4o');
      expect(result.reason).toBe('user override');
    });

    it('user override wins over budget constraint', () => {
      const result = selectAgentModel('Code Explorer', {
        budgetRemaining: 0.05,
        userOverride: { 'Code Explorer': { provider: 'anthropic', model: 'claude-3-5-haiku' } },
      });
      expect(result.provider).toBe('anthropic');
      expect(result.model).toBe('claude-3-5-haiku');
      expect(result.reason).toBe('user override');
    });

    it('override for one type does not affect another type', () => {
      const result = selectAgentModel('Debugger', {
        userOverride: { 'Code Explorer': { provider: 'openai', model: 'gpt-4o' } },
      });
      expect(result.provider).toBe('deepseek');
      expect(result.model).toBe('deepseek-reasoner');
    });
  });

  // --------------------------------------------------------------------------
  // Budget constraint
  // --------------------------------------------------------------------------
  describe('budget constraint', () => {
    it('budget < 0.2 → cheapest model', () => {
      const result = selectAgentModel('Code Explorer', { budgetRemaining: 0.1 });
      expect(result.provider).toBe('zhipu');
      expect(result.model).toBe('glm-4.7-flash');
      expect(result.reason).toContain('budget constraint');
    });

    it('budget at exactly 0.2 does NOT trigger budget constraint', () => {
      const result = selectAgentModel('Code Explorer', { budgetRemaining: 0.2 });
      expect(result.provider).toBe('moonshot');
      expect(result.model).toBe('kimi-k2.5');
    });

    it('budget at 0.19 triggers budget constraint', () => {
      const result = selectAgentModel('Code Explorer', { budgetRemaining: 0.19 });
      expect(result.provider).toBe('zhipu');
      expect(result.model).toBe('glm-4.7-flash');
    });

    it('budget = 0 triggers budget constraint', () => {
      const result = selectAgentModel('Web Search', { budgetRemaining: 0 });
      expect(result.provider).toBe('zhipu');
      expect(result.model).toBe('glm-4.7-flash');
    });

    it('budget constraint applies to unknown agent types too', () => {
      const result = selectAgentModel('Unknown Agent', { budgetRemaining: 0.05 });
      expect(result.provider).toBe('zhipu');
      expect(result.model).toBe('glm-4.7-flash');
    });
  });

  // --------------------------------------------------------------------------
  // reason field always populated
  // --------------------------------------------------------------------------
  describe('reason field is always populated', () => {
    it('reason is non-empty string for known types', () => {
      const result = selectAgentModel('Code Reviewer');
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    });

    it('reason is non-empty string for unknown types', () => {
      const result = selectAgentModel('XYZ');
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });
});
