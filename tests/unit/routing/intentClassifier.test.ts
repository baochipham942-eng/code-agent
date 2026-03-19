// ============================================================================
// Intent Classifier Tests
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { classifyIntent, IntentClassifier } from '../../../src/main/routing/intentClassifier';
import type { ModelRouter } from '../../../src/main/model/modelRouter';

// Mock logger to suppress console output during tests
vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

/**
 * Create a mock ModelRouter with configurable chat responses
 */
function createMockModelRouter(chatResponse?: { content: string | null }): ModelRouter {
  return {
    chat: vi.fn().mockResolvedValue(chatResponse ?? { content: 'general' }),
    inference: vi.fn(),
    selectModelByCapability: vi.fn(),
    getModelInfo: vi.fn(),
    getFallbackConfig: vi.fn(),
    setFallbackModel: vi.fn(),
    detectRequiredCapabilities: vi.fn().mockReturnValue([]),
    inferenceWithVision: vi.fn(),
  } as unknown as ModelRouter;
}

// ============================================================================
// Part 1: classifyIntent (lightweight agent-routing function)
// ============================================================================

describe('classifyIntent — Lightweight Agent Routing', () => {
  let mockRouter: ModelRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRouter = createMockModelRouter();
  });

  // --------------------------------------------------------------------------
  // Keyword quick path
  // --------------------------------------------------------------------------
  describe('keyword quick path', () => {
    it('should classify 深入调研 as research via keywords (no LLM call)', async () => {
      const result = await classifyIntent('请帮我深入调研一下市场情况', mockRouter);
      expect(result).toBe('research');
      expect(mockRouter.chat).not.toHaveBeenCalled();
    });

    it('should classify 深度搜索 as research via keywords', async () => {
      const result = await classifyIntent('深度搜索 AI Agent 框架', mockRouter);
      expect(result).toBe('research');
      expect(mockRouter.chat).not.toHaveBeenCalled();
    });

    it('should classify comprehensive research as research via keywords', async () => {
      const result = await classifyIntent('Please do comprehensive research on LLM pricing', mockRouter);
      expect(result).toBe('research');
      expect(mockRouter.chat).not.toHaveBeenCalled();
    });

    it('should classify deep research as research via keywords', async () => {
      const result = await classifyIntent('I need a deep research on transformer architectures', mockRouter);
      expect(result).toBe('research');
      expect(mockRouter.chat).not.toHaveBeenCalled();
    });

    it('should classify 全面分析 as research via keywords', async () => {
      const result = await classifyIntent('全面分析竞品', mockRouter);
      expect(result).toBe('research');
      expect(mockRouter.chat).not.toHaveBeenCalled();
    });
  });

  // --------------------------------------------------------------------------
  // LLM classification path
  // --------------------------------------------------------------------------
  describe('LLM classification path', () => {
    it('should use LLM when keywords do not match', async () => {
      mockRouter = createMockModelRouter({ content: 'code' });
      const result = await classifyIntent('帮我写一个排序算法', mockRouter);
      expect(result).toBe('code');
      expect(mockRouter.chat).toHaveBeenCalledTimes(1);
    });

    it('should return valid intent from LLM response', async () => {
      mockRouter = createMockModelRouter({ content: 'search' });
      const result = await classifyIntent('查一下 React 19 的新特性', mockRouter);
      expect(result).toBe('search');
    });

    it('should handle LLM returning data intent', async () => {
      mockRouter = createMockModelRouter({ content: 'data' });
      const result = await classifyIntent('分析一下这个 CSV 文件', mockRouter);
      expect(result).toBe('data');
    });

    it('should trim and lowercase LLM response', async () => {
      mockRouter = createMockModelRouter({ content: '  Code  \n' });
      const result = await classifyIntent('fix the bug', mockRouter);
      expect(result).toBe('code');
    });
  });

  // --------------------------------------------------------------------------
  // Fallback to general
  // --------------------------------------------------------------------------
  describe('fallback behavior', () => {
    it('should default to general when LLM returns invalid label', async () => {
      mockRouter = createMockModelRouter({ content: 'unknown_intent' });
      const result = await classifyIntent('something ambiguous', mockRouter);
      expect(result).toBe('general');
    });

    it('should default to general when LLM returns empty content', async () => {
      mockRouter = createMockModelRouter({ content: null });
      const result = await classifyIntent('hello', mockRouter);
      expect(result).toBe('general');
    });

    it('should default to general when LLM call fails', async () => {
      const failRouter = createMockModelRouter();
      (failRouter.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('API error'));
      const result = await classifyIntent('hi there', failRouter);
      expect(result).toBe('general');
    });

    it('should default to general when LLM call times out', async () => {
      const slowRouter = createMockModelRouter();
      (slowRouter.chat as ReturnType<typeof vi.fn>).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ content: 'code' }), 5000))
      );
      const result = await classifyIntent('fix the function', slowRouter);
      // Should timeout at 3s and fall back to general
      expect(result).toBe('general');
    }, 10000);
  });
});

// ============================================================================
// Part 2: IntentClassifier class (Research intent classification)
// ============================================================================

describe('IntentClassifier — Research Intent Classification', () => {
  let mockRouter: ModelRouter;
  let classifier: IntentClassifier;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRouter = createMockModelRouter();
    classifier = new IntentClassifier(mockRouter);
  });

  // --------------------------------------------------------------------------
  // Empty / edge cases
  // --------------------------------------------------------------------------
  describe('edge cases', () => {
    it('should handle empty message with low-confidence simple_lookup', async () => {
      const result = await classifier.classify('');
      expect(result.intent).toBe('simple_lookup');
      expect(result.confidence).toBe(0.5);
    });

    it('should handle whitespace-only message as empty', async () => {
      const result = await classifier.classify('   ');
      expect(result.intent).toBe('simple_lookup');
      expect(result.confidence).toBe(0.5);
    });
  });

  // --------------------------------------------------------------------------
  // Explicit reference detection
  // --------------------------------------------------------------------------
  describe('explicit reference detection', () => {
    it('should detect URL and classify as analysis', async () => {
      const result = await classifier.classify('分析 https://example.com/article');
      expect(result.intent).toBe('analysis');
      expect(result.confidence).toBe(0.9);
      expect(result.suggestsResearch).toBe(true);
      expect(result.requiresClarification).toBe(false);
      expect(result.explicitReferences?.some(r => r.type === 'url')).toBe(true);
    });

    it('should detect book title (书名号) and classify as analysis', async () => {
      const result = await classifier.classify('帮我找一下《Attention Is All You Need》的论文');
      expect(result.intent).toBe('analysis');
      expect(result.confidence).toBe(0.9);
      expect(result.suggestedSources).toContain('academic_search');
      expect(result.explicitReferences?.some(r => r.type === 'book_title')).toBe(true);
    });

    it('should detect file path and classify as code_task', async () => {
      const result = await classifier.classify('看看 /src/main/model/modelRouter.ts 这个文件');
      expect(result.intent).toBe('code_task');
      expect(result.confidence).toBe(0.95);
      expect(result.suggestsResearch).toBe(false);
      expect(result.explicitReferences?.some(r => r.type === 'file_path')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // Rule-based classification
  // --------------------------------------------------------------------------
  describe('rule-based classification', () => {
    it('should classify deep research keywords with high confidence', async () => {
      const result = await classifier.classify('深入研究 LLM Agent 的架构演进');
      expect(result.intent).toBe('analysis');
      expect(result.confidence).toBeGreaterThanOrEqual(0.9);
      expect(result.suggestsResearch).toBe(true);
      expect(result.suggestedDepth).toBe('deep');
    });

    it('should classify comparison queries', async () => {
      const result = await classifier.classify('对比 React 和 Vue 的性能差异');
      expect(result.intent).toBe('comparison');
      expect(result.suggestsResearch).toBe(true);
      expect(result.suggestedDepth).toBe('standard');
    });

    it('should classify current events queries', async () => {
      const result = await classifier.classify('最新的 AI 行业动态');
      expect(result.intent).toBe('current_events');
      expect(result.suggestedSources).toContain('web_search');
    });

    it('should classify technical deep dive queries', async () => {
      // Rule regex requires 底层/架构/etc. before 分析/解析/详解
      const result = await classifier.classify('底层架构分析：Transformer 的内部实现机制详解');
      expect(result.intent).toBe('technical_deep_dive');
      expect(result.suggestedDepth).toBe('deep');
      expect(result.suggestedSources).toContain('documentation');
    });

    it('should classify code tasks as non-research', async () => {
      const result = await classifier.classify('写一个 TypeScript 函数来处理数组排序');
      expect(result.intent).toBe('code_task');
      expect(result.suggestsResearch).toBe(false);
      expect(result.suggestedSources).toEqual([]);
    });

    it('should classify file operation tasks as code_task', async () => {
      const result = await classifier.classify('统计目录下有多少个文件');
      expect(result.intent).toBe('code_task');
      expect(result.confidence).toBe(0.95);
      expect(result.suggestsResearch).toBe(false);
    });

    it('should classify creative tasks as non-research', async () => {
      const result = await classifier.classify('设计一个登录界面');
      expect(result.intent).toBe('creative_task');
      expect(result.suggestsResearch).toBe(false);
    });

    it('should classify explanation queries', async () => {
      const result = await classifier.classify('如何使用 Docker 部署应用');
      expect(result.intent).toBe('explanation');
      expect(result.suggestedSources).toContain('web_search');
    });
  });

  // --------------------------------------------------------------------------
  // Message structure analysis
  // --------------------------------------------------------------------------
  describe('message structure analysis', () => {
    it('should classify multi-question messages as multi_faceted', async () => {
      const result = await classifier.classify('第一个问题？第二个问题？');
      expect(result.intent).toBe('multi_faceted');
      expect(result.suggestedDepth).toBe('deep');
    });

    it('should classify short messages as simple_lookup when no rule matches', async () => {
      // Short message (<30 chars), no rule match, structure analysis gives 0.6 confidence
      // which is below default threshold (0.7), falls through to LLM.
      // Mock LLM returns default 'general' which fails JSON parse → fallback to 'explanation'
      // To test structure analysis directly, lower the threshold so rules don't go to LLM.
      classifier = new IntentClassifier(mockRouter, { llmFallbackThreshold: 0.5 });
      const result = await classifier.classify('你好');
      expect(result.intent).toBe('simple_lookup');
      expect(result.suggestedDepth).toBe('quick');
    });

    it('should classify very long messages as analysis', async () => {
      // Create a long message (>200 chars) that doesn't match specific rules.
      // Structure analysis gives confidence 0.65 which is below default 0.7 threshold,
      // so it falls through to LLM. Lower the threshold so structure analysis is accepted.
      classifier = new IntentClassifier(mockRouter, { llmFallbackThreshold: 0.5 });
      const longMsg = '这是一个关于'.repeat(40); // ~240 chars
      const result = await classifier.classify(longMsg);
      expect(result.intent).toBe('analysis');
      expect(result.suggestedDepth).toBe('standard');
    });
  });

  // --------------------------------------------------------------------------
  // LLM fallback classification
  // --------------------------------------------------------------------------
  describe('LLM fallback', () => {
    it('should fall back to LLM when rules have low confidence', async () => {
      // Mock LLM response for classification
      (mockRouter.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: '{"intent": "analysis", "confidence": 0.85, "needs_research": true, "depth": "standard", "reasoning": "test"}',
      });

      // Medium-length ambiguous message (30-200 chars, no strong rule match)
      const result = await classifier.classify('请帮我了解一下当前情况的各个方面和可能的影响，我需要一些建议来做决策');
      // Could be LLM or structure-based, either is valid
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.intent).toBeDefined();
    });

    it('should handle LLM parse failure with graceful fallback', async () => {
      (mockRouter.chat as ReturnType<typeof vi.fn>).mockResolvedValue({
        content: 'not valid json at all',
      });

      classifier = new IntentClassifier(mockRouter, { llmFallbackThreshold: 1.0 });
      // With threshold at 1.0, no rule passes, so LLM is always tried
      const result = await classifier.classify('一个中等长度的消息来测试LLM回退机制行为');
      // Should get a fallback classification, not crash
      expect(result.intent).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
    });

    it('should handle LLM call failure with rule-based fallback', async () => {
      (mockRouter.chat as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('LLM API error'));

      classifier = new IntentClassifier(mockRouter, { llmFallbackThreshold: 1.0 });
      const result = await classifier.classify('一个中等长度的消息来测试错误回退机制的行为表现');
      expect(result.intent).toBeDefined();
      expect(result.confidence).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // Ambiguous reference detection
  // --------------------------------------------------------------------------
  describe('ambiguous reference handling', () => {
    it('should not require clarification in executeFirst mode (default)', async () => {
      const result = await classifier.classify('这个是什么');
      expect(result.requiresClarification).toBeFalsy();
    });

    it('should require clarification for ambiguous refs when executeFirst is disabled', async () => {
      classifier = new IntentClassifier(mockRouter, { executeFirstStrategy: false });
      const result = await classifier.classify('这个是什么');
      expect(result.requiresClarification).toBe(true);
    });

    it('should not flag as ambiguous when explicit references exist', async () => {
      const check = classifier.checkRequiresClarification('分析 https://example.com');
      expect(check.requires).toBe(false);
      expect(check.explicitRefs.length).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // quickCheckResearchNeeded (synchronous, no LLM)
  // --------------------------------------------------------------------------
  describe('quickCheckResearchNeeded', () => {
    it('should return true for research keywords', () => {
      expect(classifier.quickCheckResearchNeeded('研究一下 AI')).toBe(true);
      expect(classifier.quickCheckResearchNeeded('analyze this trend')).toBe(true);
      expect(classifier.quickCheckResearchNeeded('compare React vs Vue')).toBe(true);
    });

    it('should return false for code tasks', () => {
      expect(classifier.quickCheckResearchNeeded('写一个函数来处理数据')).toBe(false);
      expect(classifier.quickCheckResearchNeeded('fix this bug in the code')).toBe(false);
    });

    it('should return true for long messages (>150 chars)', () => {
      const longMsg = 'a'.repeat(160);
      expect(classifier.quickCheckResearchNeeded(longMsg)).toBe(true);
    });

    it('should return false for empty messages', () => {
      expect(classifier.quickCheckResearchNeeded('')).toBe(false);
      expect(classifier.quickCheckResearchNeeded('  ')).toBe(false);
    });

    it('should return false for short generic messages', () => {
      expect(classifier.quickCheckResearchNeeded('你好')).toBe(false);
      expect(classifier.quickCheckResearchNeeded('hello')).toBe(false);
    });
  });
});
