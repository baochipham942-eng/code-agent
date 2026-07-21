import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface BrowserUploadOwner {
  conversationId: string;
  runId: string;
  agentId: string;
  operationId: string;
}

export interface ApprovedBrowserUploadFile {
  normalizedPath: string;
  name: string;
  size: number;
  sha256: string;
  device: number;
  inode: number;
  modifiedAtMs: number;
}

export interface VerifiedBrowserUploadPayload {
  file: ApprovedBrowserUploadFile;
  buffer: Buffer;
}

interface RelayUploadApproval {
  token: string;
  approvalRef: string;
  owner: BrowserUploadOwner;
  file: ApprovedBrowserUploadFile;
  expiresAtMs: number;
  consumedAtMs?: number;
}

function sameOwner(left: BrowserUploadOwner, right: BrowserUploadOwner): boolean {
  return left.conversationId === right.conversationId
    && left.runId === right.runId
    && left.agentId === right.agentId
    && left.operationId === right.operationId;
}

function readUploadFileState<T>(requestedPath: string, read: () => T): T {
  try {
    return read();
  } catch {
    throw new Error(`SURFACE_APPROVAL_INVALID: upload file is unavailable (${path.basename(requestedPath)})`);
  }
}

export function inspectBrowserUploadFile(filePath: string): ApprovedBrowserUploadFile {
  return readBrowserUploadFileSnapshot(filePath).file;
}

function readBrowserUploadFileSnapshot(filePath: string): VerifiedBrowserUploadPayload {
  const requestedPath = path.resolve(filePath);
  const requestedStat = readUploadFileState(requestedPath, () => fs.lstatSync(requestedPath));
  if (requestedStat.isSymbolicLink()) {
    throw new Error('SURFACE_POLICY_BLOCKED: upload authorization does not follow symbolic links');
  }
  if (!requestedStat.isFile()) {
    throw new Error(`SURFACE_POLICY_BLOCKED: upload target is not a regular file (${path.basename(requestedPath)})`);
  }
  const normalizedPath = readUploadFileState(requestedPath, () => fs.realpathSync.native(requestedPath));
  const descriptor = readUploadFileState(requestedPath, () => fs.openSync(
    normalizedPath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  ));
  try {
    const stat = readUploadFileState(requestedPath, () => fs.fstatSync(descriptor));
    if (!stat.isFile()) {
      throw new Error(`SURFACE_POLICY_BLOCKED: upload target is not a regular file (${path.basename(requestedPath)})`);
    }
    const buffer = readUploadFileState(requestedPath, () => fs.readFileSync(descriptor));
    const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
    return {
      file: {
        normalizedPath,
        name: path.basename(normalizedPath),
        size: buffer.length,
        sha256,
        device: stat.dev,
        inode: stat.ino,
        modifiedAtMs: stat.mtimeMs,
      },
      buffer,
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

export function verifyBrowserUploadFile(
  approved: ApprovedBrowserUploadFile,
): ApprovedBrowserUploadFile {
  return readVerifiedBrowserUploadFile(approved).file;
}

export function readVerifiedBrowserUploadFile(
  approved: ApprovedBrowserUploadFile,
): VerifiedBrowserUploadPayload {
  const current = readBrowserUploadFileSnapshot(approved.normalizedPath);
  const unchanged = current.file.normalizedPath === approved.normalizedPath
    && current.file.name === approved.name
    && current.file.size === approved.size
    && current.file.sha256 === approved.sha256
    && current.file.device === approved.device
    && current.file.inode === approved.inode
    && current.file.modifiedAtMs === approved.modifiedAtMs;
  if (!unchanged) {
    throw new Error('SURFACE_APPROVAL_INVALID: approved upload file changed before delivery');
  }
  return current;
}

export class RelayBrowserUploadApprovalRegistry {
  private readonly approvals = new Map<string, RelayUploadApproval>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(input: {
    owner: BrowserUploadOwner;
    file: ApprovedBrowserUploadFile;
    ttlMs?: number;
  }): { token: string; approvalRef: string } {
    this.prune();
    const token = `relay_upload_${crypto.randomUUID()}`;
    const approvalRef = `upload_approval_${crypto.randomUUID()}`;
    this.approvals.set(token, {
      token,
      approvalRef,
      owner: { ...input.owner },
      file: { ...input.file },
      expiresAtMs: this.now() + Math.max(1, Math.min(input.ttlMs || 60_000, 60_000)),
    });
    return { token, approvalRef };
  }

  consume(input: {
    token: string;
    owner: BrowserUploadOwner;
  }): { approvalRef: string; file: ApprovedBrowserUploadFile } {
    this.prune();
    const approval = this.approvals.get(input.token);
    if (!approval
      || approval.consumedAtMs !== undefined
      || approval.expiresAtMs <= this.now()
      || !sameOwner(approval.owner, input.owner)) {
      throw new Error('SURFACE_APPROVAL_INVALID: Relay upload approval is missing, expired, consumed, or owned by another operation');
    }
    approval.consumedAtMs = this.now();
    const file = verifyBrowserUploadFile(approval.file);
    return { approvalRef: approval.approvalRef, file };
  }

  private prune(): void {
    const now = this.now();
    for (const [token, approval] of this.approvals) {
      if (approval.expiresAtMs <= now || approval.consumedAtMs !== undefined) {
        this.approvals.delete(token);
      }
    }
  }
}

export const relayBrowserUploadApprovalRegistry = new RelayBrowserUploadApprovalRegistry();
