import { describe, expect, it } from 'vitest';
import type { NeoUIInstanceV1 } from '../../../src/shared/contract/generativeUI';
import type { Message } from '../../../src/shared/contract/message';
import {
  materializeGenerativeUIFallbacks,
  toGenerativeUIExportSnapshot,
} from '../../../src/host/services/generativeUI/generativeUIExport';

function instance(): NeoUIInstanceV1 {
  return {
    schemaVersion: 1,
    instanceId: 'local-instance',
    sessionId: 'session-secret',
    sourceMessageId: 'm1',
    sourceOrdinal: 0,
    sourceKey: 'm1:0:hash',
    specHash: 'hash',
    origin: 'model',
    spec: {
      schemaVersion: 1,
      components: [{ id: 'choice', type: 'ChoiceGroup' }],
      fallback: 'Choose a deployment mode.',
    },
    state: { choice: 'safe', apiToken: 'sk-secret-value' },
    stateRevision: 2,
    status: 'active',
    createdAt: 1,
    updatedAt: 2,
  };
}

describe('Generative UI export', () => {
  it('exports portable spec and redacted state without local authority fields', () => {
    const snapshot = toGenerativeUIExportSnapshot(instance());
    expect(snapshot).toMatchObject({ sourceMessageId: 'm1', stateRevision: 2, state: { choice: 'safe' } });
    expect(JSON.stringify(snapshot)).not.toContain('sk-secret-value');
    expect(snapshot).not.toHaveProperty('instanceId');
    expect(snapshot).not.toHaveProperty('sessionId');
    expect(snapshot).not.toHaveProperty('nonce');
  });

  it('materializes fallback plus current primitive selections for Markdown export', () => {
    const messages: Message[] = [{
      id: 'm1',
      role: 'assistant',
      timestamp: 1,
      content: 'Before\n```neo_ui\n{"schemaVersion":1,"components":[],"fallback":"Fallback"}\n```\nAfter',
    }];
    const [exported] = materializeGenerativeUIFallbacks(messages, [instance()]);
    expect(exported.content).toContain('Choose a deployment mode.');
    expect(exported.content).toContain('当前交互状态：choice: safe');
    expect(exported.content).not.toContain('```neo_ui');
    expect(exported.content).not.toContain('sk-secret-value');
  });
});
