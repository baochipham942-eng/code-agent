// ============================================================================
// RequestNormalizer Middleware Tests
// Tests for message normalization, tool schema conversion, beta flags, cache
// ============================================================================

import { describe, it, expect } from 'vitest';
import {
  normalizeMessages,
  toolToAPISchema,
  applyBetaFlags,
  shouldEnableCache,
} from '../../../src/main/model/middleware/requestNormalizer';
import type { NormalizedMessage, NormalizedToolSchema } from '../../../src/main/model/middleware/requestNormalizer';

describe('normalizeMessages', () => {
  // --------------------------------------------------------------------------
  // String content passthrough
  // --------------------------------------------------------------------------
  describe('string content passthrough', () => {
    it('passes string content unchanged for openai provider', () => {
      const msgs = [{ role: 'user', content: 'hello world' }];
      const result = normalizeMessages(msgs, 'openai');
      expect(result[0].content).toBe('hello world');
      expect(result[0].role).toBe('user');
    });

    it('passes string content unchanged for string-only provider', () => {
      const msgs = [{ role: 'user', content: 'hello' }];
      const result = normalizeMessages(msgs, 'zhipu');
      expect(result[0].content).toBe('hello');
    });

    it('preserves multiple messages with string content', () => {
      const msgs = [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'second' },
      ];
      const result = normalizeMessages(msgs, 'moonshot');
      expect(result).toHaveLength(2);
      expect(result[0].content).toBe('first');
      expect(result[1].content).toBe('second');
    });
  });

  // --------------------------------------------------------------------------
  // Content-parts flattened for string-only providers
  // --------------------------------------------------------------------------
  describe('content-parts flattened for string-only providers', () => {
    const contentParts = [
      { type: 'text', text: 'Hello' },
      { type: 'text', text: 'world' },
    ];

    it('flattens text parts to joined string for zhipu', () => {
      const msgs = [{ role: 'user', content: contentParts }];
      const result = normalizeMessages(msgs, 'zhipu');
      expect(result[0].content).toBe('Hello\nworld');
    });

    it('flattens text parts to joined string for minimax', () => {
      const msgs = [{ role: 'user', content: contentParts }];
      const result = normalizeMessages(msgs, 'minimax');
      expect(result[0].content).toBe('Hello\nworld');
    });

    it('flattens text parts to joined string for qwen', () => {
      const msgs = [{ role: 'user', content: contentParts }];
      const result = normalizeMessages(msgs, 'qwen');
      expect(result[0].content).toBe('Hello\nworld');
    });

    it('flattens text parts to joined string for local', () => {
      const msgs = [{ role: 'user', content: contentParts }];
      const result = normalizeMessages(msgs, 'local');
      expect(result[0].content).toBe('Hello\nworld');
    });

    it('filters out non-text parts when flattening', () => {
      const mixed = [
        { type: 'text', text: 'Hello' },
        { type: 'image_url', url: 'https://example.com/img.png' },
        { type: 'text', text: 'world' },
      ];
      const msgs = [{ role: 'user', content: mixed }];
      const result = normalizeMessages(msgs, 'zhipu');
      expect(result[0].content).toBe('Hello\nworld');
    });
  });

  // --------------------------------------------------------------------------
  // Content-parts preserved for OpenAI-compatible providers
  // --------------------------------------------------------------------------
  describe('content-parts preserved for OpenAI-compatible providers', () => {
    it('preserves content-parts array for openai provider', () => {
      const parts = [{ type: 'text', text: 'Hello' }, { type: 'image_url', url: 'x' }];
      const msgs = [{ role: 'user', content: parts }];
      const result = normalizeMessages(msgs, 'openai');
      expect(Array.isArray(result[0].content)).toBe(true);
      expect(result[0].content).toEqual(parts);
    });

    it('preserves content-parts array for moonshot provider', () => {
      const parts = [{ type: 'text', text: 'Hello' }];
      const msgs = [{ role: 'user', content: parts }];
      const result = normalizeMessages(msgs, 'moonshot');
      expect(Array.isArray(result[0].content)).toBe(true);
    });
  });
});

describe('toolToAPISchema', () => {
  it('maps name and description fields', () => {
    const tools = [{ name: 'search', description: 'Search the web', parameters: { q: { type: 'string' } } }];
    const result = toolToAPISchema(tools, 'openai');
    expect(result[0].name).toBe('search');
    expect(result[0].description).toBe('Search the web');
  });

  it('maps parameters field', () => {
    const tools = [{ name: 'calc', description: 'Calculate', parameters: { expr: { type: 'string' } } }];
    const result = toolToAPISchema(tools, 'zhipu');
    expect(result[0].parameters).toEqual({ expr: { type: 'string' } });
  });

  it('defaults to empty object when parameters is undefined', () => {
    const tools = [{ name: 'noop', description: 'Does nothing' }];
    const result = toolToAPISchema(tools, 'moonshot');
    expect(result[0].parameters).toEqual({});
  });

  it('returns all tools when given multiple', () => {
    const tools = [
      { name: 'a', description: 'A' },
      { name: 'b', description: 'B' },
      { name: 'c', description: 'C' },
    ];
    const result = toolToAPISchema(tools, 'deepseek');
    expect(result).toHaveLength(3);
    expect(result.map(t => t.name)).toEqual(['a', 'b', 'c']);
  });

  it('returns typed NormalizedToolSchema objects', () => {
    const tools = [{ name: 'x', description: 'X', parameters: {} }];
    const result: NormalizedToolSchema[] = toolToAPISchema(tools, 'openai');
    expect(result[0]).toHaveProperty('name');
    expect(result[0]).toHaveProperty('description');
    expect(result[0]).toHaveProperty('parameters');
  });
});

describe('applyBetaFlags', () => {
  it('returns prompt-caching flag for claude-sonnet-4-6', () => {
    const flags = applyBetaFlags('claude-sonnet-4-6');
    expect(flags).toContain('prompt-caching-2024-07-31');
  });

  it('returns prompt-caching flag for claude-opus-4-6', () => {
    const flags = applyBetaFlags('claude-opus-4-6');
    expect(flags).toContain('prompt-caching-2024-07-31');
  });

  it('returns empty array for unknown model', () => {
    const flags = applyBetaFlags('gpt-4o');
    expect(flags).toEqual([]);
  });

  it('returns empty array for kimi-k2.5', () => {
    const flags = applyBetaFlags('kimi-k2.5');
    expect(flags).toEqual([]);
  });
});

describe('shouldEnableCache', () => {
  it('returns true when bootstrap and model supports cache', () => {
    expect(shouldEnableCache(true, true)).toBe(true);
  });

  it('returns false when not bootstrap even if model supports cache', () => {
    expect(shouldEnableCache(false, true)).toBe(false);
  });

  it('returns false when model does not support cache even on bootstrap', () => {
    expect(shouldEnableCache(true, false)).toBe(false);
  });

  it('returns false when neither bootstrap nor cache support', () => {
    expect(shouldEnableCache(false, false)).toBe(false);
  });
});
