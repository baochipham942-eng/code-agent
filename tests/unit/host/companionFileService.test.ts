import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import { CompanionGateway } from '../../../src/host/services/companion/CompanionGateway';
import { CompanionFileService, type CompanionFileIo } from '../../../src/host/services/companion/CompanionFileService';
import { COMPANION_LIMITS as L } from '../../../src/shared/constants/companion';
import type { CompanionCommand } from '../../../src/shared/contract/companion';

function sha(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('CompanionFileService', () => {
  let db: Database.Database;
  let gateway: CompanionGateway;
  let files: CompanionFileService;
  let workspace: string;
  const deviceId = 'phone-1';

  const command = (action: CompanionCommand['action'], payload: Record<string, unknown>, commandId = `${action}-${Math.random()}`): CompanionCommand =>
    ({ version: 1, deviceId, scopeEpoch: 1, sessionId: 'session-1', commandId, action, payload }) as CompanionCommand;

  beforeEach(() => {
    workspace = mkdtempSync(path.join(tmpdir(), 'neo-companion-files-'));
    db = new Database(':memory:');
    gateway = new CompanionGateway(db, { now: () => 1000, dispatch: cmd => files.dispatch(cmd) });
    gateway.registerDevice({ deviceId, credentialHash: 'hash', scopeEpoch: 1, scope: ['session-1'], revokedAt: null });
    files = new CompanionFileService(db, gateway, id => id === 'session-1' ? workspace : null, undefined, () => 1000);
  });
  afterEach(() => { db.close(); rmSync(workspace, { recursive: true, force: true }); });

  async function upload(bytes: Buffer, name = 'photo.png', mimeType = 'image/png') {
    const digest = sha(bytes);
    const prepared = gateway.submit(command('files.prepare', { name, mimeType, size: bytes.length, sha256: digest }));
    expect(prepared.kind).toBe('accepted');
    const transferId = (prepared as { command: { result: { transferId: string } } }).command.result.transferId;
    for (let offset = 0; offset < bytes.length; offset += L.fileChunkBytes) {
      const slice = bytes.subarray(offset, offset + L.fileChunkBytes);
      const chunk = gateway.submit(command('files.chunk', { transferId, offset, data: slice.toString('base64'), sha256: sha(slice) }));
      expect(chunk).toMatchObject({ kind: 'accepted', command: { state: 'accepted' } });
    }
    return gateway.submit(command('files.commit', { transferId, sha256: digest }));
  }

  it('commits an upload into the authorized workspace without accepting a phone path', async () => {
    const bytes = Buffer.from('hello-image');
    const result = await upload(bytes);
    expect(result).toMatchObject({ kind: 'accepted', command: { state: 'accepted', result: { name: 'photo.png', mimeType: 'image/png', origin: 'upload' } } });
    const artifactId = (result as { command: { result: { artifactId: string } } }).command.result.artifactId;
    const listed = files.list('session-1');
    expect(listed.artifacts).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(workspace);
    const read = gateway.submit(command('files.read', { artifactId, version: 1, offset: 0, length: bytes.length }));
    expect(read).toMatchObject({ kind: 'accepted' });
    const data = (read as { command: { result: { data: string; path?: unknown } } }).command.result;
    expect(data.path).toBeUndefined();
    expect(Buffer.from(data.data, 'base64').equals(bytes)).toBe(true);
    expect(readFileSync(path.join(workspace, L.fileRootDir, L.fileUploadsDir, 'session-1', artifactId, 'photo.png')).equals(bytes)).toBe(true);
    expect(readdirSync(path.join(workspace, L.fileRootDir, L.fileStagingDir), { withFileTypes: true }).filter(entry => entry.isFile())).toHaveLength(0);
  });

  it('rejects oversized and disallowed types before writing', () => {
    const tooBig = gateway.submit(command('files.prepare', { name: 'huge.png', mimeType: 'image/png', size: L.fileMaxBytes + 1, sha256: 'a'.repeat(64) }));
    expect(tooBig.kind).toBe('rejected');
    const exe = gateway.submit(command('files.prepare', { name: 'payload.exe', mimeType: 'application/x-msdownload', size: 12, sha256: 'b'.repeat(64) }));
    expect(exe).toMatchObject({ kind: 'accepted', command: { state: 'rejected', result: { code: 'COMPANION_FILE_TYPE_DENIED' } } });
    expect(readdirSync(workspace)).toEqual([]);
  });

  it('aborts an interrupted transfer so retry does not leave a half file', async () => {
    const bytes = Buffer.from('abcdefghij');
    const digest = sha(bytes);
    const prepared = gateway.submit(command('files.prepare', { name: 'note.txt', mimeType: 'text/plain', size: bytes.length, sha256: digest }));
    const transferId = (prepared as { command: { result: { transferId: string } } }).command.result.transferId;
    const slice = bytes.subarray(0, 3);
    gateway.submit(command('files.chunk', { transferId, offset: 0, data: slice.toString('base64'), sha256: sha(slice) }));
    expect(files.dispatch(command('files.abort', { transferId }))).toMatchObject({ state: 'accepted', result: { aborted: true } });
    const staging = path.join(workspace, L.fileRootDir, L.fileStagingDir);
    expect(readdirSync(staging).filter(name => name === transferId)).toEqual([]);
    const retried = await upload(bytes, 'note.txt', 'text/plain');
    expect(retried).toMatchObject({ kind: 'accepted', command: { state: 'accepted' } });
    expect(files.list('session-1').artifacts).toHaveLength(1);
  });

  it('host restart recovers staging leftovers', () => {
    const bytes = Buffer.from('partial');
    const digest = sha(bytes);
    const prepared = gateway.submit(command('files.prepare', { name: 'a.txt', mimeType: 'text/plain', size: bytes.length, sha256: digest }));
    const transferId = (prepared as { command: { result: { transferId: string } } }).command.result.transferId;
    const slice = bytes.subarray(0, 2);
    gateway.submit(command('files.chunk', { transferId, offset: 0, data: slice.toString('base64'), sha256: sha(slice) }));
    const restarted = new CompanionFileService(db, gateway, () => workspace);
    expect(db.prepare(`SELECT state FROM companion_file_transfers WHERE transfer_id = ?`).get(transferId)).toEqual({ state: 'aborted' });
    const staging = path.join(workspace, L.fileRootDir, L.fileStagingDir);
    expect(readdirSync(staging)).not.toContain(transferId);
    void restarted;
  });

  it('maps disk-full writes to STORAGE_FULL and removes the staging file', () => {
    const io: CompanionFileIo = {
      mkdir: () => {},
      write: () => { const error = new Error('ENOSPC'); (error as NodeJS.ErrnoException).code = 'ENOSPC'; throw error; },
      readFile: () => Buffer.alloc(0),
      read: () => Buffer.alloc(0),
      rename: () => {},
      rm: () => {},
      stat: () => ({ size: 0 }),
      exists: () => false,
    };
    const tight = new CompanionFileService(db, gateway, () => workspace, io);
    expect(tight.dispatch(command('files.prepare', { name: 'a.png', mimeType: 'image/png', size: 4, sha256: 'c'.repeat(64) })))
      .toMatchObject({ state: 'rejected', result: { code: 'STORAGE_FULL', retryable: true } });
  });

  it('registers a result file from a workspace write and never echoes the path', () => {
    const dest = path.join(workspace, 'out', 'result.md');
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, 'done');
    files.noteWrite('session-1', 'tool-1', dest);
    const artifact = files.completeWrite('session-1', 'tool-1');
    expect(artifact).toMatchObject({ name: 'result.md', origin: 'result' });
    expect(JSON.stringify(artifact)).not.toContain(workspace);
    const escape = path.join(tmpdir(), `neo-escape-${process.pid}.txt`);
    writeFileSync(escape, 'stolen');
    files.noteWrite('session-1', 'evil', escape);
    expect(files.completeWrite('session-1', 'evil')).toBeNull();
    rmSync(escape, { force: true });
  });

  it('does not read an artifact from another session', async () => {
    const result = await upload(Buffer.from('secret'));
    const artifactId = (result as { command: { result: { artifactId: string } } }).command.result.artifactId;
    const other = { version: 1 as const, deviceId, scopeEpoch: 1, sessionId: 'other', commandId: 'read-other', action: 'files.read' as const,
      payload: { artifactId, version: 1, offset: 0, length: 6 } };
    expect(files.dispatch(other)).toMatchObject({ state: 'rejected', result: { code: 'ARTIFACT_MISSING' } });
  });
});
