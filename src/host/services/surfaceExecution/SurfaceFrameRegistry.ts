import crypto from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { open } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { imageSize } from 'image-size';
import type {
  SurfaceEvidenceCardV1,
  SurfaceFramePayloadV1,
  SurfaceFrameRequestV1,
} from '../../../shared/contract/surfaceExecution';
import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';
import { SurfaceSessionManager } from './SurfaceSessionManager';

const MAX_FRAME_BYTES = 25 * 1024 * 1024;
const MAX_FRAMES = 2_000;
const MAX_FRAMES_PER_SESSION = 100;
const DEFAULT_FRAME_TTL_MS = 24 * 60 * 60_000;
const OPAQUE_FRAME_REF = /^surface-frame:\/\/[a-zA-Z0-9._:-]+$/;

interface SurfaceFrameEntry {
  ref: string;
  evidenceKey: string;
  subject: SurfaceGrantSubjectV1;
  conversationId: string;
  path: string;
  size: number;
  mtimeMs: number;
  ino: number;
  mimeType: SurfaceFramePayloadV1['mimeType'];
  sha256: string;
  width?: number;
  height?: number;
  registeredAt: number;
  expiresAt: number;
}

interface SurfaceFrameRegistryOptions {
  now?: () => number;
  createId?: () => string;
  ttlMs?: number;
}

function imageMimeType(bytes: Buffer): SurfaceFramePayloadV1['mimeType'] | null {
  if (bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 12
    && bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  const signature = bytes.subarray(0, 6).toString('ascii');
  return signature === 'GIF87a' || signature === 'GIF89a' ? 'image/gif' : null;
}

function withoutAssetRef(evidence: SurfaceEvidenceCardV1): SurfaceEvidenceCardV1 {
  const { assetRef: _assetRef, ...safe } = evidence;
  return safe;
}

export class SurfaceFrameRegistry {
  private readonly entries = new Map<string, SurfaceFrameEntry>();
  private readonly refByEvidence = new Map<string, string>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly ttlMs: number;

  constructor(
    private readonly sessions: SurfaceSessionManager,
    options: SurfaceFrameRegistryOptions = {},
  ) {
    this.now = options.now || Date.now;
    this.createId = options.createId || (() => crypto.randomUUID());
    this.ttlMs = Math.max(1, options.ttlMs || DEFAULT_FRAME_TTL_MS);
  }

  projectEvidence(
    subject: SurfaceGrantSubjectV1,
    evidence: readonly SurfaceEvidenceCardV1[] | undefined,
  ): SurfaceEvidenceCardV1[] | undefined {
    if (!evidence) return undefined;
    const session = this.sessions.requireOwned(subject.sessionId, subject);
    return evidence.map((card) => {
      const assetRef = card.assetRef;
      if (!assetRef
        || card.kind !== 'screenshot'
        || card.redactionStatus !== 'clean'
        || card.inspection.captureState !== 'captured') return structuredClone(card);
      if (OPAQUE_FRAME_REF.test(assetRef)) {
        const entry = this.entries.get(assetRef);
        const owned = entry?.subject.sessionId === subject.sessionId
          && entry.subject.runId === subject.runId
          && entry.subject.agentId === subject.agentId;
        return owned ? structuredClone(card) : withoutAssetRef(card);
      }
      if (!isAbsolute(assetRef)) return structuredClone(card);
      const registered = this.registerLocalFrame({
        subject,
        conversationId: session.conversationId,
        evidenceId: card.evidenceId,
        path: assetRef,
      });
      if (!registered) return withoutAssetRef(card);
      const projected = { ...structuredClone(card), assetRef: registered.ref };
      if (projected.captureContext
        && !projected.captureContext.viewport
        && registered.width
        && registered.height) {
        projected.captureContext.viewport = {
          width: registered.width,
          height: registered.height,
        };
      }
      return projected;
    });
  }

  async resolve(request: SurfaceFrameRequestV1): Promise<SurfaceFramePayloadV1> {
    this.pruneExpired();
    const entry = this.entries.get(request.assetRef);
    const session = this.sessions.get(request.surfaceSessionId);
    if (!entry
      || session?.conversationId !== request.conversationId
      || entry.conversationId !== request.conversationId
      || entry.subject.sessionId !== request.surfaceSessionId
      || session.runId !== entry.subject.runId
      || session.agentId !== entry.subject.agentId) {
      throw this.error(request, 'SURFACE_TARGET_NOT_OWNED', 'Surface frame is unavailable for this session.');
    }
    this.sessions.requireOwned(entry.subject.sessionId, entry.subject);
    let handle;
    try {
      handle = await open(entry.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    } catch {
      throw this.error(request, 'SURFACE_STATE_STALE', 'Surface frame is no longer available.');
    }
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile()
        || before.size !== entry.size
        || before.mtimeMs !== entry.mtimeMs
        || Number(before.ino) !== entry.ino
        || before.size <= 0
        || before.size > MAX_FRAME_BYTES) {
        throw this.error(request, 'SURFACE_STATE_STALE', 'Surface frame changed after capture.');
      }
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (after.size !== before.size
        || after.mtimeMs !== before.mtimeMs
        || Number(after.ino) !== Number(before.ino)) {
        throw this.error(request, 'SURFACE_STATE_STALE', 'Surface frame changed while it was read.');
      }
    } finally {
      await handle.close();
    }
    const mimeType = imageMimeType(bytes);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (!mimeType || mimeType !== entry.mimeType || sha256 !== entry.sha256) {
      throw this.error(request, 'SURFACE_POLICY_BLOCKED', 'Surface frame format is not allowed.');
    }
    return {
      version: 1,
      assetRef: entry.ref,
      mimeType,
      dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`,
      bytes: bytes.length,
      sha256,
      ...(entry.width ? { width: entry.width } : {}),
      ...(entry.height ? { height: entry.height } : {}),
    };
  }

  releaseSession(surfaceSessionId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.subject.sessionId === surfaceSessionId) this.deleteEntry(entry);
    }
  }

  private registerLocalFrame(input: {
    subject: SurfaceGrantSubjectV1;
    conversationId: string;
    evidenceId: string;
    path: string;
  }): SurfaceFrameEntry | null {
    let file;
    let realPath: string;
    let bytes: Buffer;
    try {
      const pathFile = lstatSync(input.path);
      if (pathFile.isSymbolicLink() || !pathFile.isFile()
        || pathFile.size <= 0 || pathFile.size > MAX_FRAME_BYTES) return null;
      realPath = realpathSync(input.path);
      const descriptor = openSync(input.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      try {
        file = fstatSync(descriptor);
        if (!file.isFile() || file.size <= 0 || file.size > MAX_FRAME_BYTES) return null;
        bytes = readFileSync(descriptor);
        const after = fstatSync(descriptor);
        if (after.size !== file.size
          || after.mtimeMs !== file.mtimeMs
          || Number(after.ino) !== Number(file.ino)) return null;
      } finally {
        closeSync(descriptor);
      }
    } catch {
      return null;
    }
    const mimeType = imageMimeType(bytes);
    if (!mimeType) return null;
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const evidenceKey = [input.subject.sessionId, input.subject.runId, input.subject.agentId, input.evidenceId]
      .join('\u001f');
    const existingRef = this.refByEvidence.get(evidenceKey);
    const existing = existingRef ? this.entries.get(existingRef) : undefined;
    if (existing?.path === realPath
      && existing.size === file.size
      && existing.mtimeMs === file.mtimeMs
      && existing.ino === Number(file.ino)
      && existing.sha256 === sha256
      && existing.expiresAt > this.now()) return existing;
    if (existing) this.deleteEntry(existing);
    this.pruneExpired();
    this.enforceCapacity(input.subject.sessionId);
    const ref = `surface-frame://${this.createId()}`;
    if (!OPAQUE_FRAME_REF.test(ref)) return null;
    const registeredAt = this.now();
    let dimensions: { width?: number; height?: number } = {};
    try {
      const parsed = imageSize(bytes);
      if (parsed.width && parsed.height) dimensions = { width: parsed.width, height: parsed.height };
    } catch {
      // Image signature validation remains authoritative when dimensions are unavailable.
    }
    const entry: SurfaceFrameEntry = {
      ref,
      evidenceKey,
      subject: { ...input.subject },
      conversationId: input.conversationId,
      path: realPath,
      size: file.size,
      mtimeMs: file.mtimeMs,
      ino: Number(file.ino),
      mimeType,
      sha256,
      ...dimensions,
      registeredAt,
      expiresAt: registeredAt + this.ttlMs,
    };
    this.entries.set(ref, entry);
    this.refByEvidence.set(evidenceKey, ref);
    return entry;
  }

  private enforceCapacity(surfaceSessionId: string): void {
    const ordered = Array.from(this.entries.values())
      .sort((left, right) => left.registeredAt - right.registeredAt);
    const sessionEntries = ordered.filter((entry) => entry.subject.sessionId === surfaceSessionId);
    while (sessionEntries.length >= MAX_FRAMES_PER_SESSION) {
      const entry = sessionEntries.shift();
      if (entry) this.deleteEntry(entry);
    }
    while (this.entries.size >= MAX_FRAMES) {
      const entry = Array.from(this.entries.values())
        .sort((left, right) => left.registeredAt - right.registeredAt)[0];
      if (!entry) break;
      this.deleteEntry(entry);
    }
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const entry of this.entries.values()) {
      if (entry.expiresAt <= now) this.deleteEntry(entry);
    }
  }

  private deleteEntry(entry: SurfaceFrameEntry): void {
    this.entries.delete(entry.ref);
    if (this.refByEvidence.get(entry.evidenceKey) === entry.ref) {
      this.refByEvidence.delete(entry.evidenceKey);
    }
  }

  private error(
    request: SurfaceFrameRequestV1,
    code: 'SURFACE_TARGET_NOT_OWNED' | 'SURFACE_STATE_STALE' | 'SURFACE_POLICY_BLOCKED',
    message: string,
  ): SurfaceExecutionRuntimeError {
    const session = this.sessions.get(request.surfaceSessionId);
    return new SurfaceExecutionRuntimeError({
      code,
      message,
      phase: 'observe',
      retryable: code === 'SURFACE_STATE_STALE',
      recommendedAction: 'Capture a fresh owner-scoped Surface frame.',
      surface: session?.surface || 'browser',
      provider: session?.provider || 'surface-runtime',
      sessionId: request.surfaceSessionId,
    });
  }
}
