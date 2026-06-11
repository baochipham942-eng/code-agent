import { describe, it, expect } from 'vitest';
import { truncateMiddle, truncateHead, truncateMiddleErrorAware } from '../../src/main/utils/truncate';

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

  // codex audit LOW：maxLength <= 60（reserveForMarker）时预算为负，
  // 头尾 substring 全空，输出只剩纯标记且可能超过 maxLength → 降级走头部截断
  it('degrades to head truncation when maxLength <= marker reserve (60)', () => {
    const text = Array.from({ length: 50 }, (_, i) => `line ${i + 1} content`).join('\n');
    const result = truncateMiddle(text, 50);

    // 头部内容必须保住（负预算下现状是全丢，只剩标记）
    expect(result).toContain('line 1');
    expect(result).toContain('truncated');
    // 输出不随 removed 数字膨胀：最多 maxLength + 头部截断标记余量
    expect(result.length).toBeLessThanOrEqual(50 + 23);
  });

  it('tiny maxLength does not emit oversized marker-only output', () => {
    const text = 'x'.repeat(10_000);
    const result = truncateMiddle(text, 10);
    expect(result.length).toBeLessThanOrEqual(10 + 23);
  });

  it('degraded head truncation still prefers line boundaries', () => {
    const text = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5\nLine 6\nLine 7\nLine 8\nLine 9\nLine 10';
    const result = truncateMiddle(text, 40);
    const lines = result.split('\n').filter(l => l.trim() && !l.includes('truncated'));
    for (const line of lines) {
      expect(line).toMatch(/^Line \d+$/);
    }
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

describe('truncateMiddleErrorAware', () => {
  it('returns original text if within limit', () => {
    const text = 'error: something failed';
    expect(truncateMiddleErrorAware(text, 100)).toBe(text);
  });

  it('allocates 70/30 head/tail when tail contains error pattern', () => {
    // 头部是正常日志，尾部带报错
    const lines = [
      ...Array.from({ length: 200 }, (_, i) => `processing item ${i} with some payload data`),
      'Traceback (most recent call last):',
      '  File "main.py", line 42, in <module>',
      'ValueError: bad input',
    ];
    const text = lines.join('\n');
    const result = truncateMiddleErrorAware(text, 1000);

    expect(result).toContain('ValueError: bad input');
    expect(result).toContain('truncated');
    // 头部预算应大于尾部（70/30）
    const markerIdx = result.indexOf('characters truncated');
    const head = result.slice(0, markerIdx);
    const tail = result.slice(markerIdx);
    expect(head.length).toBeGreaterThan(tail.length * 1.5);
  });

  it('uses default 50/50 split when no error pattern in tail', () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i} normal output content here`);
    const text = lines.join('\n');
    const result = truncateMiddleErrorAware(text, 1000);

    expect(result).toContain('truncated');
    // 50/50：头尾长度接近
    const markerIdx = result.indexOf('characters truncated');
    const head = result.slice(0, markerIdx);
    const tail = result.slice(markerIdx);
    expect(head.length).toBeLessThan(tail.length * 1.5);
    expect(tail.length).toBeLessThan(head.length * 1.5);
  });

  it('only scans the last 2048 chars for error patterns', () => {
    // 错误只出现在开头（超出尾部扫描窗口），不应触发 70/30
    const lines = [
      'ERROR: early failure',
      ...Array.from({ length: 300 }, (_, i) => `line ${i} normal output content here padding`),
    ];
    const text = lines.join('\n');
    const result = truncateMiddleErrorAware(text, 1000);

    const markerIdx = result.indexOf('characters truncated');
    const head = result.slice(0, markerIdx);
    const tail = result.slice(markerIdx);
    // 未命中错误 → 50/50
    expect(head.length).toBeLessThan(tail.length * 1.5);
  });

  it.each(['error', 'Exception', 'FAILED', 'fatal', 'Traceback', 'panic', 'exit code'])(
    'detects "%s" pattern in tail',
    (keyword) => {
      const lines = [
        ...Array.from({ length: 200 }, (_, i) => `processing item ${i} with payload`),
        `something ${keyword} happened`,
      ];
      const text = lines.join('\n');
      const result = truncateMiddleErrorAware(text, 1000);
      const markerIdx = result.indexOf('characters truncated');
      const head = result.slice(0, markerIdx);
      const tail = result.slice(markerIdx);
      expect(head.length).toBeGreaterThan(tail.length * 1.5);
    }
  );
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
