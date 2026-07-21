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
import { basename, extname, isAbsolute, resolve, sep } from 'node:path';
import type {
  SurfaceOutputPayloadV1,
  SurfaceOutputRefV1,
  SurfaceOutputRequestV1,
} from '../../../shared/contract/surfaceExecution';
import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import { redactSurfaceExecutionValue } from '../../../shared/utils/surfaceExecutionRedaction';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';
import { SurfaceSessionManager } from './SurfaceSessionManager';

const MAX_OUTPUT_BYTES = 25 * 1024 * 1024;
const MAX_TEXT_PREVIEW_BYTES = 256 * 1024;
const MAX_OUTPUTS = 2_000;
const MAX_OUTPUTS_PER_SESSION = 100;
const DEFAULT_OUTPUT_TTL_MS = 24 * 60 * 60_000;
const OPAQUE_OUTPUT_REF = /^surface-output:\/\/[a-zA-Z0-9._:-]+$/;

type OutputMimeType = SurfaceOutputPayloadV1['mimeType'];

interface SurfaceOutputEntry {
  ref: string;
  sourceKey: string;
  sourceRefs: string[];
  subject: SurfaceGrantSubjectV1;
  conversationId: string;
  path: string;
  size: number;
  mtimeMs: number;
  ino: number;
  mimeType: OutputMimeType;
  contentKind: SurfaceOutputPayloadV1['contentKind'];
  sha256: string;
  outputKind: SurfaceOutputRefV1['kind'];
  label: string;
  registeredAt: number;
  expiresAt: number;
}

interface SurfaceOutputRegistryOptions {
  now?: () => number;
  createId?: () => string;
  ttlMs?: number;
}

export interface RegisterSurfaceOutputInput {
  subject: SurfaceGrantSubjectV1;
  conversationId: string;
  path: string;
  sourceRefs?: readonly string[];
  kind?: SurfaceOutputRefV1['kind'];
  label?: string;
  expectedSha256?: string;
  allowedRoot?: string;
}

function imageMimeType(bytes: Buffer): OutputMimeType | null {
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

function textMimeType(path: string, bytes: Buffer): OutputMimeType | null {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  switch (extname(path).toLowerCase()) {
    case '.html':
    case '.htm': return 'text/html';
    case '.json': return 'application/json';
    case '.md':
    case '.markdown': return 'text/markdown';
    case '.csv': return 'text/csv';
    case '.xml': return 'application/xml';
    case '.txt':
    case '.log':
    case '.yaml':
    case '.yml': return 'text/plain';
    default: return null;
  }
}

function inspectContent(path: string, bytes: Buffer): {
  contentKind: SurfaceOutputPayloadV1['contentKind'];
  mimeType: OutputMimeType;
} | null {
  const image = imageMimeType(bytes);
  if (image) return { contentKind: 'image', mimeType: image };
  const text = textMimeType(path, bytes);
  return text ? { contentKind: 'text', mimeType: text } : null;
}

function safeSourceRefs(values: readonly string[] | undefined): string[] {
  return Array.from(new Set((values || [])
    .map((value) => value.trim())
    .filter((value) => safePublicRef(value))));
}

function safePublicRef(value: string): boolean {
  if (!value || value.length > 1_024 || isAbsolute(value)
    || /^[a-zA-Z]:[\\/]/.test(value) || /^file:/i.test(value)) return false;
  return /^[a-z][a-z0-9+.-]*:\/\/[^\s]+$/i.test(value)
    || /^[a-zA-Z0-9._:-]+$/.test(value);
}

function safeLabel(value: string): string {
  const name = value.replace(/\\/g, '/').split('/').at(-1) || value;
  const redacted = Array.from(String(redactSurfaceExecutionValue(name)))
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .trim()
    .slice(0, 120);
  return redacted || 'Output';
}

function isWithin(path: string, root: string): boolean {
  const candidate = resolve(path);
  const boundary = resolve(root);
  return candidate === boundary || candidate.startsWith(`${boundary}${sep}`);
}

function redactTextPreview(value: string, mimeType: OutputMimeType): string {
  if (mimeType === 'application/json') {
    try {
      return JSON.stringify(redactSurfaceExecutionValue(JSON.parse(value)), null, 2);
    } catch {
      // Invalid JSON remains inert text and goes through the shared string redactor.
    }
  }
  return String(redactSurfaceExecutionValue(value));
}

export class SurfaceOutputRegistry {
  private readonly entries = new Map<string, SurfaceOutputEntry>();
  private readonly refBySource = new Map<string, string>();
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly ttlMs: number;

  constructor(
    private readonly sessions: SurfaceSessionManager,
    options: SurfaceOutputRegistryOptions = {},
  ) {
    this.now = options.now || Date.now;
    this.createId = options.createId || (() => crypto.randomUUID());
    this.ttlMs = Math.max(1, options.ttlMs || DEFAULT_OUTPUT_TTL_MS);
  }

  registerLocalOutput(input: RegisterSurfaceOutputInput): SurfaceOutputRefV1 | null {
    const session = this.sessions.requireOwned(input.subject.sessionId, input.subject);
    if (session.conversationId !== input.conversationId || !isAbsolute(input.path)) return null;
    let file;
    let realPath: string;
    let bytes: Buffer;
    try {
      const pathFile = lstatSync(input.path);
      if (pathFile.isSymbolicLink() || !pathFile.isFile()
        || pathFile.size <= 0 || pathFile.size > MAX_OUTPUT_BYTES) return null;
      realPath = realpathSync(input.path);
      if (input.allowedRoot) {
        const realRoot = realpathSync(input.allowedRoot);
        if (!isWithin(realPath, realRoot)) return null;
      }
      const descriptor = openSync(input.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      try {
        file = fstatSync(descriptor);
        if (!file.isFile() || file.size <= 0 || file.size > MAX_OUTPUT_BYTES) return null;
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
    const content = inspectContent(realPath, bytes);
    if (!content) return null;
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (input.expectedSha256 && input.expectedSha256.toLowerCase() !== sha256) return null;
    const sourceRefs = safeSourceRefs(input.sourceRefs);
    const sourceKey = [input.subject.sessionId, input.subject.runId, input.subject.agentId,
      ...sourceRefs.sort(), sha256].join('\u001f');
    const existingRef = this.refBySource.get(sourceKey);
    const existing = existingRef ? this.entries.get(existingRef) : undefined;
    if (existing?.path === realPath
      && existing.size === file.size
      && existing.mtimeMs === file.mtimeMs
      && existing.ino === Number(file.ino)
      && existing.expiresAt > this.now()) return this.toRef(existing);
    if (existing) this.deleteEntry(existing);
    this.pruneExpired();
    this.enforceCapacity(input.subject.sessionId);
    const ref = `surface-output://${this.createId()}`;
    if (!OPAQUE_OUTPUT_REF.test(ref)) return null;
    const registeredAt = this.now();
    const entry: SurfaceOutputEntry = {
      ref,
      sourceKey,
      sourceRefs,
      subject: { ...input.subject },
      conversationId: input.conversationId,
      path: realPath,
      size: file.size,
      mtimeMs: file.mtimeMs,
      ino: Number(file.ino),
      mimeType: content.mimeType,
      contentKind: content.contentKind,
      sha256,
      outputKind: input.kind || 'artifact',
      label: safeLabel(input.label || basename(realPath)),
      registeredAt,
      expiresAt: registeredAt + this.ttlMs,
    };
    this.entries.set(ref, entry);
    this.refBySource.set(sourceKey, ref);
    for (const sourceRef of sourceRefs) {
      this.refBySource.set(this.ownerSourceKey(input.subject, sourceRef), ref);
    }
    return this.toRef(entry);
  }

  projectRefs(subject: SurfaceGrantSubjectV1, refs: readonly string[]): string[] {
    this.sessions.requireOwned(subject.sessionId, subject);
    return Array.from(new Set(refs.flatMap((sourceRef) => {
      const owned = this.entries.get(this.refBySource.get(this.ownerSourceKey(subject, sourceRef)) || '');
      if (owned) return [owned.ref];
      if (OPAQUE_OUTPUT_REF.test(sourceRef)) {
        const entry = this.entries.get(sourceRef);
        return entry && this.sameOwner(entry, subject) ? [sourceRef] : [];
      }
      return safePublicRef(sourceRef) ? [sourceRef] : [];
    })));
  }

  describeRefs(subject: SurfaceGrantSubjectV1, refs: readonly string[]): SurfaceOutputRefV1[] {
    return this.projectRefs(subject, refs).map((ref, index) => {
      const entry = this.entries.get(ref);
      return entry && this.sameOwner(entry, subject)
        ? this.toRef(entry)
        : { ref, kind: 'artifact', label: `Output ${index + 1}` };
    });
  }

  listOwned(subject: SurfaceGrantSubjectV1): SurfaceOutputRefV1[] {
    this.sessions.requireOwned(subject.sessionId, subject);
    this.pruneExpired();
    return Array.from(this.entries.values())
      .filter((entry) => this.sameOwner(entry, subject))
      .sort((left, right) => left.registeredAt - right.registeredAt)
      .map((entry) => this.toRef(entry));
  }

  async resolve(request: SurfaceOutputRequestV1): Promise<SurfaceOutputPayloadV1> {
    this.pruneExpired();
    const entry = this.entries.get(request.outputRef);
    const session = this.sessions.get(request.surfaceSessionId);
    if (!entry
      || session?.conversationId !== request.conversationId
      || entry.conversationId !== request.conversationId
      || entry.subject.sessionId !== request.surfaceSessionId
      || session.runId !== entry.subject.runId
      || session.agentId !== entry.subject.agentId) {
      throw this.error(request, 'SURFACE_TARGET_NOT_OWNED', 'Surface output is unavailable for this session.');
    }
    this.sessions.requireOwned(entry.subject.sessionId, entry.subject);
    let handle;
    try {
      handle = await open(entry.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    } catch {
      throw this.error(request, 'SURFACE_STATE_STALE', 'Surface output is no longer available.');
    }
    let bytes: Buffer;
    try {
      const before = await handle.stat();
      if (!before.isFile() || before.size !== entry.size || before.mtimeMs !== entry.mtimeMs
        || Number(before.ino) !== entry.ino || before.size <= 0 || before.size > MAX_OUTPUT_BYTES) {
        throw this.error(request, 'SURFACE_STATE_STALE', 'Surface output changed after registration.');
      }
      bytes = await handle.readFile();
      const after = await handle.stat();
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs
        || Number(after.ino) !== Number(before.ino)) {
        throw this.error(request, 'SURFACE_STATE_STALE', 'Surface output changed while it was read.');
      }
    } finally {
      await handle.close();
    }
    const content = inspectContent(entry.path, bytes);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    if (content?.mimeType !== entry.mimeType
      || content?.contentKind !== entry.contentKind || sha256 !== entry.sha256) {
      throw this.error(request, 'SURFACE_POLICY_BLOCKED', 'Surface output format is not allowed.');
    }
    const base = {
      version: 1 as const,
      outputRef: entry.ref,
      contentKind: entry.contentKind,
      mimeType: entry.mimeType,
      bytes: bytes.length,
      sha256,
    };
    if (entry.contentKind === 'image') {
      const mimeType = entry.mimeType as Extract<SurfaceOutputPayloadV1, { contentKind: 'image' }>['mimeType'];
      return { ...base, contentKind: 'image', mimeType, dataUrl: `data:${mimeType};base64,${bytes.toString('base64')}`, truncated: false };
    }
    const preview = bytes.subarray(0, MAX_TEXT_PREVIEW_BYTES);
    const mimeType = entry.mimeType as Extract<SurfaceOutputPayloadV1, { contentKind: 'text' }>['mimeType'];
    const text = redactTextPreview(new TextDecoder('utf-8').decode(preview), mimeType);
    return {
      ...base,
      contentKind: 'text',
      mimeType,
      text,
      truncated: bytes.length > preview.length,
    };
  }

  releaseSession(surfaceSessionId: string): void {
    for (const entry of this.entries.values()) {
      if (entry.subject.sessionId === surfaceSessionId) this.deleteEntry(entry);
    }
  }

  private toRef(entry: SurfaceOutputEntry): SurfaceOutputRefV1 {
    return {
      ref: entry.ref,
      kind: entry.outputKind,
      label: entry.label,
      createdAt: entry.registeredAt,
    };
  }

  private sameOwner(entry: SurfaceOutputEntry, subject: SurfaceGrantSubjectV1): boolean {
    return entry.subject.sessionId === subject.sessionId
      && entry.subject.runId === subject.runId
      && entry.subject.agentId === subject.agentId;
  }

  private ownerSourceKey(subject: SurfaceGrantSubjectV1, sourceRef: string): string {
    return [subject.sessionId, subject.runId, subject.agentId, sourceRef].join('\u001f');
  }

  private enforceCapacity(surfaceSessionId: string): void {
    const ordered = Array.from(this.entries.values())
      .sort((left, right) => left.registeredAt - right.registeredAt);
    const sessionEntries = ordered.filter((entry) => entry.subject.sessionId === surfaceSessionId);
    while (sessionEntries.length >= MAX_OUTPUTS_PER_SESSION) {
      const entry = sessionEntries.shift();
      if (entry) this.deleteEntry(entry);
    }
    while (this.entries.size >= MAX_OUTPUTS) {
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

  private deleteEntry(entry: SurfaceOutputEntry): void {
    this.entries.delete(entry.ref);
    if (this.refBySource.get(entry.sourceKey) === entry.ref) this.refBySource.delete(entry.sourceKey);
    for (const sourceRef of entry.sourceRefs) {
      const key = this.ownerSourceKey(entry.subject, sourceRef);
      if (this.refBySource.get(key) === entry.ref) this.refBySource.delete(key);
    }
  }

  private error(
    request: SurfaceOutputRequestV1,
    code: 'SURFACE_TARGET_NOT_OWNED' | 'SURFACE_STATE_STALE' | 'SURFACE_POLICY_BLOCKED',
    message: string,
  ): SurfaceExecutionRuntimeError {
    const session = this.sessions.get(request.surfaceSessionId);
    return new SurfaceExecutionRuntimeError({
      code,
      message,
      phase: 'artifact',
      retryable: code === 'SURFACE_STATE_STALE',
      recommendedAction: 'Refresh the owner-scoped Surface output.',
      surface: session?.surface || 'browser',
      provider: session?.provider || 'surface-runtime',
      sessionId: request.surfaceSessionId,
    });
  }
}
