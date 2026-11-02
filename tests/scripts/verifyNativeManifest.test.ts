import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const checker = resolve(repoRoot, 'scripts/verify-native-manifest.mjs');
const nativePath = 'dist/native/better-sqlite3/prebuilds/darwin-arm64.node';

function writeFixtureFile(root: string, relativePath: string, contents = ''): void {
  const filePath = resolve(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
}

function createFixture(platform = 'darwin-arm64'): string {
  const root = mkdtempSync(resolve(tmpdir(), 'verify-native-manifest-'));
  writeFixtureFile(root, nativePath);
  writeFixtureFile(root, 'dist/native/manifest.json', `${JSON.stringify({
    schemaVersion: 1,
    kind: 'agent_neo_native_dep_manifest',
    platform,
    modules: {
      'better-sqlite3': {
        kind: 'node-module',
        entry: 'dist/native/better-sqlite3',
        native: nativePath,
      },
    },
  }, null, 2)}\n`);
  return root;
}

function runChecker(root: string, closure = false, platform = 'darwin-arm64') {
  return spawnSync(process.execPath, [
    checker,
    '--root',
    root,
    '--platform',
    platform,
    ...(closure ? ['--closure'] : []),
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

describe('verify-native-manifest', () => {
  it('passes a complete layout', () => {
    const root = createFixture();

    const result = runChecker(root, true);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('verified dist/native/manifest.json for darwin-arm64');
  });

  it('fails with the manifest path when the manifest is missing', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'verify-native-manifest-missing-'));

    const result = runChecker(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dist/native/manifest.json');
    expect(result.stderr).toContain('required manifest is missing');
  });

  it('fails with the declared native path when that file is missing', () => {
    const root = createFixture();
    rmSync(resolve(root, nativePath));

    const result = runChecker(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(nativePath);
    expect(result.stderr).toContain('declared native path is missing');
  });

  it('rejects an undeclared native file during closure', () => {
    const root = createFixture();
    const undeclaredPath = 'dist/native/undeclared.node';
    writeFixtureFile(root, undeclaredPath);

    const result = runChecker(root, true);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(undeclaredPath);
    expect(result.stderr).toContain('closure requires');
  });

  it('rejects a manifest for another platform', () => {
    const root = createFixture('darwin-x64');

    const result = runChecker(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('platform darwin-x64 does not match requested darwin-arm64');
  });

  it('allows a keytar native file that T6 has not declared yet', () => {
    const root = createFixture();
    writeFixtureFile(root, 'node_modules/keytar/build/Release/keytar.node');

    const result = runChecker(root, true);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
