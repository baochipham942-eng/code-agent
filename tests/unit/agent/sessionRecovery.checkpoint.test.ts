import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import {
  createCheckpointTemplate,
  ensureCheckpointStore,
  replaceSectionBody,
  resolveCheckpointStorePaths,
  writeCheckpointFile,
} from '../../../src/host/context/checkpoint';
import { SessionRecoveryService } from '../../../src/host/agent/sessionRecovery';

const dbMock = vi.hoisted(() => ({
  listSessions: vi.fn(),
  getMessages: vi.fn(),
}));

vi.mock('../../../src/host/services/core', () => ({
  getDatabase: () => dbMock,
}));

function msg(id: string, role: Message['role'], content: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    role,
    content,
    timestamp: Date.now(),
    ...extra,
  };
}

describe('SessionRecoveryService checkpoint rebuild', () => {
  it('rebuilds a new session from the previous session checkpoint', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'session-recovery-checkpoint-'));
    const workingDirectory = '/repo';
    const previousSessionId = 'previous-session';
    const paths = resolveCheckpointStorePaths({
      sessionId: previousSessionId,
      workingDirectory,
      rootDir,
    });
    await ensureCheckpointStore(paths);
    await writeCheckpointFile(
      paths.checkpointPath,
      replaceSectionBody(
        createCheckpointTemplate(),
        1,
        '> "implement checkpoint-writer + cross-session rebuild"',
      ),
    );
    dbMock.listSessions.mockReturnValue([
      {
        id: 'current-session',
        workingDirectory,
        updatedAt: Date.now(),
        title: 'current',
      },
      {
        id: previousSessionId,
        workingDirectory,
        updatedAt: Date.now() - 60_000,
        title: 'interrupted checkpoint work',
      },
    ]);
    dbMock.getMessages.mockReturnValue([
      msg('u1', 'user', 'implement checkpoint-writer + cross-session rebuild'),
      msg('a1', 'assistant', 'working on checkpoint service', {
        toolCalls: [{ id: 'tc1', name: 'apply_patch', arguments: {} }],
      }),
      msg('u2', 'user', 'continue the exact task'),
    ]);

    const service = new SessionRecoveryService({ checkpointRootDir: rootDir });
    const recovery = await service.checkPreviousSession('current-session', workingDirectory);

    expect(recovery).toContain('<checkpoint-rebuild>');
    expect(recovery).toContain('> "implement checkpoint-writer + cross-session rebuild"');
    expect(recovery).toContain('continue the exact task');
    expect(recovery).not.toContain('上次会话');
  });
});

