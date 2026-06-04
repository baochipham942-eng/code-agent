import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { buildRendererBundleManifest } from '../../../scripts/build-renderer-bundle.mjs';

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

  it('throws when the archive is missing (fail closed)', () => {
    expect(() =>
      buildRendererBundleManifest({
        archivePath: path.join(tmp, 'nope.tar.gz'),
        version: '0.17.0',
        bundleUrl: 'https://oss.example/bundle.tar.gz',
      }),
    ).toThrow();
  });
});
