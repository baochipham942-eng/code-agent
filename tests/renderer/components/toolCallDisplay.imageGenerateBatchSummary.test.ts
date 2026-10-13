// ============================================================================
// toolCallDisplay.imageGenerateBatchSummary.test.ts
// image_generate 批量结果摘要读 outputImagePaths（返修 r1：批量输出路径改名，
// 不得再写/读 imagePaths——sessionMediaAssets 把它当输入素材血缘）。
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { ToolCall } from '../../../src/shared/contract';
import { summarizeTool } from '../../../src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/summarizers';

function imageGenerateCall(metadata: Record<string, unknown>): ToolCall {
  return {
    id: 'tc-image-batch',
    name: 'image_generate',
    arguments: { prompt: ['first', 'second'] },
    result: { toolCallId: 'tc-image-batch', success: true, metadata },
  } as ToolCall;
}

describe('summarizeTool image_generate batch metadata', () => {
  it('derives the +K more label from outputImagePaths', () => {
    expect(summarizeTool(imageGenerateCall({
      imagePath: '/repo/batch-1.png',
      outputPath: '/repo/batch-1.png',
      outputImagePaths: ['/repo/batch-1.png', '/repo/batch-2.png'],
    }))).toBe('batch-1.png +1 more');
  });

  it('keeps the single-image label unchanged', () => {
    expect(summarizeTool(imageGenerateCall({
      imagePath: '/repo/single.png',
      outputPath: '/repo/single.png',
    }))).toBe('single.png');
  });
});
