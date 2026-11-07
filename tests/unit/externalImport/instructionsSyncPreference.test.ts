import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../../../src/host/services/infra/logger', () => ({ createLogger: () => logger }));

import {
  readInstructionsSyncStored,
  writeInstructionsSyncStored,
} from '../../../src/host/externalImport/instructionsSyncPreference';

let dataDir: string;
const file = () => path.join(dataDir, 'external-instructions-sync.json');

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instructions-sync-pref-'));
  vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);
  logger.warn.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe('instructionsSyncPreference', () => {
  it('missing defaults to off with an empty handled ledger and no warning', () => {
    expect(readInstructionsSyncStored()).toEqual({ mode: 'off', handled: [] });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('round-trips mode, lastRun, and deduplicated handled hashes', () => {
    writeInstructionsSyncStored({
      mode: 'paused',
      lastRun: { at: 1, pending: 2, keptNeo: 3 },
      handled: ['a', 'a', 'b'],
    });
    expect(readInstructionsSyncStored()).toEqual({
      mode: 'paused',
      lastRun: { at: 1, pending: 2, keptNeo: 3 },
      handled: ['a', 'b'],
    });
    expect(JSON.parse(fs.readFileSync(file(), 'utf8')).version).toBe(1);
  });

  it('corrupt JSON fails closed to off and logs the reason', () => {
    fs.writeFileSync(file(), '{broken');
    expect(readInstructionsSyncStored()).toEqual({ mode: 'off', handled: [] });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('corrupt'),
      expect.objectContaining({ error: expect.any(String) }),
    );
  });

  it('an invalid mode and an unreadable file both fail closed with warnings', () => {
    fs.writeFileSync(file(), JSON.stringify({ version: 1, mode: 'always' }));
    expect(readInstructionsSyncStored()).toEqual({ mode: 'off', handled: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no valid mode'), expect.anything());

    fs.rmSync(file());
    fs.mkdirSync(file());
    expect(readInstructionsSyncStored()).toEqual({ mode: 'off', handled: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to read'), expect.anything());
  });
});
