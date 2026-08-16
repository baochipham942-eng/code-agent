import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { TraceEventDataMap } from '../../../src/host/agent/runtime/turnTrace';
import {
  reconstructRequest,
  RequestNotReconstructableError,
} from '../../../src/host/evaluation/requestReplay';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

function fixture() {
  const system = 'stable';
  const dynamic = JSON.stringify({ role: 'system', content: 'tail', transient: true });
  const tools = JSON.stringify([{ name: 'Read', description: 'read', inputSchema: { type: 'object' } }]);
  const ledger: Message[] = [{ id: 'u1', role: 'user', content: 'hello', timestamp: 1 }];
  const manifest = {
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
  } satisfies TraceEventDataMap['request_manifest'];
  const readers = {
    getSystemPrompt: () => ({ content: system }),
    getContent: () => dynamic,
    getToolSchema: () => tools,
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
