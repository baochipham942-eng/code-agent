// ============================================================================
// Cache Break Detection Tests
// ============================================================================

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract/message';
import type { Session } from '../../../src/shared/contract/session';

const summarize = vi.hoisted(() => vi.fn(async () => 'Topics: cache\nSummary:\nkept the facts'));

vi.mock('../../../src/host/context/compactModel', () => ({
  compactModelSummarize: summarize,
}));

vi.mock('../../../src/host/services/core', () => ({
  getDatabase: () => ({
    getDb: () => ({
      prepare: () => ({
        get: () => undefined,
        run: () => ({ changes: 1 }),
      }),
    }),
  }),
}));
import {
  detectCacheBreak,
  splitAtDynamicBoundary,
  DYNAMIC_BOUNDARY_MARKER,
} from '../../../src/host/prompts/cacheBreakDetection';

const STABLE = 'You are Agent Neo.\n\n## Tools\n\nBash, Read, Write';
const DYNAMIC = '## Rules\n\nBe concise.\n\n## Generative UI\n\nEnabled.';
const PROMPT_WITH_BOUNDARY = `${STABLE}${DYNAMIC_BOUNDARY_MARKER}${DYNAMIC}`;

describe('detectCacheBreak', () => {
  it('reports no break when prompts are identical', () => {
    const result = detectCacheBreak(PROMPT_WITH_BOUNDARY, PROMPT_WITH_BOUNDARY);
    expect(result.broken).toBe(false);
    expect(result.reason).toBe('cache stable');
    expect(result.cacheBreakReason).toBe('none');
  });

  it('detects break when system prompt static prefix changes', () => {
    const modified = `${STABLE} [EXTRA]${DYNAMIC_BOUNDARY_MARKER}${DYNAMIC}`;
    const result = detectCacheBreak(PROMPT_WITH_BOUNDARY, modified);
    expect(result.broken).toBe(true);
    expect(result.reason).toBe('static prefix changed');
    expect(result.cacheBreakReason).toBe('prefix-changed');
  });

  it('detects break when model changes', () => {
    const result = detectCacheBreak(PROMPT_WITH_BOUNDARY, PROMPT_WITH_BOUNDARY, {
      prevModel: 'kimi-k2.5',
      currModel: 'deepseek-chat',
    });
    expect(result.broken).toBe(true);
    expect(result.reason).toContain('model changed');
    expect(result.cacheBreakReason).toBe('model-switch');
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
    expect(result.cacheBreakReason).toBe('prefix-changed');
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

describe('session reference digest cache contract', () => {
  beforeEach(() => {
    summarize.mockClear();
  });

  it('passes cacheRetention none and a record-only scope id', async () => {
    const { resolveSessionReference } = await import('../../../src/host/tools/modules/session/sessionReferenceDigest');
    const session = { id: `session-${Date.now()}`, title: 'Referenced' } as Session;
    const messages = Array.from({ length: 16 }, (_, index) => ({
      id: `m-${index}`,
      role: index % 2 === 0 ? 'user' : 'assistant',
      content: `line ${index}`,
      timestamp: 1_700_000_000_000 + index,
    })) as Message[];

    await resolveSessionReference(session, messages);

    expect(summarize).toHaveBeenCalledWith(
      expect.stringContaining('Referenced'),
      800,
      { cacheRetention: 'none', cacheScopeId: 'session-reference-digest' },
    );
  });
});
