import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ControlPlaneEnvelope } from '../../../src/shared/contract/controlPlane';
import {
  buildControlPlaneContentHash,
  buildControlPlaneSigningPayload,
} from '../../../src/main/services/cloud/controlPlaneTrust';
import { applyRendererBundleUpdate } from '../../../src/main/services/renderer/rendererBundleFetcher';
import {
  activeBundleDir,
  readActiveBundleMeta,
} from '../../../src/main/services/renderer/rendererBundleCache';

let dataDir: string;
let workDir: string;
let archivePath: string;
let archiveSha256: string;

/** 造一个真实 bundle.tar.gz（含 index.html + assets/app.js），返回路径 + sha256。 */
function buildBundleFixture(indexBody: string): { archivePath: string; sha256: string } {
  const src = fs.mkdtempSync(path.join(workDir, 'bundle-src-'));
  fs.mkdirSync(path.join(src, 'assets'));
  fs.writeFileSync(
    path.join(src, 'index.html'),
    `<!doctype html><html><head></head><body>${indexBody}</body></html>`,
    'utf-8',
  );
  fs.writeFileSync(path.join(src, 'assets', 'app.js'), 'console.log("cloud")', 'utf-8');
  const out = path.join(workDir, `bundle-${crypto.randomUUID()}.tar.gz`);
  // -C src . 把内容放在 tar 根（解压后直接是 index.html / assets/）
  execFileSync('tar', ['-czf', out, '-C', src, '.']);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  return { archivePath: out, sha256 };
}

/** 签一个 renderer_bundle envelope，payload 为 RendererBundleManifest。 */
function buildSignedManifest(payload: Record<string, unknown>, opts: { expiresAt?: string; kind?: string } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope: ControlPlaneEnvelope<Record<string, unknown>> = {
    schemaVersion: 1,
    kind: (opts.kind ?? 'renderer_bundle') as ControlPlaneEnvelope['kind'],
    issuedAt: '2026-06-01T00:00:00.000Z',
    expiresAt: opts.expiresAt ?? '2099-12-31T23:59:59.000Z',
    contentHash: buildControlPlaneContentHash(payload),
    keyId: 'rb-key',
    payload,
  };
  envelope.signature = crypto
    .sign(null, Buffer.from(buildControlPlaneSigningPayload(envelope)), privateKey)
    .toString('base64');
  return {
    envelope,
    publicKeys: { 'rb-key': publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  };
}

function seedExistingActive(version: string, contentHash: string, body: string): void {
  const active = activeBundleDir(dataDir);
  fs.mkdirSync(active, { recursive: true });
  fs.writeFileSync(
    path.join(active, 'index.html'),
    `<!doctype html><html><head></head><body>${body}</body></html>`,
    'utf-8',
  );
  fs.writeFileSync(path.join(active, '.bundle-meta.json'), JSON.stringify({ version, contentHash }), 'utf-8');
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-data-'));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-work-'));
  const fx = buildBundleFixture('CLOUD-V2');
  archivePath = fx.archivePath;
  archiveSha256 = fx.sha256;
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('applyRendererBundleUpdate', () => {
  it('applies a healthy, signed, integrity-checked bundle and swaps it into active/', async () => {
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async (_url, dest) => { fs.copyFileSync(archivePath, dest); },
    });

    expect(result).toEqual({ applied: true, version: '0.17.0', contentHash: archiveSha256 });
    const active = activeBundleDir(dataDir);
    expect(fs.readFileSync(path.join(active, 'index.html'), 'utf-8')).toContain('CLOUD-V2');
    expect(fs.existsSync(path.join(active, 'assets', 'app.js'))).toBe(true);
    expect(readActiveBundleMeta(dataDir)).toEqual({ version: '0.17.0', contentHash: archiveSha256 });
  });

  it('rejects when shell is too old (contract gate), without downloading', async () => {
    const manifest = {
      version: '0.18.0',
      contentHash: archiveSha256,
      minShellVersion: '0.18.0',
      bundleUrl: 'https://oss.example/bundle.tar.gz',
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);
    let downloaded = false;

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async () => { downloaded = true; },
    });

    expect(result).toEqual({ applied: false, reason: 'shell-too-old' });
    expect(downloaded).toBe(false);
    expect(fs.existsSync(activeBundleDir(dataDir))).toBe(false);
  });

  it('skips when bundle is already the current active', async () => {
    seedExistingActive('0.17.0', archiveSha256, 'OLD-ACTIVE');
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/bundle.tar.gz',
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async () => { throw new Error('should not download'); },
    });

    expect(result).toEqual({ applied: false, reason: 'already-current' });
  });

  it('rejects an untrusted envelope (wrong signing key) and leaves active untouched', async () => {
    seedExistingActive('0.16.0', 'oldhash', 'OLD-ACTIVE');
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/bundle.tar.gz',
    };
    const { envelope } = buildSignedManifest(manifest);
    // 用一把不匹配的公钥
    const { publicKey: otherPub } = crypto.generateKeyPairSync('ed25519');

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys: { 'rb-key': otherPub.export({ type: 'spki', format: 'pem' }).toString() },
      fetchJson: async () => envelope,
      downloadToFile: async (_url, dest) => { fs.copyFileSync(archivePath, dest); },
    });

    expect(result.applied).toBe(false);
    // 兜底：现有 active 不被破坏
    expect(fs.readFileSync(path.join(activeBundleDir(dataDir), 'index.html'), 'utf-8')).toContain('OLD-ACTIVE');
  });

  it('rejects on sha256 integrity mismatch and preserves existing active', async () => {
    seedExistingActive('0.16.0', 'oldhash', 'OLD-ACTIVE');
    const manifest = {
      version: '0.17.0',
      contentHash: 'f'.repeat(64), // 与真实 archive sha256 不符
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/bundle.tar.gz',
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async (_url, dest) => { fs.copyFileSync(archivePath, dest); },
    });

    expect(result).toEqual({ applied: false, reason: 'integrity-mismatch' });
    expect(fs.readFileSync(path.join(activeBundleDir(dataDir), 'index.html'), 'utf-8')).toContain('OLD-ACTIVE');
    expect(readActiveBundleMeta(dataDir)).toEqual({ version: '0.16.0', contentHash: 'oldhash' });
  });

  it('returns a failure result (never throws) when manifest fetch fails', async () => {
    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys: {},
      fetchJson: async () => { throw new Error('network down'); },
      downloadToFile: async () => {},
    });

    expect(result.applied).toBe(false);
    expect(result).toHaveProperty('reason');
  });
});
