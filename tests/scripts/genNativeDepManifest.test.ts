import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const writer = resolve(repoRoot, 'scripts/gen-native-dep-manifest.mjs');

function writeJson(root: string, relativePath: string, value: unknown): void {
  const filePath = resolve(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function createFixture(target: string, includePrebuild = true): string {
  const root = mkdtempSync(resolve(tmpdir(), 'native-dep-manifest-'));
  writeJson(root, 'package.json', { version: '0.33.0' });
  writeJson(root, 'src-tauri/tauri.conf.json', {
    bundle: { resources: { '../dist/native': 'dist/native' } },
  });
  writeJson(root, 'dist/native/better-sqlite3/package.json', { version: '13.0.3' });
  if (includePrebuild) {
    const prebuild = resolve(root, `dist/native/better-sqlite3/prebuilds/${target}.node`);
    mkdirSync(dirname(prebuild), { recursive: true });
    writeFileSync(prebuild, '');
  }
  return root;
}

function runWriter(root: string, target: string) {
  return spawnSync(process.execPath, [writer, target, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('gen-native-dep-manifest', () => {
  it('generates a schema-valid manifest for a fixture layout', () => {
    const root = createFixture('darwin-arm64');
    const result = runWriter(root, 'darwin-arm64');

    expect(result.status).toBe(0);
    const manifest = JSON.parse(readFileSync(resolve(root, 'dist/native/manifest.json'), 'utf8'));
    expect(manifest).toEqual({
      schemaVersion: 1,
      kind: 'agent_neo_native_dep_manifest',
      generatedAt: expect.any(String),
      generator: 'scripts/gen-native-dep-manifest.mjs',
      appVersion: '0.33.0',
      platform: 'darwin-arm64',
      modules: {
        'better-sqlite3': {
          kind: 'node-module',
          entry: 'dist/native/better-sqlite3',
          native: 'dist/native/better-sqlite3/prebuilds/darwin-arm64.node',
          packageVersion: '13.0.3',
        },
      },
    });
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
  });

  it('fails loudly without writing a manifest when the prebuild is missing', () => {
    const root = createFixture('darwin-arm64', false);
    const result = runWriter(root, 'darwin-arm64');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Missing native dependency manifest path: dist/native/better-sqlite3/prebuilds/darwin-arm64.node',
    );
    expect(existsSync(resolve(root, 'dist/native/manifest.json'))).toBe(false);
  });

  it('uses the target argument rather than the host for the platform label', () => {
    const root = createFixture('win32-x64');
    const result = runWriter(root, 'win32-x64');

    expect(result.status).toBe(0);
    const manifest = JSON.parse(readFileSync(resolve(root, 'dist/native/manifest.json'), 'utf8'));
    expect(manifest.platform).toBe('win32-x64');
    expect(manifest.modules['better-sqlite3'].native)
      .toBe('dist/native/better-sqlite3/prebuilds/win32-x64.node');
  });
});
