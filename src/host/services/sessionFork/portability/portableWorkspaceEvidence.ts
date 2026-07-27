import { createHash } from 'node:crypto';
import path from 'node:path';

import type {
  PortableContentAddressedBlobRefV1,
  PortableIsolatedAnchorContentV1,
  PortableIsolatedAnchorEvidenceV1,
  PortableSessionWorkspaceV2,
  PortableUntrackedFileV1,
  SessionExportSourceV2,
} from '../../../../shared/contract/sessionForkPortability';
import {
  PORTABLE_ANCHOR_MAX_PATCH_BYTES,
  PORTABLE_ANCHOR_MAX_UNTRACKED_BYTES,
  PORTABLE_ANCHOR_MAX_UNTRACKED_FILES,
  SessionForkPortabilityError,
} from '../../../../shared/contract/sessionForkPortability';
import type { AnchorWorkspaceEvidence } from '../workspace/types';
import { digestWorkspaceValue } from '../workspace/anchorEvidence';
import { portabilityDigest, withoutDigest } from './canonical';

type PortabilityErrorCode = ConstructorParameters<typeof SessionForkPortabilityError>[0];

function fail(code: PortabilityErrorCode, message: string): never {
  throw new SessionForkPortabilityError(code, message);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('INVALID_ENVELOPE', `${label} must be an object`);
  }
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail('INVALID_ENVELOPE', `${label}.${key} is not part of portable workspace evidence`);
    }
  }
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    fail('INVALID_ENVELOPE', `${label} must be a non-empty string`);
  }
}

function assertSafeNonNegativeInteger(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail('INVALID_ENVELOPE', `${label} must be a non-negative safe integer`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(value)) {
    fail('DIGEST_MISMATCH', `${label} must be a canonical SHA-256 digest`);
  }
}

function prefixedDigest(rawDigest: string, label: string): string {
  const normalized = rawDigest.toLowerCase().replace(/^sha256:/u, '');
  if (!/^[a-f0-9]{64}$/u.test(normalized)) {
    fail('DIGEST_MISMATCH', `${label} must be a SHA-256 digest`);
  }
  return `sha256:${normalized}`;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function decodeCanonicalBase64(value: unknown, label: string): Buffer {
  if (typeof value !== 'string') {
    fail('PORTABLE_EVIDENCE_REQUIRED', `${label} is missing`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    fail('DIGEST_MISMATCH', `${label} must use canonical base64`);
  }
  return decoded;
}

function normalizePortablePath(value: unknown, allowDot: boolean, label: string): string {
  if (
    typeof value !== 'string'
    || !value
    || value.includes('\0')
    || value.includes('\\')
    || value.startsWith('/')
    || /^[A-Za-z]:[\\/]/u.test(value)
  ) {
    fail('ABSOLUTE_WORKTREE_FORBIDDEN', `${label} must be repository-relative`);
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || (!allowDot && normalized === '.')
    || normalized === '..'
    || normalized.startsWith('../')
  ) {
    fail('ABSOLUTE_WORKTREE_FORBIDDEN', `${label} is not a canonical relative path`);
  }
  return normalized;
}

function assertCommit(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(value)) {
    fail('INVALID_ENVELOPE', `${label} must be a resolved Git commit id`);
  }
}

function assertPatchBytes(bytes: Buffer, label: string): void {
  if (bytes.byteLength > 0 && !bytes.subarray(0, 10).equals(Buffer.from('diff --git'))) {
    fail('INVALID_ENVELOPE', `${label} is not a Git binary patch stream`);
  }
}

function validateBlobReference(
  reference: PortableContentAddressedBlobRefV1,
  blobs: Record<string, string>,
  label: string,
): Buffer {
  assertObject(reference, label);
  assertDigest(reference.blobDigest, `${label}.blobDigest`);
  assertSafeNonNegativeInteger(reference.sizeBytes, `${label}.sizeBytes`);
  if (!Object.prototype.hasOwnProperty.call(blobs, reference.blobDigest)) {
    fail('PORTABLE_EVIDENCE_REQUIRED', `${label} has no content-addressed blob`);
  }
  const bytes = decodeCanonicalBase64(blobs[reference.blobDigest], `${label} blob`);
  if (bytes.byteLength !== reference.sizeBytes || sha256(bytes) !== reference.blobDigest) {
    fail('DIGEST_MISMATCH', `${label} does not match its content-addressed blob`);
  }
  return bytes;
}

function validateContent(
  content: PortableIsolatedAnchorContentV1,
  label: string,
): void {
  assertObject(content, label);
  assertOnlyKeys(content as unknown as Record<string, unknown>, [
    'version',
    'stagedPatch',
    'unstagedPatch',
    'untrackedFiles',
    'blobs',
    'payloadDigest',
  ], label);
  if (content.version !== 1) {
    fail('UNSUPPORTED_SCHEMA_VERSION', `${label}.version must be 1`);
  }
  assertObject(content.blobs, `${label}.blobs`);
  assertDigest(content.payloadDigest, `${label}.payloadDigest`);
  if (!Array.isArray(content.untrackedFiles)) {
    fail('PORTABLE_EVIDENCE_REQUIRED', `${label}.untrackedFiles is missing`);
  }
  if (content.untrackedFiles.length > PORTABLE_ANCHOR_MAX_UNTRACKED_FILES) {
    fail('PORTABLE_EVIDENCE_BUDGET_EXCEEDED', 'portable evidence contains too many untracked files');
  }

  assertObject(content.stagedPatch, `${label}.stagedPatch`);
  assertOnlyKeys(content.stagedPatch as unknown as Record<string, unknown>, [
    'blobDigest',
    'sizeBytes',
  ], `${label}.stagedPatch`);
  assertObject(content.unstagedPatch, `${label}.unstagedPatch`);
  assertOnlyKeys(content.unstagedPatch as unknown as Record<string, unknown>, [
    'blobDigest',
    'sizeBytes',
  ], `${label}.unstagedPatch`);
  assertSafeNonNegativeInteger(
    content.stagedPatch.sizeBytes,
    `${label}.stagedPatch.sizeBytes`,
  );
  assertSafeNonNegativeInteger(
    content.unstagedPatch.sizeBytes,
    `${label}.unstagedPatch.sizeBytes`,
  );
  if (
    content.stagedPatch.sizeBytes > PORTABLE_ANCHOR_MAX_PATCH_BYTES
    || content.unstagedPatch.sizeBytes > PORTABLE_ANCHOR_MAX_PATCH_BYTES
  ) {
    fail('PORTABLE_EVIDENCE_BUDGET_EXCEEDED', 'portable patch exceeds the byte budget');
  }
  const staged = validateBlobReference(content.stagedPatch, content.blobs, `${label}.stagedPatch`);
  const unstaged = validateBlobReference(content.unstagedPatch, content.blobs, `${label}.unstagedPatch`);
  assertPatchBytes(staged, `${label}.stagedPatch`);
  assertPatchBytes(unstaged, `${label}.unstagedPatch`);

  let untrackedBytes = 0;
  let previousPath = '';
  const referencedDigests = new Set([
    content.stagedPatch.blobDigest,
    content.unstagedPatch.blobDigest,
  ]);
  for (const [index, file] of content.untrackedFiles.entries()) {
    const fileLabel = `${label}.untrackedFiles[${index}]`;
    assertObject(file, fileLabel);
    assertOnlyKeys(file as unknown as Record<string, unknown>, [
      'relativePath',
      'blobDigest',
      'sizeBytes',
      'mode',
    ], fileLabel);
    normalizePortablePath(file.relativePath, false, `${fileLabel}.relativePath`);
    if (previousPath && previousPath.localeCompare(file.relativePath) >= 0) {
      fail('INVALID_ENVELOPE', 'portable untracked paths must be sorted and unique');
    }
    previousPath = file.relativePath;
    assertSafeNonNegativeInteger(file.mode, `${fileLabel}.mode`);
    if ((file.mode & ~0o777) !== 0) {
      fail('INVALID_ENVELOPE', `${fileLabel}.mode is outside the portable permission mask`);
    }
    if (untrackedBytes + file.sizeBytes > PORTABLE_ANCHOR_MAX_UNTRACKED_BYTES) {
      fail('PORTABLE_EVIDENCE_BUDGET_EXCEEDED', 'portable untracked blobs exceed the byte budget');
    }
    const bytes = validateBlobReference(file, content.blobs, fileLabel);
    untrackedBytes += bytes.byteLength;
    if (untrackedBytes > PORTABLE_ANCHOR_MAX_UNTRACKED_BYTES) {
      fail('PORTABLE_EVIDENCE_BUDGET_EXCEEDED', 'portable untracked blobs exceed the byte budget');
    }
    referencedDigests.add(file.blobDigest);
  }
  if (
    staged.byteLength === 0
    && unstaged.byteLength === 0
    && content.untrackedFiles.length === 0
  ) {
    fail('PORTABLE_EVIDENCE_REQUIRED', 'isolated anchor evidence contains no file state');
  }
  const actualDigests = Object.keys(content.blobs).sort();
  const expectedDigests = [...referencedDigests].sort();
  if (
    actualDigests.length !== expectedDigests.length
    || actualDigests.some((digest, index) => digest !== expectedDigests[index])
  ) {
    fail('REFERENCE_NOT_CLOSED', 'portable evidence blob set does not match its references');
  }
  for (const digest of actualDigests) assertDigest(digest, `${label}.blobs key`);
  if (portabilityDigest(withoutDigest(content)) !== content.payloadDigest) {
    fail('DIGEST_MISMATCH', `${label}.payloadDigest does not match`);
  }
}

export function validatePortableIsolatedAnchorEvidenceV1(
  evidence: PortableIsolatedAnchorEvidenceV1,
  label = 'isolatedAnchor',
): void {
  assertObject(evidence, label);
  assertOnlyKeys(evidence as unknown as Record<string, unknown>, [
    'evidenceId',
    'repositoryIdentityDigest',
    'baseCommit',
    'observedHead',
    'capturedAt',
    'workspaceScopeVersion',
    'diffDigest',
    'untrackedManifestDigest',
    'pathMappings',
    'content',
  ], label);
  assertNonEmptyString(evidence.evidenceId, `${label}.evidenceId`);
  assertDigest(evidence.repositoryIdentityDigest, `${label}.repositoryIdentityDigest`);
  assertCommit(evidence.baseCommit, `${label}.baseCommit`);
  assertCommit(evidence.observedHead, `${label}.observedHead`);
  assertSafeNonNegativeInteger(evidence.capturedAt, `${label}.capturedAt`);
  assertNonEmptyString(evidence.workspaceScopeVersion, `${label}.workspaceScopeVersion`);
  assertDigest(evidence.diffDigest, `${label}.diffDigest`);
  assertDigest(evidence.untrackedManifestDigest, `${label}.untrackedManifestDigest`);
  if (!Array.isArray(evidence.pathMappings) || evidence.pathMappings.length === 0) {
    fail('PORTABLE_EVIDENCE_REQUIRED', `${label}.pathMappings is missing`);
  }
  let mapsRepositoryRoot = false;
  const mappingKeys = new Set<string>();
  for (const [index, mapping] of evidence.pathMappings.entries()) {
    const mappingLabel = `${label}.pathMappings[${index}]`;
    assertObject(mapping, mappingLabel);
    assertOnlyKeys(mapping as unknown as Record<string, unknown>, [
      'sourceRootDigest',
      'relativePath',
      'isolatedRelativePath',
    ], mappingLabel);
    if (mapping.sourceRootDigest !== evidence.repositoryIdentityDigest) {
      fail('DIGEST_MISMATCH', `${mappingLabel}.sourceRootDigest crosses repository identity`);
    }
    normalizePortablePath(mapping.relativePath, true, `${mappingLabel}.relativePath`);
    normalizePortablePath(
      mapping.isolatedRelativePath,
      true,
      `${mappingLabel}.isolatedRelativePath`,
    );
    const mappingKey = `${mapping.relativePath}\0${mapping.isolatedRelativePath}`;
    if (mappingKeys.has(mappingKey)) {
      fail('INVALID_ENVELOPE', `${mappingLabel} duplicates another path mapping`);
    }
    mappingKeys.add(mappingKey);
    if (mapping.relativePath === '.' && mapping.isolatedRelativePath === '.') {
      mapsRepositoryRoot = true;
    }
  }
  if (!mapsRepositoryRoot) {
    fail('PORTABLE_EVIDENCE_REQUIRED', 'portable evidence must map repository root to isolated root');
  }
  validateContent(evidence.content, `${label}.content`);
  const expectedDiffDigest = portabilityDigest({
    stagedPatch: evidence.content.stagedPatch.blobDigest,
    unstagedPatch: evidence.content.unstagedPatch.blobDigest,
  });
  if (expectedDiffDigest !== evidence.diffDigest) {
    fail('DIGEST_MISMATCH', `${label}.diffDigest does not match patch content`);
  }
  if (portabilityDigest(evidence.content.untrackedFiles) !== evidence.untrackedManifestDigest) {
    fail('DIGEST_MISMATCH', `${label}.untrackedManifestDigest does not match`);
  }
}

export function validatePortableSessionWorkspaceV2(
  workspace: PortableSessionWorkspaceV2,
  label = 'workspace',
): void {
  assertObject(workspace, label);
  assertOnlyKeys(workspace as unknown as Record<string, unknown>, [
    'mode',
    'label',
    'anchorChildMessageId',
    'isolatedAnchor',
  ], label);
  if (workspace.mode === 'shared_current') {
    if (
      workspace.label !== '历史对话 + 当前文件'
      || workspace.anchorChildMessageId
      || workspace.isolatedAnchor
    ) {
      fail('INVALID_ENVELOPE', `${label} shared_current shape is invalid`);
    }
    return;
  }
  if (
    workspace.mode !== 'isolated_at_anchor'
    || workspace.label !== '历史对话 + 锚点文件'
    || !workspace.isolatedAnchor
  ) {
    fail('PORTABLE_EVIDENCE_REQUIRED', `${label} isolated evidence is required`);
  }
  if (
    workspace.anchorChildMessageId !== undefined
    && (
      typeof workspace.anchorChildMessageId !== 'string'
      || !workspace.anchorChildMessageId.trim()
    )
  ) {
    fail('INVALID_ENVELOPE', `${label}.anchorChildMessageId must be non-empty`);
  }
  validatePortableIsolatedAnchorEvidenceV1(
    workspace.isolatedAnchor,
    `${label}.isolatedAnchor`,
  );
}

export function sanitizePortableSessionWorkspaceV2(
  source: SessionExportSourceV2['workspace'],
): PortableSessionWorkspaceV2 | undefined {
  if (!source) return undefined;
  const isolatedAnchor = source.isolatedAnchor;
  if (isolatedAnchor && !isolatedAnchor.content) {
    fail('PORTABLE_EVIDENCE_REQUIRED', 'isolated anchor content is required');
  }
  const sanitized: PortableSessionWorkspaceV2 = {
    mode: source.mode,
    label: source.label,
    ...(source.anchorChildMessageId
      ? { anchorChildMessageId: source.anchorChildMessageId.trim() }
      : {}),
    ...(isolatedAnchor
      ? {
        isolatedAnchor: {
          evidenceId: isolatedAnchor.evidenceId,
          repositoryIdentityDigest: isolatedAnchor.repositoryIdentityDigest,
          baseCommit: isolatedAnchor.baseCommit,
          observedHead: isolatedAnchor.observedHead,
          capturedAt: isolatedAnchor.capturedAt,
          workspaceScopeVersion: isolatedAnchor.workspaceScopeVersion,
          diffDigest: isolatedAnchor.diffDigest,
          untrackedManifestDigest: isolatedAnchor.untrackedManifestDigest,
          pathMappings: isolatedAnchor.pathMappings.map((mapping) => ({
            sourceRootDigest: mapping.sourceRootDigest,
            relativePath: mapping.relativePath,
            isolatedRelativePath: mapping.isolatedRelativePath,
          })),
          content: {
            version: isolatedAnchor.content.version,
            stagedPatch: { ...isolatedAnchor.content.stagedPatch },
            unstagedPatch: { ...isolatedAnchor.content.unstagedPatch },
            untrackedFiles: isolatedAnchor.content.untrackedFiles.map((file) => ({ ...file })),
            blobs: { ...isolatedAnchor.content.blobs },
            payloadDigest: isolatedAnchor.content.payloadDigest,
          },
        },
      }
      : {}),
  };
  validatePortableSessionWorkspaceV2(sanitized);
  return sanitized;
}

function validateSourceEvidence(evidence: AnchorWorkspaceEvidence): void {
  const manifest = evidence?.manifest;
  const payload = evidence?.payload;
  if (
    manifest?.version !== 1
    || manifest.captureState !== 'complete'
    || manifest.baseCommitSource !== 'explicit_anchor_input'
    || !manifest.anchorId
    || !manifest.workspaceScopeVersion
    || !payload
  ) {
    fail('PORTABLE_EVIDENCE_REQUIRED', 'persisted anchor evidence is incomplete');
  }
  assertObject(manifest.repositoryIdentity, 'persisted repository identity');
  assertObject(payload.untrackedBlobs, 'persisted untracked blobs');
  if (!Array.isArray(manifest.pathMappings) || !Array.isArray(manifest.untrackedFiles)) {
    fail('PORTABLE_EVIDENCE_REQUIRED', 'persisted anchor evidence collections are incomplete');
  }
  assertCommit(manifest.baseCommit, 'persisted evidence baseCommit');
  assertCommit(manifest.observedHead, 'persisted evidence observedHead');
  assertSafeNonNegativeInteger(manifest.capturedAt, 'persisted evidence capturedAt');
  const { fingerprint, ...identityFields } = manifest.repositoryIdentity;
  if (digestWorkspaceValue(identityFields) !== fingerprint) {
    fail('DIGEST_MISMATCH', 'persisted repository identity fingerprint does not match');
  }
  const { evidenceDigest: _evidenceDigest, ...manifestWithoutDigest } = manifest;
  if (
    digestWorkspaceValue({ manifest: manifestWithoutDigest, payload })
    !== manifest.evidenceDigest
  ) {
    fail('DIGEST_MISMATCH', 'persisted anchor evidence digest does not match');
  }
  const staged = decodeCanonicalBase64(payload.stagedPatchBase64, 'persisted staged patch');
  const unstaged = decodeCanonicalBase64(payload.unstagedPatchBase64, 'persisted unstaged patch');
  if (
    staged.byteLength !== manifest.stagedPatch.sizeBytes
    || sha256(staged) !== prefixedDigest(manifest.stagedPatch.sha256, 'staged patch digest')
    || unstaged.byteLength !== manifest.unstagedPatch.sizeBytes
    || sha256(unstaged) !== prefixedDigest(manifest.unstagedPatch.sha256, 'unstaged patch digest')
  ) {
    fail('DIGEST_MISMATCH', 'persisted patch descriptor does not match its bytes');
  }
  assertPatchBytes(staged, 'persisted staged patch');
  assertPatchBytes(unstaged, 'persisted unstaged patch');
  if (
    staged.byteLength > PORTABLE_ANCHOR_MAX_PATCH_BYTES
    || unstaged.byteLength > PORTABLE_ANCHOR_MAX_PATCH_BYTES
  ) {
    fail('PORTABLE_EVIDENCE_BUDGET_EXCEEDED', 'persisted patch exceeds portability budget');
  }
  if (
    !Array.isArray(manifest.pathMappings)
    || manifest.pathMappings.length === 0
    || !manifest.pathMappings.some((mapping) => (
      mapping.repositoryRelativePath === '.' && mapping.isolatedRelativePath === '.'
    ))
  ) {
    fail('PORTABLE_EVIDENCE_REQUIRED', 'persisted evidence lacks a repository-root path mapping');
  }
  for (const [index, mapping] of manifest.pathMappings.entries()) {
    if (!path.isAbsolute(mapping.sourcePath)) {
      fail('ABSOLUTE_WORKTREE_FORBIDDEN', `persisted pathMappings[${index}].sourcePath is invalid`);
    }
    normalizePortablePath(
      mapping.repositoryRelativePath,
      true,
      `persisted pathMappings[${index}].repositoryRelativePath`,
    );
    normalizePortablePath(
      mapping.isolatedRelativePath,
      true,
      `persisted pathMappings[${index}].isolatedRelativePath`,
    );
  }
  if (manifest.untrackedFiles.length > PORTABLE_ANCHOR_MAX_UNTRACKED_FILES) {
    fail('PORTABLE_EVIDENCE_BUDGET_EXCEEDED', 'persisted evidence has too many untracked files');
  }
  const expectedUntrackedHashes = new Set<string>();
  let previousPath = '';
  let untrackedBytes = 0;
  for (const [index, file] of manifest.untrackedFiles.entries()) {
    normalizePortablePath(file.path, false, `persisted untrackedFiles[${index}].path`);
    if (previousPath && previousPath.localeCompare(file.path) >= 0) {
      fail('INVALID_ENVELOPE', 'persisted untracked paths must be sorted and unique');
    }
    previousPath = file.path;
    assertSafeNonNegativeInteger(file.sizeBytes, `persisted untrackedFiles[${index}].sizeBytes`);
    assertSafeNonNegativeInteger(file.mode, `persisted untrackedFiles[${index}].mode`);
    if ((file.mode & ~0o777) !== 0) {
      fail('INVALID_ENVELOPE', `persisted untrackedFiles[${index}].mode is invalid`);
    }
    const rawDigest = prefixedDigest(file.sha256, `persisted untrackedFiles[${index}].sha256`)
      .replace(/^sha256:/u, '');
    const bytes = decodeCanonicalBase64(
      payload.untrackedBlobs[rawDigest],
      `persisted untrackedFiles[${index}] blob`,
    );
    if (bytes.byteLength !== file.sizeBytes || sha256(bytes) !== `sha256:${rawDigest}`) {
      fail('DIGEST_MISMATCH', `persisted untrackedFiles[${index}] does not match`);
    }
    untrackedBytes += bytes.byteLength;
    if (untrackedBytes > PORTABLE_ANCHOR_MAX_UNTRACKED_BYTES) {
      fail('PORTABLE_EVIDENCE_BUDGET_EXCEEDED', 'persisted untracked bytes exceed budget');
    }
    expectedUntrackedHashes.add(rawDigest);
  }
  const actualUntrackedHashes = Object.keys(payload.untrackedBlobs).sort();
  const expectedSortedHashes = [...expectedUntrackedHashes].sort();
  if (
    actualUntrackedHashes.length !== expectedSortedHashes.length
    || actualUntrackedHashes.some((digest, index) => digest !== expectedSortedHashes[index])
  ) {
    fail('REFERENCE_NOT_CLOSED', 'persisted untracked blob set does not match its manifest');
  }
}

export function buildPortableIsolatedAnchorEvidenceV1(input: {
  evidenceId: string;
  repositoryIdentityDigest: string;
  evidence: AnchorWorkspaceEvidence;
}): PortableIsolatedAnchorEvidenceV1 {
  validateSourceEvidence(input.evidence);
  const repositoryIdentityDigest = prefixedDigest(
    input.repositoryIdentityDigest,
    'repositoryIdentityDigest',
  );
  const { manifest, payload } = input.evidence;
  const stagedPatch: PortableContentAddressedBlobRefV1 = {
    blobDigest: prefixedDigest(manifest.stagedPatch.sha256, 'staged patch digest'),
    sizeBytes: manifest.stagedPatch.sizeBytes,
  };
  const unstagedPatch: PortableContentAddressedBlobRefV1 = {
    blobDigest: prefixedDigest(manifest.unstagedPatch.sha256, 'unstaged patch digest'),
    sizeBytes: manifest.unstagedPatch.sizeBytes,
  };
  const untrackedFiles: PortableUntrackedFileV1[] = manifest.untrackedFiles.map((file) => ({
    relativePath: file.path,
    blobDigest: prefixedDigest(file.sha256, `untracked file ${file.path}`),
    sizeBytes: file.sizeBytes,
    mode: file.mode,
  }));
  const blobs: Record<string, string> = {
    [stagedPatch.blobDigest]: payload.stagedPatchBase64,
    [unstagedPatch.blobDigest]: payload.unstagedPatchBase64,
  };
  for (const file of untrackedFiles) {
    const rawDigest = file.blobDigest.replace(/^sha256:/u, '');
    const encoded = payload.untrackedBlobs[rawDigest];
    if (typeof encoded !== 'string') {
      fail('PORTABLE_EVIDENCE_REQUIRED', `persisted untracked blob is missing: ${file.relativePath}`);
    }
    const existing = blobs[file.blobDigest];
    if (existing !== undefined && existing !== encoded) {
      fail('DIGEST_MISMATCH', `content-addressed blob collision: ${file.relativePath}`);
    }
    blobs[file.blobDigest] = encoded;
  }
  const unsignedContent: Omit<PortableIsolatedAnchorContentV1, 'payloadDigest'> = {
    version: 1,
    stagedPatch,
    unstagedPatch,
    untrackedFiles,
    blobs,
  };
  const content: PortableIsolatedAnchorContentV1 = {
    ...unsignedContent,
    payloadDigest: portabilityDigest(unsignedContent),
  };
  const evidence: PortableIsolatedAnchorEvidenceV1 = {
    evidenceId: input.evidenceId,
    repositoryIdentityDigest,
    baseCommit: manifest.baseCommit,
    observedHead: manifest.observedHead,
    capturedAt: manifest.capturedAt,
    workspaceScopeVersion: manifest.workspaceScopeVersion,
    diffDigest: portabilityDigest({
      stagedPatch: stagedPatch.blobDigest,
      unstagedPatch: unstagedPatch.blobDigest,
    }),
    untrackedManifestDigest: portabilityDigest(untrackedFiles),
    pathMappings: manifest.pathMappings.map((mapping) => ({
      sourceRootDigest: repositoryIdentityDigest,
      relativePath: mapping.repositoryRelativePath,
      isolatedRelativePath: mapping.isolatedRelativePath,
    })),
    content,
  };
  validatePortableIsolatedAnchorEvidenceV1(evidence);
  return evidence;
}
