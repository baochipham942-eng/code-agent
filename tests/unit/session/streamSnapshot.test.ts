import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStreamSnapshot,
  getIncompleteToolCallIds,
  loadStreamSnapshot,
  saveStreamSnapshot,
} from '../../../src/main/session/streamSnapshot';

vi.mock('../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('stream snapshot stability markers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-stream-'));
  });

  afterEach(() => {
    clearStreamSnapshot(tempDir);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('marks non-final partial tool arguments as unstable for execution', () => {
    saveStreamSnapshot(
      {
        content: '',
        reasoning: '',
        toolCalls: [
          { id: 'tool-1', name: 'write_file', arguments: '{"file_path":"/tmp/a"' },
        ],
        estimatedTokens: 1,
        timestamp: 100,
        isFinal: false,
      },
      'session-1',
      'turn-1',
      tempDir,
    );

    const snapshot = loadStreamSnapshot(tempDir);

    expect(snapshot).toMatchObject({
      sessionId: 'session-1',
      turnId: 'turn-1',
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds: ['tool-1'],
    });
  });

  it('does not report incomplete ids for final snapshots', () => {
    expect(getIncompleteToolCallIds({
      isFinal: true,
      toolCalls: [
        { id: 'tool-1', name: 'write_file', arguments: '{"file_path":"/tmp/a"' },
      ],
    })).toEqual([]);
  });
});
