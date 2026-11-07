// ============================================================================
// toolUseLine 单测（N-EXTHISTORY-IMPORT-CHATS-HOST）—— 工具调用一行化规则
// ============================================================================

import { describe, expect, it } from 'vitest';
import { formatToolUseLine } from '../../../src/host/externalImport/toolUseLine';

describe('formatToolUseLine', () => {
  it('picks the first argument key by priority (command over file_path)', () => {
    expect(formatToolUseLine('Bash', {
      command: 'ls -la /tmp',
      file_path: '/tmp/other.txt',
    })).toBe('Bash ls -la /tmp');
    expect(formatToolUseLine('Grep', { pattern: 'import.*fs' })).toBe('Grep import.*fs');
  });

  it('parses JSON-string arguments (Codex function_call shape)', () => {
    expect(formatToolUseLine('shell', '{"url":"https://example.com/a"}')).toBe('shell https://example.com/a');
  });

  it('collapses whitespace and truncates the argument to 120 characters', () => {
    const long = `echo ${'a'.repeat(300)}`;
    const line = formatToolUseLine('Bash', { command: `echo   ${'a'.repeat(300)}\n\n tail` });
    expect(line.startsWith('Bash echo a')).toBe(true);
    expect(line.length).toBe('Bash '.length + 120);
    expect(line).not.toContain('\n');
    expect(long.length).toBeGreaterThan(120);
  });

  it('keeps only the tool name when no argument key matches', () => {
    expect(formatToolUseLine('synthetic_tool', {})).toBe('synthetic_tool');
    expect(formatToolUseLine('synthetic_tool', { other: 'value' })).toBe('synthetic_tool');
    expect(formatToolUseLine('synthetic_tool', 'not-json')).toBe('synthetic_tool');
    expect(formatToolUseLine(undefined, { command: 'ls' })).toBe('');
  });
});
