import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type {
  SurfaceCapabilityManifestV1,
  SurfaceEvidenceCardV1,
} from '../../../../src/shared/contract/surfaceExecution';
import { SurfaceFrameRegistry } from '../../../../src/host/services/surfaceExecution/SurfaceFrameRegistry';
import { SurfaceSessionManager } from '../../../../src/host/services/surfaceExecution/SurfaceSessionManager';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ONE_PIXEL_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEAQH/3X8N2QAAAABJRU5ErkJggg==',
  'base64',
);
const roots: string[] = [];

function capabilities(): SurfaceCapabilityManifestV1 {
  return {
    version: 1,
    surface: 'browser',
    provider: 'managed-playwright',
    protocolVersion: 'surface-execution-v1',
    operations: ['observe'],
    observationKinds: ['screenshot'],
    supports: {
      cancel: true,
      pause: true,
      takeover: true,
      cleanup: true,
      successorObservation: true,
    },
  };
}

function evidence(assetRef: string): SurfaceEvidenceCardV1 {
  return {
    version: 1,
    evidenceId: 'evidence-frame-1',
    kind: 'screenshot',
    source: 'browser',
    title: 'Verified frame',
    capturedAt: 100,
    assetRef,
    redactionStatus: 'clean',
    inspection: {
      captureState: 'captured',
      analysisState: 'analyzed',
      verificationState: 'verified',
      supportsStepIds: ['verify-frame'],
      checklist: [],
    },
  };
}

function harness() {
  const sessions = new SurfaceSessionManager({ createId: () => 'surface-frame-owner', now: () => 100 });
  const session = sessions.create({
    conversationId: 'conversation-1',
    runId: 'run-1',
    agentId: 'agent-1',
    surface: 'browser',
    provider: 'managed-playwright',
    capabilities: capabilities(),
  });
  const subject = { sessionId: session.sessionId, runId: session.runId, agentId: session.agentId };
  sessions.transition(session.sessionId, subject, 'running');
  const registry = new SurfaceFrameRegistry(sessions, {
    createId: () => 'frame-opaque-1',
    now: () => 100,
  });
  return { registry, sessions, session, subject };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('SurfaceFrameRegistry', () => {
  it('replaces a verified local screenshot path with an owner-scoped opaque ref', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-frame-registry-'));
    roots.push(root);
    const path = join(root, 'frame.png');
    writeFileSync(path, PNG_SIGNATURE);
    const { registry, session, subject } = harness();

    const projected = registry.projectEvidence(subject, [evidence(path)]);
    const assetRef = projected?.[0]?.assetRef;
    expect(assetRef).toBe('surface-frame://frame-opaque-1');
    expect(JSON.stringify(projected)).not.toContain(root);

    await expect(registry.resolve({
      version: 1,
      conversationId: session.conversationId,
      surfaceSessionId: session.sessionId,
      assetRef: assetRef as string,
    })).resolves.toMatchObject({
      version: 1,
      assetRef,
      mimeType: 'image/png',
      bytes: PNG_SIGNATURE.length,
      dataUrl: `data:image/png;base64,${PNG_SIGNATURE.toString('base64')}`,
    });
  });

  it('freezes valid image dimensions into the projected card and resolved payload', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-frame-registry-'));
    roots.push(root);
    const path = join(root, 'one-pixel.png');
    writeFileSync(path, ONE_PIXEL_PNG);
    const { registry, session, subject } = harness();
    const captured = evidence(path);
    captured.captureContext = {
      target: {
        kind: 'browser',
        browserInstanceId: 'browser-1',
        windowRef: 'window-1',
        tabRef: 'tab-1',
        origin: 'https://example.test',
        documentRevision: 'document-1',
      },
    };

    const projected = registry.projectEvidence(subject, [captured]);
    expect(projected?.[0].captureContext?.viewport).toEqual({ width: 1, height: 1 });
    await expect(registry.resolve({
      version: 1,
      conversationId: session.conversationId,
      surfaceSessionId: session.sessionId,
      assetRef: projected?.[0].assetRef as string,
    })).resolves.toMatchObject({ width: 1, height: 1, bytes: ONE_PIXEL_PNG.length });
  });

  it('blocks foreign scope, changed files, symlinks, and released session frames', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-frame-registry-'));
    roots.push(root);
    const path = join(root, 'frame.png');
    const link = join(root, 'frame-link.png');
    writeFileSync(path, PNG_SIGNATURE);
    symlinkSync(path, link);
    const { registry, session, subject } = harness();
    const assetRef = registry.projectEvidence(subject, [evidence(path)])?.[0]?.assetRef as string;

    await expect(registry.resolve({
      version: 1,
      conversationId: 'conversation-foreign',
      surfaceSessionId: session.sessionId,
      assetRef,
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' } });

    writeFileSync(path, Buffer.concat([PNG_SIGNATURE, Buffer.from('changed')]));
    await expect(registry.resolve({
      version: 1,
      conversationId: session.conversationId,
      surfaceSessionId: session.sessionId,
      assetRef,
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_STATE_STALE' } });

    expect(registry.projectEvidence(subject, [evidence(link)])?.[0]).not.toHaveProperty('assetRef');
    registry.releaseSession(session.sessionId);
    await expect(registry.resolve({
      version: 1,
      conversationId: session.conversationId,
      surfaceSessionId: session.sessionId,
      assetRef,
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' } });
  });
});
