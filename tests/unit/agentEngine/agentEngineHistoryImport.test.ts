import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentEngineHistoryImportService } from '../../../src/host/services/agentEngine/agentEngineHistoryImport';
import {
  decodeSessionExportEnvelopeV2,
  rehashSessionExportEnvelopeV2,
} from '../../../src/host/services/sessionFork/portability/codec';

const tempRoots: string[] = [];

describe('AgentEngineHistoryImportService', () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it('lists recent Codex CLI history summaries without launching Codex', async () => {
    const roots = await createHistoryRoots();
    const sourcePath = path.join(
      roots.codex,
      '2026',
      '05',
      '16',
      'rollout-2026-05-16T09-00-00-019f1111-2222-7333-8444-555555555555.jsonl',
    );
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, [
      JSON.stringify({
        type: 'session_meta',
        payload: {
          id: 'codex-session-1',
          cwd: '/Users/linchen/Downloads/ai/code-agent',
          timestamp: '2026-05-16T09:00:00.000Z',
          cli_version: '0.130.0',
        },
      }),
      JSON.stringify({
        type: 'turn_context',
        payload: { model: 'gpt-5', sandbox_policy: 'read-only' },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'user_message',
          message: 'Plan external import preview',
          timestamp: '2026-05-16T09:00:02.000Z',
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'agent_message',
          message: 'Import preview ready.',
          timestamp: '2026-05-16T09:00:03.000Z',
        },
      }),
    ].join('\n'));

    const service = new AgentEngineHistoryImportService({
      roots: { codexSessionsRoot: roots.codex, claudeProjectsRoot: roots.claude },
    });

    const result = await service.listHistory({ engine: 'codex_cli' });

    expect(result.limit).toBe(20);
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      engineKind: 'codex_cli',
      externalSessionId: 'codex-session-1',
      sourcePath,
      title: 'Plan external import preview',
      messageCount: 2,
      cwd: '/Users/linchen/Downloads/ai/code-agent',
      workingDirectory: '/Users/linchen/Downloads/ai/code-agent',
      canImport: true,
      diagnostics: [],
    });

    const preview = await service.previewHistory({ engine: 'codex_cli', externalSessionId: 'codex-session-1' });
    expect(preview.preview.messages.map((message) => ({ role: message.role, text: message.text }))).toEqual([
      { role: 'user', text: 'Plan external import preview' },
      { role: 'assistant', text: 'Import preview ready.' },
    ]);
  });

  it('previews Claude Code history as normalized user and assistant messages', async () => {
    const roots = await createHistoryRoots();
    const sourcePath = path.join(roots.claude, '-Users-linchen-Downloads-ai-code-agent', 'claude-session-1.jsonl');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, [
      JSON.stringify({
        type: 'user',
        uuid: 'u1',
        parentUuid: null,
        sessionId: 'claude-session-1',
        timestamp: '2026-05-16T10:00:00.000Z',
        cwd: '/Users/linchen/Downloads/ai/code-agent',
        message: { content: 'Review imported history' },
      }),
      JSON.stringify({
        type: 'assistant',
        uuid: 'a1',
        parentUuid: 'u1',
        sessionId: 'claude-session-1',
        timestamp: '2026-05-16T10:00:02.000Z',
        cwd: '/Users/linchen/Downloads/ai/code-agent',
        message: {
          model: 'claude-sonnet',
          content: [{ type: 'text', text: 'History preview looks usable.' }],
        },
      }),
    ].join('\n'));

    const service = new AgentEngineHistoryImportService({
      roots: { codexSessionsRoot: roots.codex, claudeProjectsRoot: roots.claude },
    });

    const result = await service.previewHistory({ engine: 'claude_code', sourcePath });

    expect(result.summary).toMatchObject({
      engineKind: 'claude_code',
      externalSessionId: 'claude-session-1',
      sourcePath,
      title: 'Review imported history',
      messageCount: 2,
      cwd: '/Users/linchen/Downloads/ai/code-agent',
      workingDirectory: '/Users/linchen/Downloads/ai/code-agent',
      canImport: true,
    });
    expect(result.preview.messages).toEqual([
      {
        role: 'user',
        text: 'Review imported history',
        timestamp: new Date('2026-05-16T10:00:00.000Z').getTime(),
      },
      {
        role: 'assistant',
        text: 'History preview looks usable.',
        timestamp: new Date('2026-05-16T10:00:02.000Z').getTime(),
      },
    ]);
  });

  it('maps a synthetic Claude history to a decoded provenance-tagged envelope', async () => {
    const roots = await createHistoryRoots();
    const sourcePath = path.join(roots.claude, 'synthetic-project', 'claude-import.jsonl');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, [
      JSON.stringify({
        type: 'user', uuid: 'claude-user-1', sessionId: 'claude-import', timestamp: '2026-05-16T10:00:00.000Z',
        cwd: '/synthetic/workspace',
        message: { content: [{ type: 'text', text: 'first paragraph\r\n\r\nsecond paragraph' }] },
      }),
      JSON.stringify({
        type: 'assistant', uuid: 'claude-assistant-1', sessionId: 'claude-import', timestamp: '2026-05-16T10:00:01.000Z',
        message: { content: [{ type: 'thinking', thinking: 'private thought' }, { type: 'text', text: 'assistant reply' }, { type: 'tool_use', id: 'tool-1', name: 'synthetic_tool', input: {} }] },
      }),
      JSON.stringify({
        type: 'user', uuid: 'claude-tool-result', sessionId: 'claude-import', timestamp: '2026-05-16T10:00:02.000Z',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'tool output' }] },
      }),
      JSON.stringify({ type: 'system', uuid: 'system-1', sessionId: 'claude-import', timestamp: '2026-05-16T10:00:03.000Z', subtype: 'turn_duration' }),
    ].join('\n'));

    const service = new AgentEngineHistoryImportService({
      roots: { codexSessionsRoot: roots.codex, claudeProjectsRoot: roots.claude },
    });
    const result = await service.mapHistoryForImport({
      engine: 'claude_code', sourcePath, ownerScopeId: 'synthetic-owner', projectId: 'synthetic-project',
    });
    const decoded = decodeSessionExportEnvelopeV2(JSON.stringify(result.envelope), {
      ownerScopeId: 'synthetic-owner', projectId: 'synthetic-project',
    });

    expect(decoded.sessions[0].origin?.metadata).toEqual(result.provenance);
    expect(decoded.messages.map((message) => message.content)).toEqual([
      'first paragraph\n\nsecond paragraph',
      'assistant reply',
    ]);
    expect(decoded.messages[1].thinking).toBe('private thought');
    expect(decoded.messages.flatMap((message) => message.contentParts ?? []).some((part) => part.type === 'tool_call')).toBe(false);
  });

  it('maps a synthetic Codex rollout to a decoded envelope and drops tool records', async () => {
    const roots = await createHistoryRoots();
    const sourcePath = path.join(roots.codex, '2026', '05', '16', 'rollout-2026-05-16T10-00-00-synthetic-codex.jsonl');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, [
      JSON.stringify({ type: 'session_meta', payload: { id: 'synthetic-codex', cwd: '/synthetic/workspace', timestamp: '2026-05-16T10:00:00.000Z' } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'synthetic-codex-model', sandbox_policy: 'read-only' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: 'codex user', timestamp: '2026-05-16T10:00:01.000Z' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call', call_id: 'tool-2', name: 'synthetic_tool', arguments: '{}' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'tool-2', output: 'tool output' } }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', message: 'codex answer', timestamp: '2026-05-16T10:00:02.000Z' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', summary: [{ type: 'summary_text', text: 'codex thought' }] } }),
    ].join('\n'));

    const service = new AgentEngineHistoryImportService({
      roots: { codexSessionsRoot: roots.codex, claudeProjectsRoot: roots.claude },
    });
    const result = await service.mapHistoryForImport({
      engine: 'codex_cli', sourcePath, ownerScopeId: 'synthetic-owner', projectId: 'synthetic-project',
    });
    const decoded = decodeSessionExportEnvelopeV2(JSON.stringify(result.envelope));

    expect(decoded.sessions[0].origin?.metadata).toEqual(result.provenance);
    expect(decoded.messages.map((message) => message.content)).toEqual(['codex user', 'codex answer', '']);
    expect(decoded.messages[2].thinking).toBe('codex thought');
    expect(decoded.messages.flatMap((message) => message.contentParts ?? []).some((part) => part.type === 'tool_call')).toBe(false);
  });

  it('rejects histories whose messages are all dropped loss classes', async () => {
    const roots = await createHistoryRoots();
    const sourcePath = path.join(roots.claude, 'synthetic-project', 'tools-only.jsonl');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, JSON.stringify({
      type: 'assistant', uuid: 'tool-only', sessionId: 'tools-only', timestamp: '2026-05-16T10:00:00.000Z',
      message: { content: [{ type: 'tool_use', id: 'tool-3', name: 'synthetic_tool', input: {} }] },
    }));
    const service = new AgentEngineHistoryImportService({
      roots: { codexSessionsRoot: roots.codex, claudeProjectsRoot: roots.claude },
    });

    await expect(service.mapHistoryForImport({
      engine: 'claude_code', sourcePath, ownerScopeId: 'synthetic-owner', projectId: 'synthetic-project',
    })).rejects.toMatchObject({ code: 'NO_IMPORTABLE_MESSAGES' });
  });

  it('rejects malformed external-history provenance on decode', async () => {
    const roots = await createHistoryRoots();
    const sourcePath = path.join(roots.claude, 'synthetic-project', 'provenance.jsonl');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, JSON.stringify({
      type: 'user', uuid: 'provenance-user', sessionId: 'provenance', timestamp: '2026-05-16T10:00:00.000Z',
      message: { content: 'synthetic message' },
    }));
    const service = new AgentEngineHistoryImportService({
      roots: { codexSessionsRoot: roots.codex, claudeProjectsRoot: roots.claude },
    });
    const result = await service.mapHistoryForImport({
      engine: 'claude_code', sourcePath, ownerScopeId: 'synthetic-owner', projectId: 'synthetic-project',
    });
    const extra = structuredClone(result.envelope);
    (extra.sessions[0].origin!.metadata as unknown as Record<string, unknown>).extra = 'rejected';
    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify(rehashSessionExportEnvelopeV2(extra)))).toThrow('INVALID_ENVELOPE');
    const wrongKind = structuredClone(result.envelope);
    (wrongKind.sessions[0].origin!.metadata as unknown as Record<string, unknown>).kind = 'other';
    expect(() => decodeSessionExportEnvelopeV2(JSON.stringify(rehashSessionExportEnvelopeV2(wrongKind)))).toThrow('INVALID_ENVELOPE');
  });

  it('keeps listHistory alive when a parser fails for one source file', async () => {
    const roots = await createHistoryRoots();
    const sourcePath = path.join(roots.claude, '-tmp-project', 'broken-session.jsonl');
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, '{"type":"user"}\n');

    const service = new AgentEngineHistoryImportService({
      roots: { codexSessionsRoot: roots.codex, claudeProjectsRoot: roots.claude },
      parsers: {
        parseClaudeSession: async () => {
          throw new Error('synthetic parser failure');
        },
      },
    });

    const result = await service.listHistory({ engine: 'claude_code', limit: 5 });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      engineKind: 'claude_code',
      externalSessionId: 'broken-session',
      sourcePath,
      messageCount: 0,
      canImport: false,
    });
    expect(result.items[0].diagnostics).toEqual([
      {
        level: 'error',
        code: 'SESSION_PARSE_FAILED',
        message: 'synthetic parser failure',
        sourcePath,
      },
    ]);
  });
});

async function createHistoryRoots(): Promise<{ codex: string; claude: string }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-engine-history-'));
  tempRoots.push(root);
  const codex = path.join(root, 'codex-sessions');
  const claude = path.join(root, 'claude-projects');
  await fs.mkdir(codex, { recursive: true });
  await fs.mkdir(claude, { recursive: true });
  return { codex, claude };
}
