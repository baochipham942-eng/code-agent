import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { TraceEventDataMap } from '../../../src/host/agent/runtime/turnTrace';
import {
  reconstructRequest,
  RequestNotReconstructableError,
  type RequestReplayContentReaders,
} from '@internal-evaluation/host/evaluation/requestReplay';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const system = 'stable';
  const dynamic = JSON.stringify({ role: 'system', content: 'tail', transient: true });
  const tools = JSON.stringify([{ name: 'Read', description: 'read', inputSchema: { type: 'object' } }]);
  const ledger: Message[] = [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }];
  const manifest: TraceEventDataMap['request_manifest'] = {
    requestId: 'r1',
    messageRefs: [
      { kind: 'system_prompt', contentHash: hash(system) },
      { kind: 'ledger_message', messageId: 'u1' },
      { kind: 'content', contentHash: hash(dynamic), reason: 'dynamic_tail' },
    ],
    toolSchemaHash: hash(tools),
    toolNames: ['Read'],
    requested: { provider: 'openai', model: 'gpt-5.5', temperature: null, maxTokens: null, reasoningEffort: null, thinkingBudget: null },
    actualProvider: 'openai',
    actualModel: 'gpt-5.5',
    appVersion: '0.32.0',
    adapterDefaults: { engine: 'aisdk', temperature: null, maxTokens: null },
    compactionReplacements: [],
    degraded: false,
  };
  const readers: RequestReplayContentReaders = {
    getSystemPrompt: (_contentHash: string) => ({ content: system }),
    getContent: (_contentHash: string) => dynamic,
    getToolSchema: (_contentHash: string) => tools,
  };
  return { manifest, ledger, readers, dynamic, tools };
}

describe('reconstructRequest', () => {
  it('rebuilds prompt, ledger, content, and tool schema in canonical order', () => {
    const { manifest, ledger, readers, dynamic, tools } = fixture();
    const result = reconstructRequest(manifest, ledger, readers);

    expect(result.canonicalMessages).toEqual([
      JSON.stringify({ role: 'system', content: 'stable' }),
      JSON.stringify({ role: 'user', content: 'hello' }),
      dynamic,
    ]);
    expect(result.canonicalTools).toBe(tools);
  });

  it('rebuilds the P2 ordered-block content ref while retaining P1 full-content compatibility', () => {
    const value = fixture();
    const parts = [value.dynamic.slice(0, 18), value.dynamic.slice(18, 34), value.dynamic.slice(34)];
    const content = new Map(parts.map((part) => [hash(part), part]));
    value.manifest.messageRefs[2] = {
      kind: 'content',
      contentHash: hash(value.dynamic),
      reason: 'dynamic_tail',
      blocks: parts.map((part) => ({ contentHash: hash(part), bytes: Buffer.byteLength(part) })),
    };
    value.readers.getContent = (contentHash: string) => content.get(contentHash) ?? null;

    expect(reconstructRequest(value.manifest, value.ledger, value.readers).canonicalMessages[2])
      .toBe(value.dynamic);
  });

  it('fails loud when an ordered content block is missing', () => {
    const value = fixture();
    value.manifest.messageRefs[2] = {
      kind: 'content',
      contentHash: hash(value.dynamic),
      reason: 'dynamic_tail',
      blocks: [{ contentHash: hash('missing'), bytes: 7 }],
    };
    value.readers.getContent = () => null;

    expect(() => reconstructRequest(value.manifest, value.ledger, value.readers))
      .toThrow(RequestNotReconstructableError);
  });

  it('hydrates externalized attachment bytes and reproduces the original canonical message', () => {
    const value = fixture();
    const bytes = Buffer.from('image bytes');
    const base64 = bytes.toString('base64');
    const blobHash = createHash('sha256').update(bytes).digest('hex');
    const message = JSON.stringify({
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: base64 } }],
    });
    const structure = JSON.stringify({
      role: 'user',
      content: [{
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: { requestReplayAttachment: { index: 0, sha256: blobHash, bytes: bytes.byteLength } },
        },
      }],
    });
    value.manifest.messageRefs[2] = {
      kind: 'content',
      contentHash: hash(message),
      reason: 'post_assembly_rewrite',
      structureHash: hash(structure),
      attachmentBlobs: [{ version: 1, filePath: '/fixture/image.blob', sha256: blobHash, bytes: bytes.byteLength }],
    };
    value.readers.getContent = (contentHash: string) => contentHash === hash(structure) ? structure : null;
    value.readers.getAttachmentBlob = () => base64;

    expect(reconstructRequest(value.manifest, value.ledger, value.readers).canonicalMessages[2]).toBe(message);
  });

  it('fails loud when an attachment blob cannot be read', () => {
    const value = fixture();
    const structure = JSON.stringify({
      role: 'user',
      content: [{ type: 'image', source: { type: 'base64', data: { requestReplayAttachment: { index: 0, sha256: 'a', bytes: 1 } } } }],
    });
    value.manifest.messageRefs[2] = {
      kind: 'content', contentHash: hash('unavailable'), reason: 'post_assembly_rewrite',
      structureHash: hash(structure),
      attachmentBlobs: [{ version: 1, filePath: '/fixture/missing.blob', sha256: 'a', bytes: 1 }],
    };
    value.readers.getContent = () => structure;
    value.readers.getAttachmentBlob = () => null;

    expect(() => reconstructRequest(value.manifest, value.ledger, value.readers))
      .toThrow(RequestNotReconstructableError);
  });

  it.each([
    ['degraded manifest', (value: ReturnType<typeof fixture>) => { value.manifest.degraded = true; }],
    ['missing ledger id', (value: ReturnType<typeof fixture>) => { value.ledger.length = 0; }],
    ['tampered content byte', (value: ReturnType<typeof fixture>) => { value.readers.getContent = () => value.dynamic.replace('tail', 'tall'); }],
    ['missing tool schema', (value: ReturnType<typeof fixture>) => { value.readers.getToolSchema = () => null as never; }],
  ])('fails loud for %s', (_name, mutate) => {
    const value = fixture();
    mutate(value);
    expect(() => reconstructRequest(value.manifest, value.ledger, value.readers))
      .toThrow(RequestNotReconstructableError);
  });
});
