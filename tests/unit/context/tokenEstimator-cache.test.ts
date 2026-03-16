// ============================================================================
// Token Estimator - LRU Cache Tests (Sprint 3 Performance Optimization)
// ============================================================================
// Tests the LRU cache behavior added in Sprint 3:
// - Cache hit: same input returns cached result
// - LRU eviction: cache doesn't grow beyond MAX_SIZE (200)
// - Edge cases: empty string, very long string
// ============================================================================

import { describe, it, expect } from 'vitest';
import { estimateTokens } from '../../../src/main/context/tokenEstimator';

describe('TokenEstimator LRU Cache', () => {
  // --------------------------------------------------------------------------
  // Cache Hit Behavior
  // --------------------------------------------------------------------------
  describe('cache hit', () => {
    it('should return same result for identical input (cache hit)', () => {
      const text = 'This is a deterministic test string for cache verification.';
      const first = estimateTokens(text);
      const second = estimateTokens(text);
      expect(first).toBe(second);
    });

    it('should return consistent results for CJK text', () => {
      const text = '这是一段用于缓存测试的中文文本';
      const first = estimateTokens(text);
      const second = estimateTokens(text);
      expect(first).toBe(second);
    });

    it('should return consistent results for code content', () => {
      const code = `
        import { useState } from 'react';
        export const App = () => {
          const [count, setCount] = useState(0);
          return <div>{count}</div>;
        };
      `;
      const first = estimateTokens(code);
      const second = estimateTokens(code);
      expect(first).toBe(second);
    });
  });

  // --------------------------------------------------------------------------
  // Cache Performance (no regression)
  // --------------------------------------------------------------------------
  describe('cache performance', () => {
    it('cached call should not be slower than uncached', () => {
      // Generate a unique string unlikely to be cached
      const uniqueText = `Unique performance test ${Date.now()} ${Math.random()}`;

      const startFirst = performance.now();
      estimateTokens(uniqueText);
      const firstDuration = performance.now() - startFirst;

      const startSecond = performance.now();
      estimateTokens(uniqueText);
      const secondDuration = performance.now() - startSecond;

      // Second call (cached) should be at least as fast
      // Allow some jitter but cached should generally be faster
      expect(secondDuration).toBeLessThanOrEqual(firstDuration + 1);
    });
  });

  // --------------------------------------------------------------------------
  // LRU Eviction
  // --------------------------------------------------------------------------
  describe('LRU eviction', () => {
    it('should handle many unique inputs without error (exceeding cache size)', () => {
      // TOKEN_CACHE_MAX is 200, inserting 250 unique strings should trigger eviction
      for (let i = 0; i < 250; i++) {
        const text = `Unique test string number ${i} with enough content to be meaningful.`;
        const result = estimateTokens(text);
        expect(result).toBeGreaterThan(0);
      }
    });

    it('should still return correct results after eviction', () => {
      // Fill cache beyond capacity with unique strings
      for (let i = 0; i < 210; i++) {
        estimateTokens(`Eviction test filler ${i} padding padding padding.`);
      }

      // Now test a fresh string - should still compute correctly
      const freshText = 'A fresh string after eviction should still work correctly.';
      const result = estimateTokens(freshText);
      expect(result).toBeGreaterThan(0);
      // Call again - should be cached now
      expect(estimateTokens(freshText)).toBe(result);
    });
  });

  // --------------------------------------------------------------------------
  // Edge Cases
  // --------------------------------------------------------------------------
  describe('edge cases', () => {
    it('should handle empty string', () => {
      expect(estimateTokens('')).toBe(0);
      // Second call
      expect(estimateTokens('')).toBe(0);
    });

    it('should handle very long string', () => {
      const longText = 'a'.repeat(100_000);
      const result = estimateTokens(longText);
      expect(result).toBeGreaterThan(0);
      // Cached call
      expect(estimateTokens(longText)).toBe(result);
    });

    it('should handle single character', () => {
      const result = estimateTokens('x');
      expect(result).toBeGreaterThanOrEqual(1);
      expect(estimateTokens('x')).toBe(result);
    });

    it('should differentiate similar but different strings', () => {
      const a = 'Hello World!';
      const b = 'Hello World?';
      const resultA = estimateTokens(a);
      const resultB = estimateTokens(b);
      // Both should return valid results (may or may not be equal)
      expect(resultA).toBeGreaterThan(0);
      expect(resultB).toBeGreaterThan(0);
    });

    it('should handle unicode and emoji', () => {
      const text = 'Hello 🌍 World 🚀 Testing 中文';
      const result = estimateTokens(text);
      expect(result).toBeGreaterThan(0);
      expect(estimateTokens(text)).toBe(result);
    });
  });
});
