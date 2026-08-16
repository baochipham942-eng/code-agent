import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  readRequestReplayBlob,
  storeRequestReplayBlob,
} from '../../../src/host/telemetry/requestReplayBlobStore';

describe('requestReplayBlobStore', () => {
  let dataDir: string;
  const previousDataDir = process.env.CODE_AGENT_DATA_DIR;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'request-replay-blob-'));
    process.env.CODE_AGENT_DATA_DIR = dataDir;
  });

  afterEach(() => {
    if (previousDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('stores decoded bytes by hash and reads verified canonical base64', () => {
    const base64 = Buffer.from('binary image\0bytes').toString('base64');

    const first = storeRequestReplayBlob(base64);
    const second = storeRequestReplayBlob(base64);

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(first && fs.readFileSync(first.filePath)).toEqual(Buffer.from(base64, 'base64'));
    expect(first && readRequestReplayBlob(first)).toBe(base64);
  });

  it('rejects tampered files and non-canonical base64', () => {
    const ref = storeRequestReplayBlob(Buffer.from('original').toString('base64'));
    expect(ref).not.toBeNull();
    if (!ref) throw new Error('expected blob ref');
    fs.writeFileSync(ref.filePath, 'tampered');

    expect(readRequestReplayBlob(ref)).toBeNull();
    expect(storeRequestReplayBlob('not base64')).toBeNull();
  });
});
