// ============================================================================
// Unit Tests for Telemetry Module - Intent Classifier
// ============================================================================

import { describe, it, expect } from 'vitest';
import { classifyIntent, evaluateOutcome } from '../src/host/telemetry/intentClassifier';
import type { QualitySignals } from '../src/shared/contract/telemetry';

// ============================================================================
// Test Suite: classifyIntent
// ============================================================================

describe('classifyIntent', () => {
  describe('short-conversation fast path', () => {
    it('classifies a short greeting as conversation with high confidence, bypassing rule scoring', () => {
      const result = classifyIntent('你好');

      expect(result.primary).toBe('conversation');
      expect(result.confidence).toBe(0.9);
      expect(result.method).toBe('rule');
      expect(result.keywords).toEqual(['你好']);
    });

    it('does not take the fast path once tools were used, even for a short prompt', () => {
      const result = classifyIntent('你好', ['Read']);

      // Falls through to rule scoring instead of the hardcoded 0.9 greeting confidence
      expect(result.confidence).not.toBe(0.9);
    });
  });

  describe('single-keyword rule matches', () => {
    it('classifies code_generation from an implementation verb', () => {
      const result = classifyIntent('帮我实现一个新功能');

      expect(result.primary).toBe('code_generation');
      expect(result.keywords).toContain('实现');
    });

    it('classifies bug_fix and accumulates score across multiple matched keywords', () => {
      const result = classifyIntent('这段代码有 bug，需要修复');

      expect(result.primary).toBe('bug_fix');
      expect(result.keywords).toEqual(expect.arrayContaining(['修复', 'bug']));
    });

    it('classifies code_review', () => {
      const result = classifyIntent('审查这段代码');

      expect(result.primary).toBe('code_review');
      expect(result.keywords).toContain('审查');
    });

    it('classifies explanation', () => {
      const result = classifyIntent('这个函数不工作，为什么');

      expect(result.primary).toBe('explanation');
      expect(result.keywords).toContain('为什么');
    });

    it('classifies search', () => {
      const result = classifyIntent('查找这个函数的定义');

      expect(result.primary).toBe('search');
      expect(result.keywords).toContain('查找');
    });

    it('classifies documentation from overlapping keywords', () => {
      const result = classifyIntent('补充这部分的注释说明');

      expect(result.primary).toBe('documentation');
      expect(result.keywords).toEqual(expect.arrayContaining(['注释', '说明']));
    });

    it('classifies configuration', () => {
      const result = classifyIntent('安装依赖并配置环境变量');

      expect(result.primary).toBe('configuration');
      expect(result.keywords).toEqual(expect.arrayContaining(['配置', '安装']));
    });

    it('classifies planning', () => {
      const result = classifyIntent('设计系统架构');

      expect(result.primary).toBe('planning');
      expect(result.keywords).toEqual(expect.arrayContaining(['设计', '架构']));
    });
  });

  describe('cross-category keyword overlap', () => {
    it('picks research over planning when "方案" is shared but research also matches "调研"', () => {
      const result = classifyIntent('帮我调研一下这个方案');

      expect(result.primary).toBe('research');
      expect(result.secondary).toBe('planning');
    });
  });

  describe('tool heuristics', () => {
    it('classifies from a tool alone when no keyword in the prompt matches any rule', () => {
      // Deliberately keyword-free (verified against every INTENT_RULES keyword list)
      // so the only signal is the Write tool heuristic bonus.
      const result = classifyIntent('The quick brown fox jumps over the lazy dog', ['Write']);

      expect(result.primary).toBe('code_generation');
      expect(result.keywords).toEqual(['[tool:Write]']);
    });

    it('stacks a matched keyword with its rule tool heuristic, and surfaces the runner-up as secondary', () => {
      // '重构' only scores refactoring; Edit is a tool heuristic for BOTH refactoring and
      // bug_fix, so bug_fix enters the score map purely off the tool bonus.
      const result = classifyIntent('重构这个模块', ['Edit']);

      expect(result.primary).toBe('refactoring');
      expect(result.keywords).toEqual(expect.arrayContaining(['重构', '[tool:Edit]']));
      expect(result.secondary).toBe('bug_fix');
    });

    it('classifies file_operation from a keyword plus its Bash tool bonus, testing loses out on tool bonus alone', () => {
      const result = classifyIntent('删除这个旧文件', ['Bash']);

      expect(result.primary).toBe('file_operation');
      expect(result.secondary).toBe('testing');
    });
  });

  describe('multi-tool bonus', () => {
    it('boosts multi_step_task when more than 3 tools spanning more than 2 distinct types were used', () => {
      const result = classifyIntent('首先执行第一步，然后执行第二步骤', ['Grep', 'Glob', 'WebSearch', 'Task']);

      expect(result.primary).toBe('multi_step_task');
      expect(result.keywords).toEqual(expect.arrayContaining(['首先', '然后', '步骤', '[multi-tool]']));
    });

    it('does not apply the multi-tool bonus for 3 or fewer tools', () => {
      const result = classifyIntent('首先做第一步', ['Grep', 'Glob', 'Task']);

      expect(result.keywords).not.toContain('[multi-tool]');
    });

    it('does not apply the multi-tool bonus when tools repeat the same type', () => {
      const result = classifyIntent('首先做第一步', ['Bash', 'Bash', 'Bash', 'Bash']);

      expect(result.keywords).not.toContain('[multi-tool]');
    });
  });

  describe('URL fallback', () => {
    it('classifies a bare URL prompt as research via the URL-in-prompt bonus', () => {
      const result = classifyIntent('https://example.com/article 这个东西');

      expect(result.primary).toBe('research');
      expect(result.keywords).toContain('[url-in-prompt]');
    });
  });

  describe('unknown / empty input', () => {
    it('returns unknown with low fixed confidence when nothing matches', () => {
      const result = classifyIntent('zzzzz xxxxx yyyyy');

      expect(result.primary).toBe('unknown');
      expect(result.confidence).toBe(0.3);
      expect(result.keywords).toEqual([]);
      expect(result.secondary).toBeUndefined();
    });

    it('returns unknown for an empty prompt', () => {
      const result = classifyIntent('');

      expect(result.primary).toBe('unknown');
      expect(result.confidence).toBe(0.3);
    });
  });

  describe('confidence bounds', () => {
    it('always returns confidence within [0, 0.95]', () => {
      const prompts: Array<[string, string[]]> = [
        ['帮我实现一个新功能', []],
        ['这段代码有 bug，需要修复', []],
        ['zzzzz xxxxx yyyyy', []],
        ['你好', []],
      ];
      for (const [prompt, tools] of prompts) {
        const result = classifyIntent(prompt, tools);
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(0.95);
      }
    });
  });
});

// ============================================================================
// Test Suite: evaluateOutcome
// ============================================================================

function signals(overrides: Partial<QualitySignals>): QualitySignals {
  return {
    toolSuccessRate: 1,
    toolCallCount: 1,
    retryCount: 0,
    errorCount: 0,
    errorRecovered: 0,
    compactionTriggered: false,
    circuitBreakerTripped: false,
    nudgesInjected: 0,
    ...overrides,
  };
}

describe('evaluateOutcome', () => {
  it('returns unknown when no tools were called (pure conversation)', () => {
    const s = signals({ toolCallCount: 0, toolSuccessRate: 0 });
    const result = evaluateOutcome(s);

    expect(result.status).toBe('unknown');
    expect(result.confidence).toBe(0.5);
    expect(result.method).toBe('rule');
    expect(result.signals).toBe(s);
  });

  it('returns failure when the circuit breaker tripped, even with a perfect success rate', () => {
    const s = signals({ toolCallCount: 3, toolSuccessRate: 1, errorCount: 0, circuitBreakerTripped: true });
    const result = evaluateOutcome(s);

    expect(result.status).toBe('failure');
    expect(result.confidence).toBe(0.9);
  });

  it('returns success when all tools succeeded with zero errors', () => {
    const s = signals({ toolCallCount: 2, toolSuccessRate: 1, errorCount: 0 });
    const result = evaluateOutcome(s);

    expect(result.status).toBe('success');
    expect(result.confidence).toBe(0.85);
  });

  it('does not return success if the success rate is 1 but errors were still recorded', () => {
    // Exercises the `errorCount === 0` guard specifically: a naive rewrite
    // that only checked toolSuccessRate === 1 would misclassify this as success.
    const s = signals({ toolCallCount: 3, toolSuccessRate: 1, errorCount: 1 });
    const result = evaluateOutcome(s);

    expect(result.status).toBe('partial');
    expect(result.confidence).toBe(0.7);
  });

  it('returns partial when the success rate is at or above 0.5 but below 1', () => {
    const s = signals({ toolCallCount: 4, toolSuccessRate: 0.5, errorCount: 2 });
    const result = evaluateOutcome(s);

    expect(result.status).toBe('partial');
    expect(result.confidence).toBe(0.7);
  });

  it('returns failure when the success rate drops below 0.5', () => {
    const s = signals({ toolCallCount: 5, toolSuccessRate: 0.2, errorCount: 4 });
    const result = evaluateOutcome(s);

    expect(result.status).toBe('failure');
    expect(result.confidence).toBe(0.75);
  });

  it('echoes the input signals back unchanged on every branch', () => {
    const s = signals({ toolCallCount: 2, toolSuccessRate: 1, errorCount: 0, retryCount: 3, nudgesInjected: 2 });
    const result = evaluateOutcome(s);

    expect(result.signals).toEqual(s);
  });
});
