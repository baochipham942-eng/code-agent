import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { computeBucketSummary, extractContextItems } from '../../../src/renderer/utils/contextBuckets';

describe('contextBuckets', () => {
  it('counts unique concrete files instead of file tool names', () => {
    const messages = [
      {
        toolCalls: [
          { name: 'Write', arguments: { file_path: '/tmp/raiden_test/breakout-cu.html' } },
          { name: 'Read', arguments: { path: '/tmp/raiden_test/breakout-cu.html' } },
          { name: 'Edit', arguments: { file_path: '/tmp/raiden_test/breakout-cu.html' } },
          { name: 'Read', arguments: { path: '/tmp/raiden_test/validation-result.json' } },
        ],
      },
    ] as unknown as Message[];

    const items = extractContextItems(messages);
    const summary = computeBucketSummary(messages);

    expect(summary.files).toBe(2);
    expect(items.filter((item) => item.bucket === 'files').map((item) => item.path)).toEqual([
      '/tmp/raiden_test/breakout-cu.html',
      '/tmp/raiden_test/breakout-cu.html',
      '/tmp/raiden_test/breakout-cu.html',
      '/tmp/raiden_test/validation-result.json',
    ]);
  });

  it('does not turn pathless tool calls into file or other context entries', () => {
    const messages = [
      {
        toolCalls: [
          { name: 'Write', arguments: {} },
          { name: 'Read', arguments: {} },
          { name: 'Edit', arguments: {} },
          { name: 'Bash', arguments: { command: 'node validate.js' } },
        ],
      },
    ] as unknown as Message[];

    expect(extractContextItems(messages)).toEqual([]);
    expect(computeBucketSummary(messages)).toEqual({
      rules: 0,
      files: 0,
      web: 0,
      other: 0,
    });
  });
});
