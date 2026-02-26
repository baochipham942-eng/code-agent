import { describe, it, expect } from 'vitest';
import { truncateMiddle, truncateHead } from '../../src/main/utils/truncate';

describe('truncateMiddle', () => {
  it('returns original text if within limit', () => {
    const text = 'Hello, world!';
    expect(truncateMiddle(text, 100)).toBe(text);
  });

  it('truncates middle and preserves head and tail', () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}: Some content here`);
    const text = lines.join('\n');
    const result = truncateMiddle(text, 500);

    // Should contain head lines
    expect(result).toContain('Line 1:');
    // Should contain tail lines
    expect(result).toContain('Line 100:');
    // Should have truncation marker
    expect(result).toMatch(/\.\.\. \[\d+ characters truncated\] \.\.\./);
    // Should be within budget
    expect(result.length).toBeLessThanOrEqual(600); // some margin for marker
  });

  it('preserves line boundaries', () => {
    const text = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
    const result = truncateMiddle(text, 40);

    // Should not cut a line in the middle
    const lines = result.split('\n').filter(l => l.trim() && !l.includes('truncated'));
    for (const line of lines) {
      if (line.startsWith('Line')) {
        // Each line should be complete
        expect(line).toMatch(/^Line \d+$/);
      }
    }
  });

  it('handles text with no newlines', () => {
    const text = 'a'.repeat(1000);
    const result = truncateMiddle(text, 200);
    expect(result).toContain('characters truncated');
    expect(result.length).toBeLessThan(300);
  });

  it('respects custom head ratio', () => {
    const lines = Array.from({ length: 50 }, (_, i) => `Line ${i + 1}`);
    const text = lines.join('\n');

    // 80% head, 20% tail
    const result = truncateMiddle(text, 200, 0.8);
    expect(result).toContain('characters truncated');

    // Head portion should be larger than tail
    const parts = result.split('[');
    expect(parts[0].length).toBeGreaterThan(parts[1]?.length || 0);
  });

  it('handles very short maxLength gracefully', () => {
    const text = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    const result = truncateMiddle(text, 20);
    expect(result).toContain('truncated');
  });

  it('equal length returns original', () => {
    const text = 'exactly 10';
    expect(truncateMiddle(text, 10)).toBe(text);
  });

  it('preserves error message at start and status at end', () => {
    // Simulate typical command output: error at top, summary at bottom
    const lines = [
      'ERROR: Module not found',
      'at /path/to/file.ts:42',
      ...Array.from({ length: 100 }, (_, i) => `  processing item ${i}...`),
      'Total: 100 items processed',
      'Exit code: 1',
    ];
    const text = lines.join('\n');
    const result = truncateMiddle(text, 500);

    expect(result).toContain('ERROR: Module not found');
    expect(result).toContain('Exit code: 1');
    expect(result).toContain('truncated');
  });
});

describe('truncateHead', () => {
  it('returns original text if within limit', () => {
    expect(truncateHead('short', 100)).toBe('short');
  });

  it('truncates from the end', () => {
    const text = 'a'.repeat(200);
    const result = truncateHead(text, 100);
    expect(result.length).toBeLessThan(150);
    expect(result).toContain('(output truncated)');
  });
});
