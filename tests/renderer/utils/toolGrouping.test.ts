import { describe, expect, it } from 'vitest';
import { extractThinkingSummary, sanitizeThinkingForDisplay } from '../../../src/renderer/utils/toolGrouping';

describe('thinking display helpers', () => {
  it('filters runtime diagnostics from displayed thinking', () => {
    const text = [
      '[runtime] 上下文预算跳过 persistent system context #1：预计 6354/6000 tokens',
      '[runtime] 上下文预算保留必需 persistent system context #1：预计 6354/6000 tokens',
      'The user asked me to run the validation command.',
      'I now have the results.',
    ].join('\n');

    expect(sanitizeThinkingForDisplay(text)).toBe(
      'The user asked me to run the validation command.\nI now have the results.',
    );
  });

  it('hides thinking when only runtime diagnostics are present', () => {
    const text = [
      '[runtime] 上下文预算跳过 persistent system context #1：预计 6354/6000 tokens',
      '[runtime] 上下文预算压缩 base prompt：保留必需 game artifact contract',
    ].join('\n');

    expect(sanitizeThinkingForDisplay(text)).toBeUndefined();
    expect(extractThinkingSummary(text)).toBeNull();
  });

  it('compacts streamed thinking whitespace and drops incremental duplicates', () => {
    const text = [
      'The user wants me to run a simple bash command.',
      '',
      '',
      'The user wants me to run a simple bash command and report the output.',
      '',
      '',
      'The output was truncated. Let me get the full output.',
      'The output was truncated. Let me get the full output.',
    ].join('\n');

    expect(sanitizeThinkingForDisplay(text)).toBe(
      'The user wants me to run a simple bash command and report the output.\n\nThe output was truncated. Let me get the full output.',
    );
  });

  it('summarizes the first non-runtime thinking line', () => {
    const text = [
      '[runtime] 上下文预算跳过 artifact repair focus：预计 6763/6000 tokens',
      'The user asked me to run the validation command and report the results.',
    ].join('\n');

    expect(extractThinkingSummary(text)).toBe(
      'The user asked me to run the validation command and repor...',
    );
  });
});
