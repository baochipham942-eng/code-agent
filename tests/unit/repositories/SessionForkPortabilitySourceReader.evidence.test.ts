import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';

import { digestWorkspaceValue } from '../../../src/host/services/sessionFork/workspace';
import { SessionForkPortabilitySourceReader } from '../../../src/host/services/core/repositories/SessionForkPortabilitySourceReader';

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function evidenceRow() {
  const stagedPatch = Buffer.from('diff --git a/tracked.txt b/tracked.txt\nstaged binary patch\n');
  const unstagedPatch = Buffer.from('diff --git a/tracked.txt b/tracked.txt\nunstaged binary patch\n');
  const untracked = Buffer.from([0, 255, 3, 4]);
  const identityFields = {
    canonicalRoot: '/source/private/repository',
    canonicalGitCommonDirectory: '/source/private/repository/.git',
    rootDevice: '1',
    rootInode: '2',
    gitCommonDevice: '1',
    gitCommonInode: '3',
    objectFormat: 'sha1',
  };
  const manifestWithoutDigest = {
    version: 1 as const,
    captureState: 'complete' as const,
    anchorId: 'assistant-a2',
    capturedAt: 10,
    baseCommit: 'a'.repeat(40),
    baseCommitSource: 'explicit_anchor_input' as const,
    observedHead: 'b'.repeat(40),
    workspaceScopeVersion: 'scope-v1',
    repositoryIdentity: {
      ...identityFields,
      fingerprint: digestWorkspaceValue(identityFields),
    },
    pathMappings: [{
      sourceId: 'primary',
      sourcePath: '/source/private/repository',
      repositoryRelativePath: '.',
      isolatedRelativePath: '.',
    }],
    stagedPatch: { sha256: sha256(stagedPatch), sizeBytes: stagedPatch.byteLength },
    unstagedPatch: { sha256: sha256(unstagedPatch), sizeBytes: unstagedPatch.byteLength },
    untrackedFiles: [{
      path: 'new.bin',
      sha256: sha256(untracked),
      sizeBytes: untracked.byteLength,
      mode: 0o600,
    }],
  };
  const payload = {
    stagedPatchBase64: stagedPatch.toString('base64'),
    unstagedPatchBase64: unstagedPatch.toString('base64'),
    untrackedBlobs: {
      [sha256(untracked)]: untracked.toString('base64'),
    },
  };
  const evidence = {
    manifest: {
      ...manifestWithoutDigest,
      evidenceDigest: digestWorkspaceValue({
        manifest: manifestWithoutDigest,
        payload,
      }),
    },
    payload,
  };
  return {
    saga_state: 'completed',
    intent_status: 'advertised',
    advertisable: 1,
    evidence_status: 'complete',
    evidence_id: 'evidence-1',
    intent_evidence_digest: evidence.manifest.evidenceDigest,
    evidence_digest: evidence.manifest.evidenceDigest,
    source_identity_digest: '1'.repeat(64),
    source_identity_json: JSON.stringify(identityFields),
    base_commit: evidence.manifest.baseCommit,
    evidence_json: JSON.stringify(evidence),
  };
}

function readerForRow(row: Record<string, unknown>) {
  const get = vi.fn(() => row);
  const db = {
    prepare: vi.fn(() => ({ get })),
  };
  const reader = new SessionForkPortabilitySourceReader(db as never);
  return {
    read: (reader as unknown as {
      readPortableWorkspace: (fork: Record<string, unknown>) => unknown;
    }).readPortableWorkspace.bind(reader),
  };
}

const isolatedFork = {
  id: 'fork-1',
  child_session_id: 'child-1',
  workspace_mode: 'isolated_at_anchor',
};

describe('SessionForkPortabilitySourceReader isolated evidence', () => {
  it('exports content-addressed bytes while removing every absolute source path', () => {
    const workspace = readerForRow(evidenceRow()).read(isolatedFork) as {
      isolatedAnchor: {
        content: {
          stagedPatch: { blobDigest: string };
          untrackedFiles: Array<{ relativePath: string; blobDigest: string }>;
          blobs: Record<string, string>;
        };
      };
    };

    expect(workspace.isolatedAnchor.content.untrackedFiles).toEqual([
      expect.objectContaining({ relativePath: 'new.bin', mode: 0o600 }),
    ]);
    const stagedDigest = workspace.isolatedAnchor.content.stagedPatch.blobDigest;
    expect(Buffer.from(workspace.isolatedAnchor.content.blobs[stagedDigest], 'base64').toString())
      .toContain('staged binary patch');
    expect(JSON.stringify(workspace)).not.toContain('/source/private');
  });

  it('fails closed when persisted evidence bytes no longer match their digest', () => {
    const row = evidenceRow();
    const evidence = JSON.parse(String(row.evidence_json)) as {
      payload: { stagedPatchBase64: string };
    };
    evidence.payload.stagedPatchBase64 = Buffer.from('tampered').toString('base64');
    row.evidence_json = JSON.stringify(evidence);

    expect(() => readerForRow(row).read(isolatedFork)).toThrow(/DIGEST_MISMATCH/u);
  });
});
