import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteTerminalFramesForConversation,
  deleteAllTerminalFrames,
  getTerminalFrameDirectory,
  getTerminalFramePath,
  persistTerminalFrame,
  readTerminalFrame,
} from '../../../../src/host/services/surfaceExecution/TerminalFrameStore';

const JPEG_A = Buffer.from([0xff, 0xd8, 0x01, 0xff, 0xd9]);
const JPEG_B = Buffer.from([0xff, 0xd8, 0x02, 0xff, 0xd9]);

describe('TerminalFrameStore', () => {
  let dataDir = '';
  let previousDataDir: string | undefined;

  beforeEach(async () => {
    previousDataDir = process.env.CODE_AGENT_DATA_DIR;
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'terminal-frame-store-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('persists one JPEG per conversation and surface session under CODE_AGENT_DATA_DIR', async () => {
    const selector = { conversationId: 'conversation-a', surfaceSessionId: 'surface-a' };
    await persistTerminalFrame(selector, JPEG_A);

    await expect(readTerminalFrame(selector)).resolves.toEqual(JPEG_A);
    expect(getTerminalFramePath(selector)).toBe(path.join(
      dataDir,
      'surface-frames',
      Buffer.from('conversation-a').toString('base64url'),
      `${Buffer.from('surface-a').toString('base64url')}.jpg`,
    ));
  });

  it('uses conversationId and surfaceSessionId together when reading back', async () => {
    const a = { conversationId: 'conversation-a', surfaceSessionId: 'same-surface' };
    const b = { conversationId: 'conversation-b', surfaceSessionId: 'same-surface' };
    await persistTerminalFrame(a, JPEG_A);
    await persistTerminalFrame(b, JPEG_B);

    await expect(readTerminalFrame(a)).resolves.toEqual(JPEG_A);
    await expect(readTerminalFrame(b)).resolves.toEqual(JPEG_B);
  });

  it('deletes every frame for one conversation and preserves other conversations', async () => {
    const a1 = { conversationId: 'conversation-a', surfaceSessionId: 'surface-1' };
    const a2 = { conversationId: 'conversation-a', surfaceSessionId: 'surface-2' };
    const b1 = { conversationId: 'conversation-b', surfaceSessionId: 'surface-1' };
    await persistTerminalFrame(a1, JPEG_A);
    await persistTerminalFrame(a2, JPEG_B);
    await persistTerminalFrame(b1, JPEG_B);

    await deleteTerminalFramesForConversation('conversation-a');

    await expect(fs.stat(getTerminalFrameDirectory('conversation-a'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readTerminalFrame(a1)).resolves.toBeNull();
    await expect(readTerminalFrame(a2)).resolves.toBeNull();
    await expect(readTerminalFrame(b1)).resolves.toEqual(JPEG_B);
    await expect(deleteTerminalFramesForConversation('conversation-a')).resolves.toBeUndefined();
  });

  it('rejects non-JPEG bytes instead of writing an unreadable frame', async () => {
    const selector = { conversationId: 'conversation-a', surfaceSessionId: 'surface-a' };
    await expect(persistTerminalFrame(selector, Buffer.from('not-jpeg'))).rejects.toThrow(
      'not a JPEG',
    );
    await expect(readTerminalFrame(selector)).resolves.toBeNull();
  });

  it('returns null when a persisted file is later corrupted', async () => {
    const selector = { conversationId: 'conversation-a', surfaceSessionId: 'surface-a' };
    await persistTerminalFrame(selector, JPEG_A);
    await fs.writeFile(getTerminalFramePath(selector), Buffer.from('not-jpeg'));

    await expect(readTerminalFrame(selector)).resolves.toBeNull();
  });

  it('rejects empty or oversized ids and encodes traversal characters as path segments', async () => {
    await expect(persistTerminalFrame(
      { conversationId: ' ', surfaceSessionId: 'surface-a' },
      JPEG_A,
    )).rejects.toThrow('conversationId');
    await expect(persistTerminalFrame(
      { conversationId: 'conversation-a', surfaceSessionId: 'x'.repeat(257) },
      JPEG_A,
    )).rejects.toThrow('surfaceSessionId');

    const selector = { conversationId: '../../etc', surfaceSessionId: '../passwd' };
    await persistTerminalFrame(selector, JPEG_A);
    expect(getTerminalFramePath(selector).startsWith(path.join(dataDir, 'surface-frames') + path.sep))
      .toBe(true);
    await expect(readTerminalFrame(selector)).resolves.toEqual(JPEG_A);
  });

  it('deletes the complete frame root when all conversations are cleared', async () => {
    const a = { conversationId: 'conversation-a', surfaceSessionId: 'surface-1' };
    const b = { conversationId: 'conversation-b', surfaceSessionId: 'surface-1' };
    await persistTerminalFrame(a, JPEG_A);
    await persistTerminalFrame(b, JPEG_B);

    await deleteAllTerminalFrames();

    await expect(readTerminalFrame(a)).resolves.toBeNull();
    await expect(readTerminalFrame(b)).resolves.toBeNull();
  });
});
