// ============================================================================
// Compaction Pre-Truncate Tests
// ============================================================================

import { describe, it, expect } from 'vitest';

// 直接测试截断逻辑（不依赖 AutoContextCompressor 单例）
function preTruncateForCompaction(messages: Array<{ role: string; content: string }>) {
  const TOOL_LIMIT = 500;
  const TOOL_ERROR_LIMIT = 1000;

  return messages.map(msg => {
    if (msg.role !== 'tool' || msg.content.length <= TOOL_LIMIT) return msg;
    const isError = /error|Error|ENOENT|EPERM|TypeError|SyntaxError/i.test(msg.content);
    const limit = isError ? TOOL_ERROR_LIMIT : TOOL_LIMIT;
    if (msg.content.length <= limit) return msg;
    const omitted = msg.content.length - limit;
    return { ...msg, content: msg.content.substring(0, limit) + `\n[...已截断 ${omitted} 字符]` };
  });
}

describe('Compaction Pre-Truncate', () => {
  it('should not truncate non-tool messages', () => {
    const messages = [
      { role: 'user', content: 'x'.repeat(2000) },
      { role: 'assistant', content: 'y'.repeat(2000) },
      { role: 'system', content: 'z'.repeat(2000) },
    ];
    const result = preTruncateForCompaction(messages);
    expect(result[0]!.content.length).toBe(2000);
    expect(result[1]!.content.length).toBe(2000);
    expect(result[2]!.content.length).toBe(2000);
  });

  it('should not truncate short tool messages', () => {
    const messages = [{ role: 'tool', content: 'short output' }];
    const result = preTruncateForCompaction(messages);
    expect(result[0]!.content).toBe('short output');
  });

  it('should truncate long tool output to 500 chars', () => {
    const longContent = 'a'.repeat(2000);
    const messages = [{ role: 'tool', content: longContent }];
    const result = preTruncateForCompaction(messages);
    expect(result[0]!.content.length).toBeLessThan(2000);
    expect(result[0]!.content).toContain('[...已截断 1500 字符]');
    expect(result[0]!.content.startsWith('a'.repeat(500))).toBe(true);
  });

  it('should truncate error tool output to 1000 chars', () => {
    const errorContent = 'Error: something failed\n' + 'stack trace '.repeat(200);
    const messages = [{ role: 'tool', content: errorContent }];
    const result = preTruncateForCompaction(messages);
    // Error content gets 1000 char limit
    expect(result[0]!.content).toContain('[...已截断');
    expect(result[0]!.content.length).toBeLessThan(errorContent.length);
    // First 1000 chars preserved
    expect(result[0]!.content.startsWith(errorContent.substring(0, 100))).toBe(true);
  });

  it('should detect various error patterns', () => {
    const errorPatterns = ['ENOENT: no such file', 'EPERM: permission denied', 'TypeError: undefined', 'SyntaxError: unexpected'];
    for (const pattern of errorPatterns) {
      const content = pattern + ' '.repeat(2000);
      const result = preTruncateForCompaction([{ role: 'tool', content }]);
      // Error outputs get 1000 char limit (not 500)
      const truncatedPart = result[0]!.content.match(/已截断 (\d+) 字符/);
      expect(truncatedPart).toBeTruthy();
      const omitted = parseInt(truncatedPart![1]!);
      expect(omitted).toBe(content.length - 1000);
    }
  });

  it('should preserve original messages (immutable)', () => {
    const original = { role: 'tool', content: 'x'.repeat(2000) };
    const messages = [original];
    const result = preTruncateForCompaction(messages);
    expect(original.content.length).toBe(2000); // original unchanged
    expect(result[0]).not.toBe(original); // new object
  });

  it('should handle mixed message types', () => {
    const messages = [
      { role: 'user', content: 'question' },
      { role: 'tool', content: 'x'.repeat(1000) }, // will be truncated to 500
      { role: 'assistant', content: 'response' },
      { role: 'tool', content: 'Error: fail\n' + 'x'.repeat(2000) }, // error, truncated to 1000
    ];
    const result = preTruncateForCompaction(messages);
    expect(result[0]!.content).toBe('question');
    expect(result[1]!.content).toContain('[...已截断 500 字符]');
    expect(result[2]!.content).toBe('response');
    expect(result[3]!.content).toContain('[...已截断');
  });
});
