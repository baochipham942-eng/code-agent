import { describe, expect, it } from 'vitest';
import {
  fingerprintToolTable,
  sampleWithToolsFingerprint,
} from '../../../src/host/agent/runtime/toolTableFingerprint';

const append = {
  name: 'Append',
  description: '往文件尾部追加内容',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['path'],
  },
  requiresPermission: true,
};

const read = {
  name: 'Read',
  description: 'read a file',
  inputSchema: {
    type: 'object',
    properties: { path: { type: 'string' } },
  },
};

describe('fingerprintToolTable', () => {
  it('is stable across repeated calls and object key order', () => {
    const first = fingerprintToolTable([append, read]);
    const appendRekeyed = {
      name: 'Append',
      description: '往文件尾部追加内容',
      inputSchema: {
        required: ['path'],
        properties: {
          text: { type: 'string' },
          path: { type: 'string' },
        },
        type: 'object',
      },
      requiresPermission: false,
    };
    const readRekeyed = {
      name: 'Read',
      description: 'read a file',
      inputSchema: { properties: { path: { type: 'string' } }, type: 'object' },
    };
    const second = fingerprintToolTable([appendRekeyed, readRekeyed]);

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(fingerprintToolTable([append, read])).toBe(first);
  });

  it('changes when a tool is added, removed, reordered, or its description or schema changes', () => {
    const baseline = fingerprintToolTable([append, read]);
    expect(fingerprintToolTable([append])).not.toBe(baseline);
    expect(fingerprintToolTable([read])).not.toBe(baseline);
    expect(fingerprintToolTable([read, append])).not.toBe(baseline);
    expect(fingerprintToolTable([
      { ...append, description: 'append bytes' },
      read,
    ])).not.toBe(baseline);
    expect(fingerprintToolTable([
      {
        ...append,
        inputSchema: {
          type: 'object',
          properties: { path: { type: 'string' }, text: { type: 'number' } },
          required: ['path'],
        },
      },
      read,
    ])).not.toBe(baseline);
  });
});

describe('sampleWithToolsFingerprint', () => {
  it('keeps a stamped fingerprint when the prompt sample is replaced', () => {
    const sample = sampleWithToolsFingerprint(
      { toolsFingerprint: 'fp-sent' },
      { prompt: 'stable', modelId: 'deepseek-v4-pro' },
    );
    expect(sample).toEqual({
      prompt: 'stable',
      modelId: 'deepseek-v4-pro',
      toolsFingerprint: 'fp-sent',
    });
  });

  it('omits the field when no tool table was sent', () => {
    const sample = sampleWithToolsFingerprint({}, { prompt: 'stable', modelId: 'deepseek-v4-pro' });
    expect(sample).toEqual({ prompt: 'stable', modelId: 'deepseek-v4-pro' });
    expect(sample).not.toHaveProperty('toolsFingerprint');
  });
});
