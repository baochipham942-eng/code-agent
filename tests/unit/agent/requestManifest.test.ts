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
    compactionReplacements: [],
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

  it('records autocompact spliced ledger ids against the surviving compaction message', () => {
    const replacementLedger = transcriptMessage('compact-1', 'assistant', 'summary');
    replacementLedger.role = 'system';
    const replacement: ModelMessage = { role: 'system', content: 'summary' };
    const input = baseInput([replacement], ['compact-1'], [replacementLedger]);
    input.compactionReplacements = [{
      replacedMessageIds: ['user-old', 'assistant-old'],
      replacementMessageId: 'compact-1',
    }];

    const manifest = buildRequestManifest(input);

    expect(manifest.compactionReplacements).toEqual([{
      replacedMessageIds: ['user-old', 'assistant-old'],
      replacementContentHash: expect.any(String),
    }]);
  });

  it('marks the manifest degraded when content cache persistence fails', () => {
    const message: ModelMessage = { role: 'system', content: 'runtime only', transient: true };
    const input = baseInput([message], ['__dynamic_tail__'], []);
    input.contentStore = { store: vi.fn(() => false) };

    expect(buildRequestManifest(input).degraded).toBe(true);
  });

  it('stores dynamic tails as ordered deduplicated blocks without caching the full message', () => {
    const first: ModelMessage = {
      role: 'system',
      content: '<repo_map>stable</repo_map>\n\nsession one',
      transient: true,
    };
    const second: ModelMessage = {
      role: 'system',
      content: '<repo_map>stable</repo_map>\n\nsession two',
      transient: true,
    };
    const stored = new Map<string, string>();
    const firstInput = baseInput([first], ['__dynamic_tail__'], []);
    firstInput.contentStore = { store: vi.fn((hash, content) => (stored.set(hash, content), true)) };
    const secondInput = baseInput([second], ['__dynamic_tail__'], []);
    secondInput.contentStore = firstInput.contentStore;

    const firstRef = buildRequestManifest(firstInput).messageRefs[0];
    const secondRef = buildRequestManifest(secondInput).messageRefs[0];

    expect(firstRef).toMatchObject({ kind: 'content', reason: 'dynamic_tail' });
    expect(secondRef).toMatchObject({ kind: 'content', reason: 'dynamic_tail' });
    if (firstRef.kind !== 'content' || secondRef.kind !== 'content') throw new Error('expected content refs');
    expect(firstRef.blocks?.length).toBeGreaterThan(3);
    expect(secondRef.blocks?.map((block) => block.contentHash)).toContain(firstRef.blocks?.[1].contentHash);
    expect(stored.has(firstRef.contentHash)).toBe(false);
    expect(firstRef.blocks?.map((block) => stored.get(block.contentHash)).join(''))
      .toBe(canonicalizeModelMessage(first));
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

  it('externalizes attachment bytes and stores only placeholder structure in content_cache', () => {
    const base64 = Buffer.from('image bytes').toString('base64');
    const message: ModelMessage = {
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }],
    };
    const ledger = {
      id: 'user-image', role: 'user', content: 'look', timestamp: 1,
      attachments: [{ id: 'a1', type: 'image', category: 'image', name: 'a.png', size: 11, mimeType: 'image/png', data: base64 }],
    } as Message;
    const stored: string[] = [];
    const input = baseInput([message], ['user-image'], [ledger]);
    input.contentStore = { store: vi.fn((_hash, content) => (stored.push(content), true)) };
    input.attachmentBlobStore = {
      store: vi.fn(() => ({ version: 1 as const, filePath: '/tmp/blob', sha256: 'a'.repeat(64), bytes: 11 })),
    };

    const manifest = buildRequestManifest(input);
    const ref = manifest.messageRefs[0];

    expect(ref).toMatchObject({
      kind: 'content',
      structureHash: expect.any(String),
      attachmentBlobs: [{ sha256: 'a'.repeat(64), bytes: 11 }],
    });
    expect(stored).toHaveLength(1);
    expect(stored[0]).not.toContain(base64);
    expect(stored[0]).toContain('requestReplayAttachment');
    expect(manifest.degraded).toBe(false);
  });

  it('marks the manifest degraded without falling back to SQLite when attachment externalization fails', () => {
    const base64 = Buffer.from('image bytes').toString('base64');
    const message: ModelMessage = {
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }],
    };
    const store = vi.fn((_hash: string, _content: string) => true);
    const input = baseInput([message], ['runtime-image'], []);
    input.contentStore = { store };
    input.attachmentBlobStore = { store: vi.fn(() => null) };

    const manifest = buildRequestManifest(input);

    expect(manifest.degraded).toBe(true);
    expect(store.mock.calls.every(([, content]) => !String(content).includes(base64))).toBe(true);
  });

  it('uses ordered shared projections for ledger tool-result messages', () => {
    const ledger = {
      id: 'tool-1',
      role: 'tool',
      content: '',
      timestamp: 1,
      toolResults: [
        { toolCallId: 'call-1', success: true, output: 'one' },
        { toolCallId: 'call-2', success: false, error: 'two' },
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
