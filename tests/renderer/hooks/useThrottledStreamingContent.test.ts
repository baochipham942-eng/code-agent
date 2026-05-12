import { describe, expect, it } from 'vitest';
import {
  STREAMING_MARKDOWN_RENDER_THROTTLE_MS,
  shouldRenderStreamingContentAsMarkdown,
} from '../../../src/renderer/hooks/useThrottledStreamingContent';

describe('shouldRenderStreamingContentAsMarkdown', () => {
  it('keeps plain streaming text on the lightweight path', () => {
    expect(shouldRenderStreamingContentAsMarkdown('这是普通回答，正在平滑输出。')).toBe(false);
  });

  it('routes markdown syntax through the markdown renderer', () => {
    expect(shouldRenderStreamingContentAsMarkdown('## 标题')).toBe(true);
    expect(shouldRenderStreamingContentAsMarkdown('- item')).toBe(true);
    expect(shouldRenderStreamingContentAsMarkdown('看 [文档](https://example.com)')).toBe(true);
    expect(shouldRenderStreamingContentAsMarkdown('```ts\nconst x = 1')).toBe(true);
  });

  it('routes file paths and ticket ids through the markdown renderer', () => {
    expect(shouldRenderStreamingContentAsMarkdown('/Users/linchen/project/app.ts')).toBe(true);
    expect(shouldRenderStreamingContentAsMarkdown('CARTS-1234')).toBe(true);
  });

  it('uses a human-perceptible throttle window', () => {
    expect(STREAMING_MARKDOWN_RENDER_THROTTLE_MS).toBeGreaterThanOrEqual(80);
    expect(STREAMING_MARKDOWN_RENDER_THROTTLE_MS).toBeLessThanOrEqual(120);
  });
});
