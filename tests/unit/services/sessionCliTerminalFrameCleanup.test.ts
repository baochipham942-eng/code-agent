import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  persistTerminalFrame,
  readTerminalFrame,
} from '../../../src/host/services/surfaceExecution/TerminalFrameStore';

const cliDb = vi.hoisted(() => ({
  isInitialized: true,
  deleteSession: vi.fn(),
}));

vi.mock('../../../src/cli/database', () => ({
  getCLIDatabase: () => cliDb,
}));

describe('CLISessionManager terminal frame cleanup', () => {
  let dataDir = '';
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cli-session-frames-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
    cliDb.deleteSession.mockReset();
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('deletes the conversation frame directory before deleting the CLI database row', async () => {
    const selector = { conversationId: 'cli-session', surfaceSessionId: 'surface-1' };
    await persistTerminalFrame(selector, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const { CLISessionManager } = await import('../../../src/cli/session');

    await new CLISessionManager().deleteSession('cli-session');

    await expect(readTerminalFrame(selector)).resolves.toBeNull();
    expect(cliDb.deleteSession).toHaveBeenCalledWith('cli-session');
  });
});
