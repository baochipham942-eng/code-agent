import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SurfaceCapabilityManifestV1 } from '../../../../src/shared/contract/surfaceExecution';
import { SurfaceOutputRegistry } from '../../../../src/host/services/surfaceExecution/SurfaceOutputRegistry';
import { SurfaceSessionManager } from '../../../../src/host/services/surfaceExecution/SurfaceSessionManager';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
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

function harness(
  now: () => number = () => 100,
  createId: () => string = () => 'output-opaque-1',
) {
  const sessions = new SurfaceSessionManager({ createId: () => 'surface-output-owner', now });
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
  const registry = new SurfaceOutputRegistry(sessions, {
    createId,
    now,
    ttlMs: 50,
  });
  return { registry, session, subject };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('SurfaceOutputRegistry', () => {
  it('returns owner-scoped HTML as inert text without exposing the local path', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-output-registry-'));
    roots.push(root);
    const path = join(root, 'generated.html');
    const html = `<!doctype html><title>Verified output</title><p>business readback</p><p>token=surface-secret-canary-output ${root}/private.txt</p>`;
    writeFileSync(path, html);
    const { registry, session, subject } = harness();

    const output = registry.registerLocalOutput({
      subject,
      conversationId: session.conversationId,
      path,
      sourceRefs: ['artifact://generated-output'],
    });

    expect(output).toMatchObject({ ref: 'surface-output://output-opaque-1', label: 'generated.html' });
    expect(JSON.stringify(output)).not.toContain(root);
    expect(registry.projectRefs(subject, ['artifact://generated-output']))
      .toEqual(['surface-output://output-opaque-1']);
    await expect(registry.resolve({
      version: 1,
      conversationId: session.conversationId,
      surfaceSessionId: session.sessionId,
      outputRef: output!.ref,
    })).resolves.toMatchObject({
      outputRef: output!.ref,
      contentKind: 'text',
      mimeType: 'text/html',
      truncated: false,
      bytes: Buffer.byteLength(html),
    });
    const resolved = await registry.resolve({
      version: 1,
      conversationId: session.conversationId,
      surfaceSessionId: session.sessionId,
      outputRef: output!.ref,
    });
    expect(resolved.contentKind).toBe('text');
    expect(resolved.contentKind === 'text' ? resolved.text : '').toContain('business readback');
    expect(JSON.stringify(resolved)).not.toMatch(/surface-secret-canary-output|surface-output-registry-|private\.txt/);
  });

  it('returns supported images as immutable data URLs', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-output-registry-'));
    roots.push(root);
    const path = join(root, 'result.png');
    writeFileSync(path, PNG_SIGNATURE);
    const { registry, session, subject } = harness();
    const output = registry.registerLocalOutput({ subject, conversationId: session.conversationId, path });

    await expect(registry.resolve({
      version: 1,
      conversationId: session.conversationId,
      surfaceSessionId: session.sessionId,
      outputRef: output!.ref,
    })).resolves.toMatchObject({
      contentKind: 'image',
      mimeType: 'image/png',
      dataUrl: `data:image/png;base64,${PNG_SIGNATURE.toString('base64')}`,
      truncated: false,
    });
  });

  it('redacts sensitive JSON keys before returning an inert preview', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-output-registry-'));
    roots.push(root);
    const path = join(root, 'result.json');
    writeFileSync(path, JSON.stringify({ status: 'ok', password: 'raw-password', nested: { token: 'raw-token' } }));
    const { registry, session, subject } = harness();
    const output = registry.registerLocalOutput({ subject, conversationId: session.conversationId, path });
    const resolved = await registry.resolve({
      version: 1,
      conversationId: session.conversationId,
      surfaceSessionId: session.sessionId,
      outputRef: output!.ref,
    });

    expect(resolved.contentKind).toBe('text');
    expect(resolved.contentKind === 'text' ? resolved.text : '').toContain('"status": "ok"');
    expect(JSON.stringify(resolved)).not.toMatch(/raw-password|raw-token/);
  });

  it('blocks foreign ownership, mutation, symlinks, unsupported files, and expiry', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-output-registry-'));
    roots.push(root);
    const path = join(root, 'result.txt');
    const link = join(root, 'result-link.txt');
    const binary = join(root, 'result.bin');
    writeFileSync(path, 'first');
    writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
    symlinkSync(path, link);
    let now = 100;
    const { registry, session, subject } = harness(() => now);
    const output = registry.registerLocalOutput({ subject, conversationId: session.conversationId, path });

    await expect(registry.resolve({
      version: 1,
      conversationId: 'conversation-foreign',
      surfaceSessionId: session.sessionId,
      outputRef: output!.ref,
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' } });
    writeFileSync(path, 'changed');
    await expect(registry.resolve({
      version: 1,
      conversationId: session.conversationId,
      surfaceSessionId: session.sessionId,
      outputRef: output!.ref,
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_STATE_STALE' } });
    expect(registry.registerLocalOutput({ subject, conversationId: session.conversationId, path: link })).toBeNull();
    expect(registry.registerLocalOutput({ subject, conversationId: session.conversationId, path: binary })).toBeNull();
    now = 151;
    await expect(registry.resolve({
      version: 1,
      conversationId: session.conversationId,
      surfaceSessionId: session.sessionId,
      outputRef: output!.ref,
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' } });
  });

  it('evicts the oldest entry at the per-session capacity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'surface-output-registry-cap-'));
    roots.push(root);
    let id = 0;
    const { registry, session, subject } = harness(() => 100, () => `output-${++id}`);
    let firstRef = '';
    for (let index = 0; index <= 100; index += 1) {
      const path = join(root, `output-${index}.txt`);
      writeFileSync(path, `output ${index}`);
      const registered = registry.registerLocalOutput({
        subject,
        conversationId: session.conversationId,
        path,
      });
      if (index === 0) firstRef = registered!.ref;
    }

    expect(registry.listOwned(subject)).toHaveLength(100);
    await expect(registry.resolve({
      version: 1,
      conversationId: session.conversationId,
      surfaceSessionId: session.sessionId,
      outputRef: firstRef,
    })).rejects.toMatchObject({ surfaceError: { code: 'SURFACE_TARGET_NOT_OWNED' } });
  });
});
