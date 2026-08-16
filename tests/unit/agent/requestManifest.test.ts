import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { ModelMessage } from '../../../src/host/agent/loopTypes';
import {
  buildRequestManifest,
  canonicalizeModelMessage,
  type RequestManifestBuildInput,
} from '../../../src/host/agent/runtime/contextAssembly/requestManifestBuilder';

function transcriptMessage(id: string, role: 'user' | 'assistant', content: string): Message {
  return { id, role, content, timestamp: 1 } as Message;
}

function baseInput(
  messages: ModelMessage[],
  sourceIds: string[],
  transcriptMessages: Message[],
): RequestManifestBuildInput {
  return {
    requestId: 'llm-test',
    messages,
    assembledCanonicalMessages: messages.map(canonicalizeModelMessage),
    sourceIds,
    transcriptMessages,
    collapsedSpans: [],
    toolSchemaHash: 'f'.repeat(64),
    toolNames: ['Read'],
    requestConfig: { provider: 'openai', model: 'gpt-5.5', maxTokens: 8192 },
    appVersion: '0.32.0',
    engine: 'aisdk' as const,
    contentStore: { store: vi.fn(() => true) },
    systemPromptStore: { get: vi.fn(() => ({ content: 'stable prompt' })) },
  };
}

describe('buildRequestManifest', () => {
  it('keeps sequence while choosing prompt, ledger, and content references', () => {
    const user = transcriptMessage('user-1', 'user', 'hello');
    const assembled: ModelMessage[] = [
      { role: 'system', content: 'stable prompt' },
      { role: 'user', content: 'hello' },
      { role: 'system', content: 'dynamic tail', transient: true },
    ];
    const finalMessages = [...assembled, { role: 'system', content: 'finish now', transient: true }];
    const input = baseInput(finalMessages, ['__system_prompt__', 'user-1', '__dynamic_tail__'], [user]);
    input.assembledCanonicalMessages = assembled.map(canonicalizeModelMessage);

    const manifest = buildRequestManifest(input);

    expect(manifest.messageRefs.map((ref) => ref.kind)).toEqual([
      'system_prompt', 'ledger_message', 'content', 'content',
    ]);
    expect(manifest.messageRefs[1]).toEqual({ kind: 'ledger_message', messageId: 'user-1' });
    expect(manifest.messageRefs[2]).toMatchObject({ kind: 'content', reason: 'dynamic_tail' });
    expect(manifest.messageRefs[3]).toMatchObject({ kind: 'content', reason: 'post_assembly_rewrite' });
    expect(manifest.degraded).toBe(false);
  });

  it('records collapsed ledger ids against the replacement content hash', () => {
    const first = transcriptMessage('user-1', 'user', 'original one');
    const second = transcriptMessage('assistant-1', 'assistant', 'original two');
    const original: ModelMessage = { role: 'user', content: 'original one' };
    const replacement: ModelMessage = { role: 'system', content: '[collapsed: 2 turns] summary' };
    const input = baseInput([replacement], ['user-1'], [first, second]);
    input.assembledCanonicalMessages = [canonicalizeModelMessage(original)];
    input.collapsedSpans = [{ messageIds: ['user-1', 'assistant-1'], summary: 'summary' }];

    const manifest = buildRequestManifest(input);

    const ref = manifest.messageRefs[0];
    expect(ref.kind).toBe('content');
    expect(manifest.compactionReplacements).toEqual([{
      replacedMessageIds: ['user-1', 'assistant-1'],
      replacementContentHash: ref.kind === 'content' ? ref.contentHash : '',
    }]);
  });

  it('marks the manifest degraded when content cache persistence fails', () => {
    const message: ModelMessage = { role: 'system', content: 'runtime only', transient: true };
    const input = baseInput([message], ['__dynamic_tail__'], []);
    input.contentStore = { store: vi.fn(() => false) };

    expect(buildRequestManifest(input).degraded).toBe(true);
  });

  it('falls back to verbatim content when the prompt cache cannot return the hash original', () => {
    const message: ModelMessage = { role: 'system', content: 'token sk-secret' };
    const input = baseInput([message], ['__system_prompt__'], []);
    input.systemPromptStore = { get: vi.fn(() => ({ content: 'token [secret hidden]' })) };
    const store = vi.fn(() => true);
    input.contentStore = { store };

    const manifest = buildRequestManifest(input);

    expect(manifest.messageRefs[0]).toMatchObject({
      kind: 'content',
      reason: 'system_prompt_fallback',
    });
    expect(store).toHaveBeenCalledWith(expect.any(String), canonicalizeModelMessage(message));
  });

  it('uses ordered shared projections for ledger tool-result messages', () => {
    const ledger = {
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 1,
      toolResults: [
        { toolCallId: 'call-1', toolName: 'Read', success: true, output: 'one' },
        { toolCallId: 'call-2', toolName: 'Read', success: false, error: 'two' },
      ],
    } as Message;
    const messages: ModelMessage[] = [
      { role: 'tool', content: 'one', toolCallId: 'call-1' },
      { role: 'tool', content: 'two', toolCallId: 'call-2', toolError: true },
    ];
    const input = baseInput(messages, ['tool-1', 'tool-1'], [ledger]);

    expect(buildRequestManifest(input).messageRefs).toEqual([
      { kind: 'ledger_message', messageId: 'tool-1' },
      { kind: 'ledger_message', messageId: 'tool-1' },
    ]);
  });
});
