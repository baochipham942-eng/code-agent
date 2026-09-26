import { afterEach, describe, expect, it, vi } from 'vitest';
import { beginHumanWait, endHumanWait, isHumanWaitActive } from '../../../src/host/services/infra/timeoutController';
import {
  buildInferenceMessages,
  buildInitialSubagentMessages,
  createRuntimeMessage,
  flattenMessageContent,
} from '../../../src/host/agent/subagentExecutorProjection';
import {
  createSubagentCancellationLifecycle,
  getSubagentExecutionTimeout,
} from '../../../src/host/agent/subagentExecutorCancellation';

describe('subagentExecutor helper extraction', () => {
  afterEach(() => {
    while (isHumanWaitActive()) endHumanWait();
    vi.useRealTimers();
  });

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
      observation: {
        category: 'dependency_carry_over',
        sourceDetail: 'system_prompt',
        sourceKind: 'dependency_carry_over',
        layer: 'system_prompt',
      },
    });
    expect(messages[0].content).toContain('Use shared context from parent.');
    expect(messages[0].content).toContain('你的最终输出是返回给父 agent 的数据');
    expect(messages[0].content).toContain('只返回结论、关键文件路径和必要证据');
    expect(messages[0].content).toContain('不要转发原始文件内容');
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
    expect(getSubagentExecutionTimeout('Coder')).toBe(900_000);
    expect(getSubagentExecutionTimeout('Unknown Agent')).toBe(900_000);
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

  it('pauses the subagent total timeout while a human wait is active', async () => {
    vi.useFakeTimers();
    const lifecycle = createSubagentCancellationLifecycle({
      agentName: 'Wait Agent',
      timeoutMs: 100,
    });

    beginHumanWait();
    await vi.advanceTimersByTimeAsync(500);
    expect(lifecycle.effectiveSignal.aborted).toBe(false);

    endHumanWait();
    await vi.advanceTimersByTimeAsync(100);
    expect(lifecycle.effectiveSignal.aborted).toBe(true);
    expect(lifecycle.effectiveSignal.reason).toBe('timeout');

    lifecycle.cleanupTimer();
    lifecycle.stopIdleWatchdog();
  });

  it('does not re-project Read results in buildInferenceMessages', () => {
    const output = 'Tool results:\nTool Read: Success\nRead version digest: abc123\n  1\talpha';
    const readCall = (id: string) => ({
      id,
      name: 'Read' as const,
      arguments: { file_path: '/tmp/example.ts', offset: 1, limit: 2 },
    });
    const inferred = buildInferenceMessages([
      createRuntimeMessage({ role: 'assistant', content: '', toolCalls: [readCall('c1')] }),
      createRuntimeMessage({ role: 'user', content: output }),
      createRuntimeMessage({ role: 'assistant', content: '', toolCalls: [readCall('c2')] }),
      createRuntimeMessage({ role: 'user', content: output }),
    ]);
    expect(inferred[3]?.content).toBe(output);
    expect(String(inferred[3]?.content)).not.toContain('[Read already shown');
  });
});
