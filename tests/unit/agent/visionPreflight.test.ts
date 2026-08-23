import { describe, expect, it, vi } from 'vitest';
import type { ContextAssemblyCtx } from '../../../src/host/agent/runtime/contextAssembly';
import { preflightImagesForMainModel } from '../../../src/host/agent/runtime/contextAssembly/visionPreflight';
import type { ModelMessage } from '../../../src/host/agent/loopTypes';

function image(data: string) {
  return {
    type: 'image' as const,
    source: {
      type: 'base64' as const,
      media_type: 'image/png' as const,
      data,
    },
  };
}

describe('vision preflight summary scope', () => {
  it('adds the current summary only to the analyzed user message in three image turns', async () => {
    const modelMessages: ModelMessage[] = [
      { role: 'user', content: [{ type: 'text', text: 'first turn' }, image('old-1')] },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: [{ type: 'text', text: 'second turn' }, image('old-2')] },
      { role: 'assistant', content: 'second answer' },
      { role: 'user', content: [{ type: 'text', text: 'current turn' }, image('current')] },
    ];
    const ctx = {
      runtime: { control: {} },
    } as unknown as ContextAssemblyCtx;
    const runInference = vi.fn().mockResolvedValue({
      type: 'text',
      content: 'CURRENT_TURN_SUMMARY',
      finishReason: 'stop',
    });

    const result = await preflightImagesForMainModel(
      ctx,
      modelMessages,
      {
        provider: 'openai',
        model: 'vision-model',
        apiKey: 'test-key',
        maxTokens: 4096,
      },
      'describe the current image',
      runInference,
    );

    expect(result).not.toBeNull();
    const projected = result!.filter((message) => message.role === 'user').map((message) =>
      JSON.stringify(message.content),
    );
    expect(projected[0]).toContain('old-1');
    expect(projected[0]).not.toContain('CURRENT_TURN_SUMMARY');
    expect(projected[1]).toContain('old-2');
    expect(projected[1]).not.toContain('CURRENT_TURN_SUMMARY');
    expect(projected[2]).not.toContain('"data":"current"');
    expect(projected[2]).toContain('CURRENT_TURN_SUMMARY');
    expect(projected.filter((content) => content.includes('CURRENT_TURN_SUMMARY'))).toHaveLength(1);
  });
});
