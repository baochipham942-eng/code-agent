import express from 'express';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionsRouter } from '../../../src/web/routes/sessions';
import {
  persistTerminalFrame,
  readTerminalFrame,
} from '../../../src/host/services/surfaceExecution/TerminalFrameStore';

describe('web sessions Supabase fallback terminal frame cleanup', () => {
  let dataDir = '';
  let previousDataDir: string | undefined;
  let server: http.Server | undefined;
  const updatedTables: string[] = [];

  beforeEach(async () => {
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'web-session-frames-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    updatedTables.length = 0;
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => server?.close((error) => (
        error ? reject(error) : resolve()
      )));
      server = undefined;
    }
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('deletes local frames before reporting a fallback Supabase conversation deletion', async () => {
    const selector = { conversationId: 'web-session', surfaceSessionId: 'surface-1' };
    await persistTerminalFrame(selector, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const supabase = {
      from(table: string) {
        const builder: Record<string, unknown> = {};
        builder.update = vi.fn(() => {
          updatedTables.push(table);
          return builder;
        });
        builder.eq = vi.fn(() => builder);
        builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({
          data: [],
          error: null,
        }));
        return builder;
      },
    };
    const app = express();
    app.use(express.json());
    app.use('/api', createSessionsRouter({
      logger: { warn: vi.fn(), error: vi.fn() },
      tryGetSessionManager: async () => null,
      getSupabaseForSession: async () => ({ supabase, userId: 'user-1' }),
    } as never));
    server = await new Promise<http.Server>((resolve) => {
      const started = app.listen(0, '127.0.0.1', () => resolve(started));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected test server address');

    const response = await fetch(`http://127.0.0.1:${address.port}/api/sessions/web-session`, {
      method: 'DELETE',
    });

    expect(await response.json()).toEqual({ success: true, data: null });
    expect(updatedTables).toEqual(['sessions', 'messages']);
    await expect(readTerminalFrame(selector)).resolves.toBeNull();
  });
});
