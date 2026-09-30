import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { ContextAssembly } from '../../../src/host/agent/runtime/contextAssembly';
import { persistFailedRunContinuationContext } from '../../../src/host/agent/runtime/conversationRuntimeContextBootstrap';

describe('persistFailedRunContinuationContext', () => {
  it('persists a plain-object failure as readable text', async () => {
    const added: Message[] = [];
    const contextAssembly = {
      addAndPersistMessage: async (message: Message) => {
        added.push(message);
      },
    } as unknown as ContextAssembly;

    await persistFailedRunContinuationContext(
      contextAssembly,
      'draw a cat',
      3,
      { code: 'X', message: 'boom' },
    );

    expect(added).toHaveLength(1);
    const marker = added[0];
    expect(marker.role).toBe('system');
    expect(marker.isMeta).toBe(true);
    expect(marker.content).toContain('draw a cat');
    expect(marker.content).toContain('boom');
    expect(marker.content).not.toContain('[object Object]');
  });
});
