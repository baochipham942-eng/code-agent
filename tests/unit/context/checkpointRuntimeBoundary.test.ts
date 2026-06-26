import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import { CompressionState } from '../../../src/host/context/compressionState';
import {
  createCheckpointTemplate,
  ensureCheckpointStore,
  replaceSectionBody,
  resolveCheckpointStorePaths,
  tryInsertCheckpointRebuildBoundary,
  writeCheckpointFile,
} from '../../../src/host/context/checkpoint';

vi.mock('../../../src/host/context/contextEventLedger', () => ({
  getContextEventLedger: () => ({
    upsertEvents: vi.fn(),
  }),
}));

function msg(id: string, role: Message['role'], content: string): Message {
  return { id, role, content, timestamp: Date.now() };
}

describe('checkpoint runtime boundary', () => {
  it('inserts a meta rebuild boundary and preserves the recent tail', async () => {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'checkpoint-boundary-'));
    const sessionId = 'session-boundary';
    const workingDirectory = '/repo';
    const paths = resolveCheckpointStorePaths({ sessionId, workingDirectory, rootDir });
    await ensureCheckpointStore(paths);
    await writeCheckpointFile(
      paths.checkpointPath,
      replaceSectionBody(createCheckpointTemplate(), 1, '> "implement checkpoint rebuild"'),
    );
    const persisted: Message[] = [];
    const events: unknown[] = [];
    const runtime = {
      sessionId,
      workingDirectory,
      messages: [
        msg('u1', 'user', 'old request'),
        msg('a1', 'assistant', 'old answer'),
        msg('u2', 'user', 'middle request'),
        msg('a2', 'assistant', 'middle answer'),
        msg('u3', 'user', 'recent request'),
        msg('a3', 'assistant', 'recent answer '.repeat(50_000)),
        msg('u4', 'user', 'next request'),
      ],
      onEvent: vi.fn((event) => events.push(event)),
      persistMessage: vi.fn(async (message: Message) => {
        persisted.push(message);
      }),
      compressionState: new CompressionState(),
      checkpointRootDir: rootDir,
    };

    const result = await tryInsertCheckpointRebuildBoundary(runtime);

    expect(result.inserted).toBe(true);
    expect(runtime.messages[0]).toEqual(expect.objectContaining({
      role: 'system',
      isMeta: true,
      content: expect.stringContaining('<checkpoint-rebuild>'),
    }));
    expect(runtime.messages.map((message) => message.id).slice(1)).toEqual(['u3', 'a3', 'u4']);
    expect(persisted).toHaveLength(1);
    expect(events).toEqual([
      expect.objectContaining({
        type: 'context_compressed',
        data: expect.objectContaining({ strategy: 'checkpoint_rebuild_boundary' }),
      }),
    ]);
  });
});
