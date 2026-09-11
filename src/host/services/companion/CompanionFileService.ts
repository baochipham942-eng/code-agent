import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync,
  renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';
import { companionFileMime, companionFileRetryable, COMPANION_LIMITS as L } from '../../../shared/constants/companion';
import type { CompanionCommand } from '../../../shared/contract/companion';
import type { CompanionArtifact, CompanionArtifacts } from '../../../shared/contract/companionLibrary';
import { isPathWithinRoot } from '../../runtime/workspaceScope';
import type { CompanionDispatchResult } from './CompanionGateway';
import type { CompanionGateway } from './CompanionGateway';

type SqlRow = Record<string, unknown>;
type TransferState = 'staging' | 'committed' | 'aborted';

export interface CompanionFileIo {
  mkdir(dir: string): void;
  write(file: string, data: Buffer, offset: number): void;
  readFile(file: string): Buffer;
  read(file: string, offset: number, length: number): Buffer;
  rename(from: string, to: string): void;
  rm(file: string): void;
  stat(file: string): { size: number };
  exists(file: string): boolean;
}

const defaultIo: CompanionFileIo = {
  mkdir: dir => mkdirSync(dir, { recursive: true }),
  write: (file, data, offset) => {
    const fd = openSync(file, existsSync(file) ? 'r+' : 'w');
    try { writeSync(fd, data, 0, data.length, offset); } finally { closeSync(fd); }
  },
  readFile: file => readFileSync(file),
  read: (file, offset, length) => {
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(length);
      const n = readSync(fd, buffer, 0, length, offset);
      return n === length ? buffer : buffer.subarray(0, n);
    } finally { closeSync(fd); }
  },
  rename: (from, to) => renameSync(from, to),
  rm: file => { try { rmSync(file, { force: true }); } catch { /* leftover cleanup must not throw */ } },
  stat: file => ({ size: statSync(file).size }),
  exists: file => existsSync(file),
};

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function fail(code: string): never {
  throw new Error(code);
}

function storageOr(error: unknown): never {
  const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
  if (code === 'ENOSPC' || code === 'EDQUOT') fail('STORAGE_FULL');
  throw error;
}

function safeName(name: string): string {
  const base = path.basename(name.replaceAll('\\', '/')).trim();
  const cleaned = base.replace(/[^\w.\u4e00-\u9fff()-]+/g, '_').slice(0, L.fileNameLength);
  if (!cleaned || cleaned === '.' || cleaned === '..') fail('COMPANION_FILE_NAME_DENIED');
  return cleaned;
}

function decodeChunk(data: string): Buffer {
  const buffer = Buffer.from(data, 'base64');
  if (buffer.length < 1 || buffer.length > L.fileChunkBytes) fail('ATTACHMENT_INCOMPLETE');
  return buffer;
}

/**
 * Session-scoped phone materials and result files. The phone never names a host path;
 * Host picks the staging/upload directories under the authorized workspace.
 */
export class CompanionFileService {
  private readonly pendingWrites = new Map<string, { sessionId: string; filePath: string }>();

  constructor(
    private readonly db: BetterSqlite3.Database,
    private readonly gateway: CompanionGateway,
    private readonly workspaceOf: (sessionId: string) => string | null,
    private readonly io: CompanionFileIo = defaultIo,
    private readonly now: () => number = Date.now,
  ) {
    this.recover();
  }

  dispatch(command: CompanionCommand): CompanionDispatchResult {
    try { return { state: 'accepted', result: this.handle(command) }; }
    catch (error) {
      const code = error instanceof Error ? error.message : 'COMPANION_OPERATION_FAILED';
      const known = code.startsWith('COMPANION_') || code === 'STORAGE_FULL' || code === 'UPLOAD_TOO_LARGE'
        || code === 'ATTACHMENT_INCOMPLETE' || code === 'ARTIFACT_MISSING';
      return { state: 'rejected', result: { code: known ? code : 'COMPANION_OPERATION_FAILED', retryable: companionFileRetryable(known ? code : '') } };
    }
  }

  handle(command: CompanionCommand): Record<string, unknown> {
    this.expireStale();
    if (command.action === 'files.prepare') return this.prepare(command);
    if (command.action === 'files.chunk') return this.chunk(command);
    if (command.action === 'files.commit') return this.commit(command);
    if (command.action === 'files.abort') return this.abort(command);
    if (command.action === 'files.read') return this.read(command);
    fail('COMPANION_UNSUPPORTED_ACTION');
  }

  list(sessionId: string): CompanionArtifacts {
    const rows = this.db.prepare(`SELECT artifact_id, version, name, mime_type, size, sha256, origin
      FROM companion_artifacts WHERE session_id = ? ORDER BY created_at ASC`).all(sessionId) as SqlRow[];
    return {
      sessionId,
      artifacts: rows.map(row => ({
        artifactId: String(row.artifact_id), version: Number(row.version), name: String(row.name),
        mimeType: String(row.mime_type), size: Number(row.size), sha256: String(row.sha256),
        origin: row.origin === 'result' ? 'result' : 'upload',
      })),
    };
  }

  noteWrite(sessionId: string, toolCallId: string, filePath: string): void {
    if (!sessionId || !toolCallId || !filePath) return;
    this.pendingWrites.set(`${sessionId}:${toolCallId}`, { sessionId, filePath });
  }

  /** 工具调用失败/取消时丢弃记账，否则 pendingWrites 在进程内只增不减。 */
  discardWrite(sessionId: string, toolCallId: string): void {
    this.pendingWrites.delete(`${sessionId}:${toolCallId}`);
  }

  completeWrite(sessionId: string, toolCallId: string): CompanionArtifact | null {
    const pending = this.pendingWrites.get(`${sessionId}:${toolCallId}`);
    this.pendingWrites.delete(`${sessionId}:${toolCallId}`);
    if (!pending) return null;
    const workspace = this.requireWorkspace(sessionId);
    // filePath 的生产者（imageGenerate/imageAnnotate 等）允许相对 workingDir 的写法，
    // 工具 schema 示例就是 "./product.png"；按宿主进程 cwd 解析恒找不到，先按 workspace 归一。
    const abs = path.isAbsolute(pending.filePath) ? pending.filePath : path.join(workspace, pending.filePath);
    if (!this.io.exists(abs) || !isPathWithinRoot(abs, workspace)) return null;
    let size: number;
    try { size = this.io.stat(abs).size; } catch { return null; }
    if (size < 1 || size > L.fileMaxBytes) return null;
    const name = safeName(abs);
    const mime = companionFileMime(name, '') ?? 'application/octet-stream';
    const bytes = this.io.readFile(abs);
    return this.storeArtifact(sessionId, name, mime, bytes, 'result');
  }

  recover(): void {
    const rows = this.db.prepare(`SELECT transfer_id, staging_path FROM companion_file_transfers WHERE state = 'staging'`).all() as SqlRow[];
    for (const row of rows) this.abortInternal(String(row.transfer_id));
  }

  /** Live host: drop abandoned staging without waiting for a process restart. */
  private expireStale(): void {
    const cutoff = this.now() - L.reconcilingRecoveryMs;
    // 已 committed 的传输行没有后续查询路径（重读走 companion_artifacts），一并到期清除，
    // 否则该表随累计上传永久增长。
    this.db.prepare(`DELETE FROM companion_file_transfers WHERE state = 'committed' AND created_at <= ?`).run(cutoff);
    const rows = this.db.prepare(`SELECT transfer_id FROM companion_file_transfers WHERE state = 'staging' AND created_at <= ?`).all(cutoff) as SqlRow[];
    for (const row of rows) this.abortInternal(String(row.transfer_id));
  }

  private prepare(command: Extract<CompanionCommand, { action: 'files.prepare' }>): Record<string, unknown> {
    const mime = companionFileMime(command.payload.name, command.payload.mimeType);
    if (!mime) fail('COMPANION_FILE_TYPE_DENIED');
    if (command.payload.size > L.fileMaxBytes) fail('UPLOAD_TOO_LARGE');
    const workspace = this.requireWorkspace(command.sessionId);
    const name = safeName(command.payload.name);
    this.abortDeviceSession(command.deviceId, command.sessionId);
    const transferId = randomUUID();
    const staging = path.join(workspace, L.fileRootDir, L.fileStagingDir, transferId);
    this.ensureInside(staging, workspace);
    try {
      this.io.mkdir(path.dirname(staging));
      this.io.write(staging, Buffer.alloc(0), 0);
    } catch (error) { storageOr(error); }
    this.db.prepare(`INSERT INTO companion_file_transfers
      (transfer_id, device_id, session_id, name, mime_type, size, sha256, received, state, staging_path, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'staging', ?, ?)`).run(
      transferId, command.deviceId, command.sessionId, name, mime, command.payload.size, command.payload.sha256,
      staging, this.now());
    return { transferId, chunkSize: L.fileChunkBytes };
  }

  private chunk(command: Extract<CompanionCommand, { action: 'files.chunk' }>): Record<string, unknown> {
    const transfer = this.requireTransfer(command.payload.transferId, command.deviceId, command.sessionId, 'staging');
    const bytes = decodeChunk(command.payload.data);
    if (digest(bytes) !== command.payload.sha256) fail('COMPANION_INVALID_HASH');
    if (command.payload.offset !== Number(transfer.received)) fail('ATTACHMENT_INCOMPLETE');
    const next = Number(transfer.received) + bytes.length;
    if (next > Number(transfer.size)) fail('UPLOAD_TOO_LARGE');
    try { this.io.write(String(transfer.staging_path), bytes, command.payload.offset); }
    catch (error) {
      this.abortInternal(String(transfer.transfer_id));
      storageOr(error);
    }
    // 分片同时刷新 created_at（语义=最后活跃时间）：大文件数百次串行分片可能跨过
    // reconcilingRecoveryMs，不刷新的话 expireStale 会把这条正在推进的传输当自己人删掉。
    this.db.prepare(`UPDATE companion_file_transfers SET received = ?, created_at = ? WHERE transfer_id = ?`).run(next, this.now(), transfer.transfer_id);
    return { transferId: transfer.transfer_id, received: next };
  }

  private commit(command: Extract<CompanionCommand, { action: 'files.commit' }>): Record<string, unknown> {
    const transfer = this.requireTransfer(command.payload.transferId, command.deviceId, command.sessionId, 'staging');
    if (Number(transfer.received) !== Number(transfer.size)) {
      this.abortInternal(String(transfer.transfer_id));
      fail('ATTACHMENT_INCOMPLETE');
    }
    let bytes: Buffer;
    try { bytes = this.io.readFile(String(transfer.staging_path)); } catch (error) {
      this.abortInternal(String(transfer.transfer_id));
      storageOr(error);
    }
    const hash = digest(bytes);
    if (hash !== String(transfer.sha256) || hash !== command.payload.sha256) {
      this.abortInternal(String(transfer.transfer_id));
      fail('COMPANION_INVALID_HASH');
    }
    const artifact = this.storeArtifact(command.sessionId, String(transfer.name), String(transfer.mime_type), bytes, 'upload', String(transfer.staging_path));
    this.db.prepare(`UPDATE companion_file_transfers SET state = 'committed' WHERE transfer_id = ?`).run(transfer.transfer_id);
    this.gateway.publish(command.sessionId, 'artifact', { ...artifact });
    return { ...artifact, transferId: transfer.transfer_id };
  }

  private abort(command: Extract<CompanionCommand, { action: 'files.abort' }>): Record<string, unknown> {
    const transfer = this.lookup(command.payload.transferId);
    if (!transfer || String(transfer.device_id) !== command.deviceId || String(transfer.session_id) !== command.sessionId) {
      return { transferId: command.payload.transferId, aborted: true };
    }
    this.abortInternal(String(transfer.transfer_id));
    return { transferId: command.payload.transferId, aborted: true };
  }

  private read(command: Extract<CompanionCommand, { action: 'files.read' }>): Record<string, unknown> {
    const row = this.db.prepare(`SELECT * FROM companion_artifacts WHERE artifact_id = ?`).get(command.payload.artifactId) as SqlRow | undefined;
    if (!row || String(row.session_id) !== command.sessionId) fail('ARTIFACT_MISSING');
    if (Number(row.version) !== command.payload.version) fail('ARTIFACT_MISSING');
    const workspace = this.requireWorkspace(command.sessionId);
    const file = String(row.path);
    if (!this.io.exists(file) || !isPathWithinRoot(file, workspace)) fail('ARTIFACT_MISSING');
    const size = Number(row.size);
    if (command.payload.offset >= size) {
      return { artifactId: row.artifact_id, version: row.version, name: row.name, mimeType: row.mime_type, size, sha256: row.sha256, offset: command.payload.offset, data: '', length: 0 };
    }
    const length = Math.min(command.payload.length, size - command.payload.offset);
    let slice: Buffer;
    try { slice = this.io.read(file, command.payload.offset, length); } catch (error) { storageOr(error); }
    return {
      artifactId: row.artifact_id, version: row.version, name: row.name, mimeType: row.mime_type,
      size, sha256: row.sha256, offset: command.payload.offset, length: slice.length,
      data: slice.toString('base64'),
    };
  }

  private storeArtifact(sessionId: string, name: string, mimeType: string, bytes: Buffer, origin: 'upload' | 'result', staging?: string): CompanionArtifact {
    const workspace = this.requireWorkspace(sessionId);
    const artifactId = randomUUID();
    const destDir = path.join(workspace, L.fileRootDir, L.fileUploadsDir, sessionId, artifactId);
    const dest = path.join(destDir, name);
    this.ensureInside(dest, workspace);
    try {
      this.io.mkdir(destDir);
      if (staging) {
        this.ensureInside(staging, workspace);
        this.io.rename(staging, dest);
      } else {
        this.io.write(dest, bytes, 0);
      }
    } catch (error) {
      if (staging) this.io.rm(staging);
      this.io.rm(dest);
      storageOr(error);
    }
    const sha256 = digest(this.io.readFile(dest));
    const artifact: CompanionArtifact = { artifactId, version: 1, name, mimeType, size: bytes.length, sha256, origin };
    this.db.prepare(`INSERT INTO companion_artifacts
      (artifact_id, session_id, version, name, mime_type, size, sha256, path, origin, created_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`).run(artifactId, sessionId, name, mimeType, bytes.length, sha256, dest, origin, this.now());
    return artifact;
  }

  private requireWorkspace(sessionId: string): string {
    const workspace = this.workspaceOf(sessionId);
    if (!workspace) fail('COMPANION_PROJECT_UNAVAILABLE');
    return path.resolve(workspace);
  }

  private ensureInside(candidate: string, workspace: string): void {
    if (!isPathWithinRoot(candidate, workspace)) fail('COMPANION_PATH_DENIED');
  }

  private lookup(transferId: string): SqlRow | undefined {
    return this.db.prepare(`SELECT * FROM companion_file_transfers WHERE transfer_id = ?`).get(transferId) as SqlRow | undefined;
  }

  private requireTransfer(transferId: string, deviceId: string, sessionId: string, state: TransferState): SqlRow {
    const row = this.lookup(transferId);
    if (!row || String(row.device_id) !== deviceId || String(row.session_id) !== sessionId) fail('ATTACHMENT_INCOMPLETE');
    if (String(row.state) !== state) fail('ATTACHMENT_INCOMPLETE');
    return row;
  }

  private abortDeviceSession(deviceId: string, sessionId: string): void {
    const rows = this.db.prepare(`SELECT transfer_id FROM companion_file_transfers
      WHERE device_id = ? AND session_id = ? AND state = 'staging'`).all(deviceId, sessionId) as SqlRow[];
    for (const row of rows) this.abortInternal(String(row.transfer_id));
  }

  private abortInternal(transferId: string): void {
    const row = this.lookup(transferId);
    if (!row || String(row.state) !== 'staging') return;
    this.io.rm(String(row.staging_path));
    this.db.prepare(`UPDATE companion_file_transfers SET state = 'aborted' WHERE transfer_id = ?`).run(transferId);
  }
}
