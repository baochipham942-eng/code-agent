import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentEngineHistoryImportService } from '../../../src/main/services/agentEngine/agentEngineHistoryImport';

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
