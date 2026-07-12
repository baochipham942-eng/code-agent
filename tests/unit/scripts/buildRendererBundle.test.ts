import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_RENDERER_BUNDLE_MANIFEST_TTL_SECONDS,
  buildRendererBundleManifest,
  buildRendererRollbackManifest,
  createDeterministicRendererArchive,
  resolveRendererBundleSigningOptions,
} from '../../../scripts/build-renderer-bundle.mjs';

let tmp: string;
let archivePath: string;
let expectedSha: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-script-'));
  archivePath = path.join(tmp, 'bundle.tar.gz');
  const bytes = Buffer.from('fake-bundle-content-xyz');
  fs.writeFileSync(archivePath, bytes);
  expectedSha = crypto.createHash('sha256').update(bytes).digest('hex');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('buildRendererBundleManifest', () => {
  it('produces a manifest with the archive sha256 as contentHash', () => {
    const manifest = buildRendererBundleManifest({
      archivePath,
      version: '0.17.0',
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
    });

    expect(manifest).toEqual({
      version: '0.17.0',
      contentHash: expectedSha,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
    });
  });

  it('defaults minShellVersion to the bundle version when not provided', () => {
    const manifest = buildRendererBundleManifest({
      archivePath,
      version: '0.17.0',
      bundleUrl: 'https://oss.example/bundle.tar.gz',
    });

    expect(manifest.minShellVersion).toBe('0.17.0');
  });

  it('includes required shell capabilities when provided', () => {
    const manifest = buildRendererBundleManifest({
      archivePath,
      version: '0.17.0',
      bundleUrl: 'https://oss.example/bundle.tar.gz',
      requiredShellCapabilities: ['domain:update/check', 'domain:mcp/listTools', 'native:tauri/desktop_get_capabilities'],
      requiredRuntimeAssets: ['playwright-browser-runtime', 'onnxruntime-vad'],
      requiredResources: ['resources/browser-relay-extension'],
    });

    expect(manifest.requiredShellCapabilities).toEqual([
      'domain:update/check',
      'domain:mcp/listTools',
      'native:tauri/desktop_get_capabilities',
    ]);
    expect(manifest.requiredRuntimeAssets).toEqual([
      'playwright-browser-runtime',
      'onnxruntime-vad',
    ]);
    expect(manifest.requiredResources).toEqual(['resources/browser-relay-extension']);
  });

  it('dedupes required shell capabilities', () => {
    const manifest = buildRendererBundleManifest({
      archivePath,
      version: '0.17.0',
      bundleUrl: 'https://oss.example/bundle.tar.gz',
      requiredShellCapabilities: ['domain:update/check', 'domain:update/check'],
    });

    expect(manifest.requiredShellCapabilities).toEqual(['domain:update/check']);
  });

  it('throws when the archive is missing (fail closed)', () => {
    expect(() =>
      buildRendererBundleManifest({
        archivePath: path.join(tmp, 'nope.tar.gz'),
        version: '0.17.0',
        bundleUrl: 'https://oss.example/bundle.tar.gz',
      }),
    ).toThrow();
  });

  it('throws when required shell capabilities contain empty values', () => {
    expect(() =>
      buildRendererBundleManifest({
        archivePath,
        version: '0.17.0',
        bundleUrl: 'https://oss.example/bundle.tar.gz',
        requiredShellCapabilities: ['domain:update/check', ''],
      }),
    ).toThrow(/requiredShellCapabilities/);
  });

  it('throws when required runtime assets or resources contain empty values', () => {
    expect(() =>
      buildRendererBundleManifest({
        archivePath,
        version: '0.17.0',
        bundleUrl: 'https://oss.example/bundle.tar.gz',
        requiredRuntimeAssets: ['playwright-browser-runtime', ''],
      }),
    ).toThrow(/requiredRuntimeAssets/);
    expect(() =>
      buildRendererBundleManifest({
        archivePath,
        version: '0.17.0',
        bundleUrl: 'https://oss.example/bundle.tar.gz',
        requiredResources: ['resources/browser-relay-extension', ''],
      }),
    ).toThrow(/requiredResources/);
  });

  it('throws when required shell capabilities target shells before the capability gate exists', () => {
    expect(() =>
      buildRendererBundleManifest({
        archivePath,
        version: '0.16.93',
        minShellVersion: '0.16.92',
        bundleUrl: 'https://oss.example/bundle.tar.gz',
        requiredShellCapabilities: ['domain:update/check'],
      }),
    ).toThrow(/minShellVersion >= 0\.16\.93/);
  });

  it('builds rollback-to-builtin manifests without archive fields', () => {
    const manifest = buildRendererRollbackManifest({
      version: '0.17.0',
      minShellVersion: '0.16.93',
      rollbackReason: 'bad renderer overlay',
    });

    expect(manifest).toEqual({
      version: '0.17.0',
      minShellVersion: '0.16.93',
      rollbackToBuiltin: true,
      rollbackReason: 'bad renderer overlay',
    });
  });

  it('throws when rollback targets shells before rollback support exists', () => {
    expect(() =>
      buildRendererRollbackManifest({
        version: '0.17.0',
        minShellVersion: '0.16.92',
      }),
    ).toThrow(/rollbackToBuiltin needs minShellVersion >= 0\.16\.93/);
  });
});

describe('createDeterministicRendererArchive', () => {
  it('produces the same bundle hash across build directories and mtimes', () => {
    const rendererA = path.join(tmp, 'renderer-a');
    const rendererB = path.join(tmp, 'renderer-b');
    fs.mkdirSync(path.join(rendererA, 'assets'), { recursive: true });
    fs.mkdirSync(path.join(rendererB, 'assets'), { recursive: true });
    fs.writeFileSync(path.join(rendererA, 'index.html'), '<main>Neo</main>');
    fs.writeFileSync(path.join(rendererA, 'assets', 'app.js'), 'console.log("neo")');
    // Reverse creation order and timestamps to model concurrent main/tag builds.
    fs.writeFileSync(path.join(rendererB, 'assets', 'app.js'), 'console.log("neo")');
    fs.writeFileSync(path.join(rendererB, 'index.html'), '<main>Neo</main>');
    fs.utimesSync(path.join(rendererA, 'index.html'), new Date('2026-01-01'), new Date('2026-01-01'));
    fs.utimesSync(path.join(rendererB, 'index.html'), new Date('2026-07-12'), new Date('2026-07-12'));

    const archiveA = path.join(tmp, 'bundle-a.tar.gz');
    const archiveB = path.join(tmp, 'bundle-b.tar.gz');
    createDeterministicRendererArchive({ rendererDir: rendererA, archivePath: archiveA });
    createDeterministicRendererArchive({ rendererDir: rendererB, archivePath: archiveB });

    const hash = (filePath: string) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    expect(hash(archiveA)).toBe(hash(archiveB));
  });
});

describe('resolveRendererBundleSigningOptions', () => {
  it('defaults renderer bundle manifests to a long-lived static artifact TTL', () => {
    expect(resolveRendererBundleSigningOptions({ argv: ['node', 'script'], env: {} })).toEqual({
      ttlSeconds: DEFAULT_RENDERER_BUNDLE_MANIFEST_TTL_SECONDS,
    });
    expect(DEFAULT_RENDERER_BUNDLE_MANIFEST_TTL_SECONDS).toBe(365 * 24 * 60 * 60);
  });

  it('allows release jobs to override renderer manifest TTL', () => {
    expect(resolveRendererBundleSigningOptions({
      argv: ['node', 'script', '--manifest-ttl-seconds', '86400'],
      env: {},
    })).toEqual({ ttlSeconds: 86400 });
    expect(resolveRendererBundleSigningOptions({
      argv: ['node', 'script'],
      env: { RENDERER_BUNDLE_MANIFEST_TTL_SECONDS: '172800' },
    })).toEqual({ ttlSeconds: 172800 });
  });

  it('allows release jobs to pin an explicit renderer manifest expiry', () => {
    expect(resolveRendererBundleSigningOptions({
      argv: ['node', 'script', '--manifest-expires-at', '2099-12-31T23:59:59.000Z'],
      env: { RENDERER_BUNDLE_MANIFEST_TTL_SECONDS: '86400' },
    })).toEqual({ expiresAt: '2099-12-31T23:59:59.000Z' });
  });

  it('rejects invalid renderer manifest signing TTL inputs', () => {
    expect(() => resolveRendererBundleSigningOptions({
      argv: ['node', 'script', '--manifest-ttl-seconds', '0'],
      env: {},
    })).toThrow(/positive integer/);
    expect(() => resolveRendererBundleSigningOptions({
      argv: ['node', 'script', '--manifest-expires-at', 'not-a-date'],
      env: {},
    })).toThrow(/valid date/);
  });
});
