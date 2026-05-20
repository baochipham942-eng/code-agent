import { describe, expect, it, vi } from 'vitest';
import {
  buildInitialSubagentMessages,
  flattenMessageContent,
} from '../../../src/main/agent/subagentExecutorProjection';
import {
  createSubagentCancellationLifecycle,
  getSubagentExecutionTimeout,
} from '../../../src/main/agent/subagentExecutorCancellation';

describe('subagentExecutor helper extraction', () => {
  it('builds the same text-only system and user projection shape', () => {
    const messages = buildInitialSubagentMessages({
      agentName: 'Test Agent',
      systemPrompt: 'Use shared context from parent.',
      prompt: 'Inspect this file',
      attachments: [{
        type: 'file',
        category: 'not-real',
        name: 'notes.txt',
        data: 'hello',
        mimeType: 'text/plain',
      }],
    });

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'system',
      content: 'Use shared context from parent.',
      observation: {
        category: 'dependency_carry_over',
        sourceDetail: 'system_prompt',
        sourceKind: 'dependency_carry_over',
        layer: 'system_prompt',
      },
    });
    expect(messages[1]).toMatchObject({
      role: 'user',
      content: 'Inspect this file',
      observation: {
        category: 'attachment',
        sourceDetail: 'notes.txt',
        sourceKind: 'attachment',
        layer: 'attachment_input',
      },
    });
    expect(messages[1].attachments?.[0]).toMatchObject({
      type: 'file',
      category: 'other',
      name: 'notes.txt',
      mimeType: 'text/plain',
      data: 'hello',
    });
  });

  it('preserves multimodal image normalization and path hint projection', () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    const messages = buildInitialSubagentMessages({
      agentName: 'Vision Agent',
      systemPrompt: 'Look carefully.',
      prompt: 'What is in the image?',
      attachments: [{
        type: 'image',
        category: 'image',
        name: 'shot.png',
        data: 'data:image/png;base64,aGVsbG8=',
        mimeType: 'image/png',
        path: '/tmp/shot.png',
      }],
      logger,
    });

    const userMessage = messages[1];
    expect(userMessage.attachments?.[0]).toMatchObject({
      type: 'image',
      category: 'image',
      name: 'shot.png',
      mimeType: 'image/png',
      path: '/tmp/shot.png',
    });
    expect(userMessage.content).toEqual([
      { type: 'text', text: 'What is in the image?' },
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: 'aGVsbG8=',
        },
      },
      { type: 'text', text: '📍 图片文件路径: /tmp/shot.png' },
    ]);
    expect(logger.info).toHaveBeenCalledWith('[Vision Agent] Built multimodal message with 1/1 images');
    expect(flattenMessageContent(userMessage.content)).toContain('[image]');
  });

  it('keeps subagent timeout defaults and parent abort propagation intact', () => {
    expect(getSubagentExecutionTimeout('Coder')).toBe(120_000);
    expect(getSubagentExecutionTimeout('Unknown Agent')).toBe(90_000);
    expect(getSubagentExecutionTimeout('Coder', 1234)).toBe(1234);

    const parent = new AbortController();
    const lifecycle = createSubagentCancellationLifecycle({
      agentName: 'Test Agent',
      timeoutMs: 60_000,
      parentSignal: parent.signal,
    });

    parent.abort('parent-cancel');

    expect(lifecycle.effectiveSignal.aborted).toBe(true);
    expect(lifecycle.effectiveSignal.reason).toBe('parent-cancel');

    lifecycle.cleanupTimer();
    lifecycle.stopIdleWatchdog();
  });
});
