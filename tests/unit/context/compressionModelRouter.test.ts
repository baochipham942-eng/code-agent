// ============================================================================
// CompressionModelRouter Tests
// ============================================================================
// Tests for compression layer model selection logic.
// ============================================================================

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CompressionModelRouter,
  getCompressionModelRouter,
  resetCompressionModelRouter,
} from '../../../src/main/context/compressionModelRouter';

describe('CompressionModelRouter', () => {
  // --------------------------------------------------------------------------
  // Model-free layers — should return null
  // --------------------------------------------------------------------------
  describe('model-free layers', () => {
    let router: CompressionModelRouter;

    beforeEach(() => {
      router = new CompressionModelRouter();
    });

    it('L1 (tool-result-budget) returns null', () => {
      expect(router.selectModel('tool-result-budget')).toBeNull();
    });

    it('L2 (snip) returns null', () => {
      expect(router.selectModel('snip')).toBeNull();
    });

    it('L3 (microcompact) returns null', () => {
      expect(router.selectModel('microcompact')).toBeNull();
    });

    it('L6 (overflow-recovery) returns null', () => {
      expect(router.selectModel('overflow-recovery')).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Default model selection for L4/L5
  // --------------------------------------------------------------------------
  describe('default model selection', () => {
    let router: CompressionModelRouter;

    beforeEach(() => {
      router = new CompressionModelRouter();
    });

    it('L4 (contextCollapse) returns zhipu/glm-4-flash', () => {
      expect(router.selectModel('contextCollapse')).toEqual({
        provider: 'zhipu',
        model: 'glm-4-flash',
      });
    });

    it('L5 (autocompact) returns moonshot/kimi-k2.5', () => {
      expect(router.selectModel('autocompact')).toEqual({
        provider: 'moonshot',
        model: 'kimi-k2.5',
      });
    });

    it('unknown layer returns null', () => {
      expect(router.selectModel('unknown-layer')).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // User preference override
  // --------------------------------------------------------------------------
  describe('user preference', () => {
    const customConfig = { provider: 'openai', model: 'gpt-4o-mini' };

    it('user preference overrides L4 default', () => {
      const router = new CompressionModelRouter({ userPreference: customConfig });
      expect(router.selectModel('contextCollapse')).toEqual(customConfig);
    });

    it('user preference overrides L5 default', () => {
      const router = new CompressionModelRouter({ userPreference: customConfig });
      expect(router.selectModel('autocompact')).toEqual(customConfig);
    });

    it('clearPreference reverts to defaults', () => {
      const router = new CompressionModelRouter({ userPreference: customConfig });
      router.clearPreference();
      expect(router.selectModel('contextCollapse')).toEqual({
        provider: 'zhipu',
        model: 'glm-4-flash',
      });
      expect(router.selectModel('autocompact')).toEqual({
        provider: 'moonshot',
        model: 'kimi-k2.5',
      });
    });

    it('setPreference overrides defaults mid-lifecycle', () => {
      const router = new CompressionModelRouter();
      router.setPreference(customConfig);
      expect(router.selectModel('contextCollapse')).toEqual(customConfig);
    });
  });

  // --------------------------------------------------------------------------
  // Singleton helpers
  // --------------------------------------------------------------------------
  describe('singleton', () => {
    beforeEach(() => {
      resetCompressionModelRouter();
    });

    it('getCompressionModelRouter returns same instance', () => {
      const a = getCompressionModelRouter();
      const b = getCompressionModelRouter();
      expect(a).toBe(b);
    });

    it('resetCompressionModelRouter creates fresh instance', () => {
      const a = getCompressionModelRouter();
      resetCompressionModelRouter();
      const b = getCompressionModelRouter();
      expect(a).not.toBe(b);
    });
  });
});
