// ============================================================================
// Format Utils Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import { formatDuration } from '../../../src/shared/utils/format';

describe('formatDuration', () => {
  // --------------------------------------------------------------------------
  // Milliseconds range (< 1000ms)
  // --------------------------------------------------------------------------
  describe('milliseconds range', () => {
    it('should format 0ms', () => {
      expect(formatDuration(0)).toBe('0ms');
    });

    it('should format small values', () => {
      expect(formatDuration(1)).toBe('1ms');
      expect(formatDuration(50)).toBe('50ms');
      expect(formatDuration(999)).toBe('999ms');
    });
  });

  // --------------------------------------------------------------------------
  // Seconds range (1s - 59.9s)
  // --------------------------------------------------------------------------
  describe('seconds range', () => {
    it('should format exactly 1 second', () => {
      expect(formatDuration(1000)).toBe('1.0s');
    });

    it('should format fractional seconds', () => {
      expect(formatDuration(1500)).toBe('1.5s');
      expect(formatDuration(2300)).toBe('2.3s');
    });

    it('should format up to 59 seconds', () => {
      expect(formatDuration(59000)).toBe('59.0s');
      expect(formatDuration(59999)).toBe('60.0s');
    });
  });

  // --------------------------------------------------------------------------
  // Minutes range (>= 60s)
  // --------------------------------------------------------------------------
  describe('minutes range', () => {
    it('should format exactly 1 minute', () => {
      expect(formatDuration(60000)).toBe('1m 0s');
    });

    it('should format minutes and seconds', () => {
      expect(formatDuration(90000)).toBe('1m 30s');
      expect(formatDuration(125000)).toBe('2m 5s');
    });

    it('should format large values', () => {
      expect(formatDuration(600000)).toBe('10m 0s');
      expect(formatDuration(3661000)).toBe('61m 1s');
    });
  });

  // --------------------------------------------------------------------------
  // Edge cases
  // --------------------------------------------------------------------------
  describe('edge cases', () => {
    it('should handle boundary value of 1000ms', () => {
      expect(formatDuration(999)).toBe('999ms');
      expect(formatDuration(1000)).toBe('1.0s');
    });

    it('should handle boundary value of 60000ms', () => {
      expect(formatDuration(59999)).toBe('60.0s');
      expect(formatDuration(60000)).toBe('1m 0s');
    });
  });
});
