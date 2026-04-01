// ============================================================================
// Cache Break Detection Tests
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  detectCacheBreak,
  splitAtDynamicBoundary,
  DYNAMIC_BOUNDARY_MARKER,
} from '../../../src/main/prompts/cacheBreakDetection';

const STABLE = 'You are Code Agent.\n\n## Tools\n\nBash, Read, Write';
const DYNAMIC = '## Rules\n\nBe concise.\n\n## Generative UI\n\nEnabled.';
const PROMPT_WITH_BOUNDARY = `${STABLE}${DYNAMIC_BOUNDARY_MARKER}${DYNAMIC}`;

describe('detectCacheBreak', () => {
  it('reports no break when prompts are identical', () => {
    const result = detectCacheBreak(PROMPT_WITH_BOUNDARY, PROMPT_WITH_BOUNDARY);
    expect(result.broken).toBe(false);
    expect(result.reason).toBe('cache stable');
  });

  it('detects break when system prompt static prefix changes', () => {
    const modified = `${STABLE} [EXTRA]${DYNAMIC_BOUNDARY_MARKER}${DYNAMIC}`;
    const result = detectCacheBreak(PROMPT_WITH_BOUNDARY, modified);
    expect(result.broken).toBe(true);
    expect(result.reason).toBe('static prefix changed');
  });

  it('detects break when model changes', () => {
    const result = detectCacheBreak(PROMPT_WITH_BOUNDARY, PROMPT_WITH_BOUNDARY, {
      prevModel: 'kimi-k2.5',
      currModel: 'deepseek-chat',
    });
    expect(result.broken).toBe(true);
    expect(result.reason).toContain('model changed');
  });

  it('ignores dynamic section changes', () => {
    const prev = `${STABLE}${DYNAMIC_BOUNDARY_MARKER}## Rules\n\nBe concise.`;
    const curr = `${STABLE}${DYNAMIC_BOUNDARY_MARKER}## Rules\n\nBe verbose and detailed.`;
    const result = detectCacheBreak(prev, curr);
    expect(result.broken).toBe(false);
  });

  it('handles prompts without boundary marker', () => {
    const plain = 'You are a helpful assistant.';
    // Identical — no break
    expect(detectCacheBreak(plain, plain).broken).toBe(false);
    // Different — break
    const different = 'You are a different assistant.';
    const result = detectCacheBreak(plain, different);
    expect(result.broken).toBe(true);
    expect(result.reason).toBe('static prefix changed');
  });

  it('does not break when same model is provided', () => {
    const result = detectCacheBreak(PROMPT_WITH_BOUNDARY, PROMPT_WITH_BOUNDARY, {
      prevModel: 'kimi-k2.5',
      currModel: 'kimi-k2.5',
    });
    expect(result.broken).toBe(false);
  });

  it('supports custom dynamicBoundary option', () => {
    const CUSTOM = '\n<!-- CUSTOM -->\n';
    const prev = `stable${CUSTOM}dynamic_v1`;
    const curr = `stable${CUSTOM}dynamic_v2`;
    const result = detectCacheBreak(prev, curr, { dynamicBoundary: CUSTOM });
    expect(result.broken).toBe(false);
  });
});

describe('splitAtDynamicBoundary', () => {
  it('splits at marker', () => {
    const [prefix, dynamic] = splitAtDynamicBoundary(PROMPT_WITH_BOUNDARY);
    expect(prefix).toBe(STABLE);
    expect(dynamic).toBe(DYNAMIC);
  });

  it('returns [fullPrompt, ""] when no marker', () => {
    const plain = 'No boundary here.';
    const [prefix, dynamic] = splitAtDynamicBoundary(plain);
    expect(prefix).toBe(plain);
    expect(dynamic).toBe('');
  });

  it('handles empty string', () => {
    const [prefix, dynamic] = splitAtDynamicBoundary('');
    expect(prefix).toBe('');
    expect(dynamic).toBe('');
  });

  it('handles prompt that is only a boundary marker', () => {
    const [prefix, dynamic] = splitAtDynamicBoundary(DYNAMIC_BOUNDARY_MARKER);
    expect(prefix).toBe('');
    expect(dynamic).toBe('');
  });

  it('splits at first occurrence when multiple boundaries exist', () => {
    const multi = `A${DYNAMIC_BOUNDARY_MARKER}B${DYNAMIC_BOUNDARY_MARKER}C`;
    const [prefix, dynamic] = splitAtDynamicBoundary(multi);
    expect(prefix).toBe('A');
    expect(dynamic).toBe(`B${DYNAMIC_BOUNDARY_MARKER}C`);
  });
});
