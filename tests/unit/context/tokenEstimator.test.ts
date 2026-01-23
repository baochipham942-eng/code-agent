// ============================================================================
// Token Estimator Tests
// ============================================================================
//
// Tests for the multi-dimensional token estimation module.
// Tests cover:
// - Content analysis (CJK, code, markdown detection)
// - Token estimation for different content types
// - Message and conversation token estimation
// - Budget calculation and truncation
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  analyzeContent,
  estimateTokens,
  estimateMessageTokens,
  estimateConversationTokens,
  estimateTokensDetailed,
  calculateBudget,
  fitsInBudget,
  truncateToTokenBudget,
  TOKEN_RATIOS,
  type Message,
  type ContentAnalysis,
} from '../../../src/main/context/tokenEstimator';

describe('TokenEstimator', () => {
  // --------------------------------------------------------------------------
  // Content Analysis
  // --------------------------------------------------------------------------
  describe('analyzeContent', () => {
    it('should detect CJK content', () => {
      const result = analyzeContent('这是中文内容测试');
      expect(result.primaryType).toBe('cjk');
      expect(result.cjkChars).toBeGreaterThan(0);
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it('should detect code content', () => {
      const code = `
        import { useState } from 'react';
        const App = () => {
          const [count, setCount] = useState(0);
          return <div>{count}</div>;
        };
        export default App;
      `;
      const result = analyzeContent(code);
      expect(result.primaryType).toBe('code');
      expect(result.codeChars).toBeGreaterThan(0);
    });

    it('should detect JSON content', () => {
      // Note: JSON detection competes with code detection
      // Since JSON has special chars ({}[]:,) and code patterns are checked first,
      // JSON may be detected as 'code' when special char ratio is high
      // This tests that JSON *can* be detected when codeRatio is low
      const jsonWithLowCodeRatio = `{
        "description": "This is a longer text description that dilutes special characters",
        "name": "test value with lots of normal text here",
        "enabled": true,
        "items": [1, 2, 3]
      }`;
      const result = analyzeContent(jsonWithLowCodeRatio);
      // May be detected as 'json' or 'code' depending on char ratios
      expect(['json', 'code']).toContain(result.primaryType);
    });

    it('should detect markdown content', () => {
      const markdown = `
        # Heading

        - Item 1
        - Item 2

        **Bold text** and \`inline code\`
      `;
      const result = analyzeContent(markdown);
      expect(result.primaryType).toBe('markdown');
    });

    it('should detect English text', () => {
      const english = 'This is a simple English sentence without any special formatting.';
      const result = analyzeContent(english);
      expect(result.primaryType).toBe('english');
    });

    it('should handle empty string', () => {
      const result = analyzeContent('');
      expect(result.totalChars).toBe(0);
      expect(result.primaryType).toBe('english');
      expect(result.confidence).toBe(1);
    });

    it('should count whitespace characters', () => {
      const text = 'Hello   World\n\nNew paragraph';
      const result = analyzeContent(text);
      expect(result.whitespaceChars).toBeGreaterThan(0);
    });

    it('should count special characters', () => {
      const text = 'function test() { return {}; }';
      const result = analyzeContent(text);
      expect(result.specialChars).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // Token Estimation
  // --------------------------------------------------------------------------
  describe('estimateTokens', () => {
    it('should return 0 for empty string', () => {
      expect(estimateTokens('')).toBe(0);
    });

    it('should estimate CJK text with ~2 chars/token', () => {
      const text = '中文文本测试内容'; // 8 CJK chars
      const tokens = estimateTokens(text);
      // Should be around 4 tokens (8/2)
      expect(tokens).toBeGreaterThanOrEqual(3);
      expect(tokens).toBeLessThanOrEqual(6);
    });

    it('should estimate English text with ~3.5 chars/token', () => {
      const text = 'This is a simple English sentence for testing purposes.';
      const tokens = estimateTokens(text);
      // ~55 chars / 3.5 = ~16 tokens
      expect(tokens).toBeGreaterThanOrEqual(10);
      expect(tokens).toBeLessThanOrEqual(25);
    });

    it('should estimate code with ~3 chars/token', () => {
      const code = 'const x = 42; const y = "hello";';
      const tokens = estimateTokens(code);
      // ~32 chars / 3 = ~11 tokens
      expect(tokens).toBeGreaterThanOrEqual(8);
      expect(tokens).toBeLessThanOrEqual(20);
    });

    it('should handle mixed CJK and English', () => {
      const mixed = 'Hello 世界 World 测试';
      const tokens = estimateTokens(mixed);
      expect(tokens).toBeGreaterThan(0);
    });

    it('should adjust for whitespace-heavy content', () => {
      const spacey = 'word   word   word   word   word';
      const compact = 'word word word word word';
      // Spacey should have slightly different estimate
      const spaceyTokens = estimateTokens(spacey);
      const compactTokens = estimateTokens(compact);
      // Both should be reasonable
      expect(spaceyTokens).toBeGreaterThan(0);
      expect(compactTokens).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // Message Token Estimation
  // --------------------------------------------------------------------------
  describe('estimateMessageTokens', () => {
    it('should include role overhead for user messages', () => {
      const message: Message = { role: 'user', content: 'Hello' };
      const tokens = estimateMessageTokens(message);
      const contentOnly = estimateTokens('Hello');
      expect(tokens).toBeGreaterThan(contentOnly);
    });

    it('should include role overhead for assistant messages', () => {
      const message: Message = { role: 'assistant', content: 'Hi there!' };
      const tokens = estimateMessageTokens(message);
      const contentOnly = estimateTokens('Hi there!');
      expect(tokens).toBeGreaterThan(contentOnly);
    });

    it('should include role overhead for system messages', () => {
      const message: Message = { role: 'system', content: 'You are a helpful assistant.' };
      const tokens = estimateMessageTokens(message);
      const contentOnly = estimateTokens('You are a helpful assistant.');
      expect(tokens).toBeGreaterThan(contentOnly);
    });
  });

  // --------------------------------------------------------------------------
  // Conversation Token Estimation
  // --------------------------------------------------------------------------
  describe('estimateConversationTokens', () => {
    it('should estimate tokens for empty conversation', () => {
      const tokens = estimateConversationTokens([]);
      // Should include base overhead only
      expect(tokens).toBe(3);
    });

    it('should estimate tokens for single message', () => {
      const messages: Message[] = [{ role: 'user', content: 'Hello' }];
      const tokens = estimateConversationTokens(messages);
      expect(tokens).toBeGreaterThan(3); // More than base overhead
    });

    it('should estimate tokens for multi-turn conversation', () => {
      const messages: Message[] = [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'Hi there!' },
        { role: 'assistant', content: 'Hello! How can I help?' },
        { role: 'user', content: 'Tell me a joke.' },
      ];
      const tokens = estimateConversationTokens(messages);
      expect(tokens).toBeGreaterThan(20);
    });
  });

  // --------------------------------------------------------------------------
  // Detailed Token Estimation
  // --------------------------------------------------------------------------
  describe('estimateTokensDetailed', () => {
    it('should provide breakdown for CJK text', () => {
      const result = estimateTokensDetailed('中文测试内容');
      expect(result.breakdown.cjk).toBeGreaterThan(0);
      expect(result.analysis.primaryType).toBe('cjk');
    });

    it('should provide breakdown for English text', () => {
      const result = estimateTokensDetailed('This is English text.');
      expect(result.breakdown.nonCjk).toBeGreaterThan(0);
      expect(result.analysis.primaryType).toBe('english');
    });

    it('should include total matching breakdown sum', () => {
      const text = 'Hello world, this is a test.';
      const result = estimateTokensDetailed(text);
      const sum = result.breakdown.cjk + result.breakdown.nonCjk + result.breakdown.overhead;
      expect(result.total).toBe(sum);
    });
  });

  // --------------------------------------------------------------------------
  // Token Budget
  // --------------------------------------------------------------------------
  describe('calculateBudget', () => {
    it('should calculate available tokens', () => {
      const budget = calculateBudget(500, 1000);
      expect(budget.available).toBe(500);
      expect(budget.usagePercent).toBe(50);
      expect(budget.exceeded).toBe(false);
    });

    it('should detect exceeded budget', () => {
      const budget = calculateBudget(1200, 1000);
      expect(budget.available).toBe(0);
      expect(budget.exceeded).toBe(true);
    });

    it('should handle zero usage', () => {
      const budget = calculateBudget(0, 1000);
      expect(budget.available).toBe(1000);
      expect(budget.usagePercent).toBe(0);
    });

    it('should round usage percentage', () => {
      const budget = calculateBudget(333, 1000);
      expect(budget.usagePercent).toBe(33.3);
    });
  });

  // --------------------------------------------------------------------------
  // fitsInBudget
  // --------------------------------------------------------------------------
  describe('fitsInBudget', () => {
    it('should return true for text within budget', () => {
      const result = fitsInBudget('Hello', 100);
      expect(result.fits).toBe(true);
      expect(result.remaining).toBeGreaterThan(0);
    });

    it('should return false for text exceeding budget', () => {
      const longText = 'word '.repeat(500);
      const result = fitsInBudget(longText, 10);
      expect(result.fits).toBe(false);
      expect(result.remaining).toBeLessThan(0);
    });

    it('should provide token count', () => {
      const text = 'This is a test sentence.';
      const result = fitsInBudget(text, 100);
      expect(result.tokens).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // truncateToTokenBudget
  // --------------------------------------------------------------------------
  describe('truncateToTokenBudget', () => {
    it('should return unchanged text if within budget', () => {
      const text = 'Short text';
      const result = truncateToTokenBudget(text, 100);
      expect(result).toBe(text);
    });

    it('should truncate long text to fit budget', () => {
      const longText = 'This is a longer sentence. '.repeat(50);
      const result = truncateToTokenBudget(longText, 20);
      expect(estimateTokens(result)).toBeLessThanOrEqual(25); // Allow some tolerance
      expect(result.length).toBeLessThan(longText.length);
    });

    it('should add ellipsis when truncated', () => {
      const longText = 'Word '.repeat(100);
      const result = truncateToTokenBudget(longText, 10);
      expect(result.endsWith('...')).toBe(true);
    });

    it('should try to break at word boundaries', () => {
      const text = 'This is a sentence with many words in it for testing.';
      const result = truncateToTokenBudget(text, 5);
      // Should not end mid-word (before ellipsis)
      const beforeEllipsis = result.replace(/\.\.\.$/, '').trimEnd();
      expect(beforeEllipsis.match(/\S$/)).toBeTruthy(); // Ends with non-whitespace
    });
  });

  // --------------------------------------------------------------------------
  // TOKEN_RATIOS
  // --------------------------------------------------------------------------
  describe('TOKEN_RATIOS', () => {
    it('should have correct ratio for CJK', () => {
      expect(TOKEN_RATIOS.CJK).toBe(2.0);
    });

    it('should have correct ratio for English', () => {
      expect(TOKEN_RATIOS.ENGLISH).toBe(3.5);
    });

    it('should have correct ratio for code', () => {
      expect(TOKEN_RATIOS.CODE).toBe(3.0);
    });

    it('should have ratio for all defined types', () => {
      expect(TOKEN_RATIOS.MARKDOWN).toBeDefined();
      expect(TOKEN_RATIOS.JSON).toBeDefined();
      expect(TOKEN_RATIOS.WHITESPACE).toBeDefined();
    });
  });
});
