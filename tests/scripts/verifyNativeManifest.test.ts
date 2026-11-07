import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const checker = resolve(repoRoot, 'scripts/verify-native-manifest.mjs');

type Platform = 'darwin-arm64' | 'darwin-x64' | 'win32-x64';
const SHARP_VERSION = '0.35.3';

function writeFixtureFile(root: string, relativePath: string, contents = '', executable = false): void {
  const filePath = resolve(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  if (executable) {
    chmodSync(filePath, 0o755);
  }
}

function manifestJson(platform: Platform): string {
  const modules: Record<string, unknown> = {
    'better-sqlite3': {
      kind: 'node-module',
      entry: 'dist/native/better-sqlite3',
      native: `dist/native/better-sqlite3/prebuilds/${platform}.node`,
    },
    keytar: {
      kind: 'node-module',
      entry: 'node_modules/keytar',
      native: 'node_modules/keytar/build/Release/keytar.node',
    },
    'node-pty': {
      kind: 'node-module',
      entry: 'node_modules/node-pty',
      natives: platform === 'win32-x64'
        ? [
          'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
          'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
          'node_modules/node-pty/prebuilds/win32-x64/pty.node',
        ]
        : [`node_modules/node-pty/prebuilds/${platform}/pty.node`],
    },
    sharp: {
      kind: 'node-module',
      entry: 'node_modules/sharp',
      native: `node_modules/@img/sharp-${platform}/lib/sharp-${platform}-${SHARP_VERSION}.node`,
    },
    rtk: { kind: 'tool-binary', path: `scripts/rtk${platform === 'win32-x64' ? '.exe' : ''}`, executable: true },
    uv: { kind: 'tool-binary', path: `scripts/uv${platform === 'win32-x64' ? '.exe' : ''}`, executable: true },
  };
  if (platform.startsWith('darwin')) {
    modules.poppler = { kind: 'helper-dir', path: 'scripts/poppler' };
    for (const helper of ['system-audio-capture', 'voice-aec-io', 'vision-ocr', 'vision-tagger']) {
      modules[helper] = { kind: 'helper-binary', path: `scripts/${helper}`, executable: true };
    }
    modules['computer-use-app'] = { kind: 'app-bundle', path: 'scripts/Agent Neo Computer Use.app' };
  }
  return `${JSON.stringify({ schemaVersion: 1, kind: 'agent_neo_native_dep_manifest', platform, modules }, null, 2)}\n`;
}

/** Bundle-shaped fixture: the declared target paths exist under root. */
function createFixture(platform: Platform = 'darwin-arm64'): string {
  const root = mkdtempSync(resolve(tmpdir(), 'verify-native-manifest-'));
  writeFixtureFile(root, `dist/native/better-sqlite3/prebuilds/${platform}.node`);
  writeFixtureFile(root, 'node_modules/keytar/build/Release/keytar.node');
  if (platform === 'win32-x64') {
    writeFixtureFile(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty.node');
    writeFixtureFile(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node');
    writeFixtureFile(root, 'node_modules/node-pty/prebuilds/win32-x64/pty.node');
    writeFixtureFile(root, 'scripts/rtk.exe');
    writeFixtureFile(root, 'scripts/uv.exe');
  } else {
    writeFixtureFile(root, `node_modules/node-pty/prebuilds/${platform}/pty.node`);
    writeFixtureFile(root, 'scripts/rtk', '', true);
    writeFixtureFile(root, 'scripts/uv', '', true);
    writeFixtureFile(root, 'scripts/poppler/bin/pdfinfo', '', true);
    writeFixtureFile(root, 'scripts/poppler/lib/libpoppler.42.dylib');
    for (const helper of ['system-audio-capture', 'voice-aec-io', 'vision-ocr', 'vision-tagger']) {
      writeFixtureFile(root, `scripts/${helper}`, '', true);
    }
    writeFixtureFile(root, 'scripts/Agent Neo Computer Use.app/Contents/MacOS/code-agent-cua', '', true);
    writeFixtureFile(root, 'scripts/Agent Neo Computer Use.app/Contents/Resources/runtime.bin');
  }
  writeFixtureFile(root, `node_modules/@img/sharp-${platform}/lib/sharp-${platform}-${SHARP_VERSION}.node`);
  writeFixtureFile(root, 'node_modules/sharp/package.json', '{}');
  writeFixtureFile(root, 'dist/native/manifest.json', manifestJson(platform));
  return root;
}

function runChecker(root: string, closure = false, platform: Platform = 'darwin-arm64') {
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
  it.each(['darwin-arm64', 'darwin-x64', 'win32-x64'] as const)('passes a complete %s bundle layout with closure', (platform) => {
    const root = createFixture(platform);

    const result = runChecker(root, true, platform);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`verified dist/native/manifest.json for ${platform}`);
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
    rmSync(resolve(root, 'dist/native/better-sqlite3/prebuilds/darwin-arm64.node'));

    const result = runChecker(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('dist/native/better-sqlite3/prebuilds/darwin-arm64.node');
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

  it.each([
    ['keytar', 'node_modules/keytar/build/Debug/keytar.node'],
    ['node-pty', 'node_modules/node-pty/build/Release/pty.node'],
    ['sharp', 'node_modules/@img/sharp-win32-x64/lib/sharp-win32-x64-0.35.3.node'],
  ])('rejects an undeclared %s native file that is no longer allowlisted', (_module, undeclaredPath) => {
    const root = createFixture();
    writeFixtureFile(root, undeclaredPath);

    const result = runChecker(root, true);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(undeclaredPath);
    expect(result.stderr).toContain('closure requires');
  });

  it('rejects an undeclared executable under scripts/ during closure', () => {
    const root = createFixture();
    writeFixtureFile(root, 'scripts/rogue-helper', '', true);

    const result = runChecker(root, true);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('scripts/rogue-helper');
    expect(result.stderr).toContain('closure requires');
  });

  it('still allows non-target node-pty prebuilds from the npm tarball', () => {
    const root = createFixture('win32-x64');
    writeFixtureFile(root, 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node');
    writeFixtureFile(root, 'node_modules/node-pty/prebuilds/win32-arm64/pty.node');

    const result = runChecker(root, true, 'win32-x64');

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });

  it('fails naming the declared win32 conpty native when it is deleted', () => {
    const root = createFixture('win32-x64');
    rmSync(resolve(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty.node'));

    const result = runChecker(root, false, 'win32-x64');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('node_modules/node-pty/prebuilds/win32-x64/conpty.node');
    expect(result.stderr).toContain('declared natives path is missing');
  });

  it('rejects a natives field that is not a non-empty string array', () => {
    const root = createFixture();
    const manifest = JSON.parse(manifestJson('darwin-arm64'));
    manifest.modules['node-pty'].natives = 'node_modules/node-pty/prebuilds/darwin-arm64/pty.node';
    writeFixtureFile(root, 'dist/native/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

    const result = runChecker(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('modules.node-pty.natives');
    expect(result.stderr).toContain('natives must be a non-empty array of non-empty strings');
  });

  it('rejects a natives entry that escapes the resources root', () => {
    const root = createFixture();
    const manifest = JSON.parse(manifestJson('darwin-arm64'));
    manifest.modules['node-pty'].natives = ['../../escape.node'];
    writeFixtureFile(root, 'dist/native/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

    const result = runChecker(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('modules.node-pty.natives');
    expect(result.stderr).toContain('escapes the resources root');
  });

  it('rejects a natives entry whose file is missing', () => {
    const root = createFixture();
    const manifest = JSON.parse(manifestJson('darwin-arm64'));
    manifest.modules['node-pty'].natives = ['node_modules/node-pty/prebuilds/darwin-arm64/missing.node'];
    writeFixtureFile(root, 'dist/native/manifest.json', `${JSON.stringify(manifest, null, 2)}\n`);

    const result = runChecker(root);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('node_modules/node-pty/prebuilds/darwin-arm64/missing.node');
    expect(result.stderr).toContain('declared natives path is missing');
  });

  it('counts files under a declared helper-dir and app-bundle as declared for closure', () => {
    const root = createFixture();
    // Extra executables inside the declared helper-dir / app-bundle are covered by
    // their manifest entries, not by any allowlist pattern.
    writeFixtureFile(root, 'scripts/poppler/bin/pdftotext', '', true);
    writeFixtureFile(root, 'scripts/Agent Neo Computer Use.app/Contents/MacOS/helper-b', '', true);

    const result = runChecker(root, true);

    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
  });
});
