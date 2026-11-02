import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const writer = resolve(repoRoot, 'scripts/gen-native-dep-manifest.mjs');

type Target = 'darwin-arm64' | 'darwin-x64' | 'win32-x64';

const RESOURCES = {
  '../dist/native': 'dist/native',
  '../node_modules/keytar': 'node_modules/keytar',
  '../node_modules/node-pty/package.json': 'node_modules/node-pty/package.json',
  '../node_modules/node-pty/prebuilds/darwin-arm64': 'node_modules/node-pty/prebuilds/darwin-arm64',
  '../node_modules/sharp/package.json': 'node_modules/sharp/package.json',
  '../node_modules/@img/sharp-darwin-arm64/package.json': 'node_modules/@img/sharp-darwin-arm64/package.json',
  '../node_modules/@img/sharp-darwin-arm64/lib': 'node_modules/@img/sharp-darwin-arm64/lib',
  '../scripts/rtk': 'scripts/rtk',
  '../scripts/uv': 'scripts/uv',
  '../scripts/poppler': 'scripts/poppler',
  '../scripts/system-audio-capture': 'scripts/system-audio-capture',
  '../scripts/voice-aec-io': 'scripts/voice-aec-io',
  '../scripts/vision-ocr': 'scripts/vision-ocr',
  '../scripts/vision-tagger': 'scripts/vision-tagger',
  '../.tauri-resources.noindex/scripts/Agent Neo Computer Use.app': 'scripts/Agent Neo Computer Use.app',
};

const SHARP_VERSION = '0.35.3';

function writeJson(root: string, relativePath: string, value: unknown): void {
  const filePath = resolve(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writeFile(root: string, relativePath: string, contents = '', executable = false): void {
  const filePath = resolve(root, relativePath);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, contents);
  if (executable) {
    chmodSync(filePath, 0o755);
  }
}

function createFixture(
  target: Target,
  options: { includeSqlitePrebuild?: boolean; includeKeytarNative?: boolean; channel?: 'production' | 'dev' } = {},
): string {
  const { includeSqlitePrebuild = true, includeKeytarNative = true, channel = 'production' } = options;
  const root = mkdtempSync(resolve(tmpdir(), 'native-dep-manifest-'));
  writeJson(root, 'package.json', { version: '0.33.0' });
  writeJson(root, 'src-tauri/tauri.conf.json', { bundle: { resources: RESOURCES } });

  writeJson(root, 'dist/native/better-sqlite3/package.json', { version: '13.0.3' });
  if (includeSqlitePrebuild) {
    writeFile(root, `dist/native/better-sqlite3/prebuilds/${target}.node`);
  }

  writeJson(root, 'node_modules/keytar/package.json', { version: '7.9.0' });
  if (includeKeytarNative) {
    writeFile(root, 'node_modules/keytar/build/Release/keytar.node');
  }

  writeJson(root, 'node_modules/node-pty/package.json', { version: '1.1.0' });
  // The npm tarball carries every platform's prebuilds; only the target directory
  // is declared, and an executable spawn-helper ships alongside pty.node on darwin.
  writeFile(root, `node_modules/node-pty/prebuilds/${target}/pty.node`);
  writeFile(root, `node_modules/node-pty/prebuilds/${target}/spawn-helper`, '', target.startsWith('darwin'));
  if (target === 'win32-x64') {
    writeFile(root, `node_modules/node-pty/prebuilds/${target}/conpty.node`);
    writeFile(root, `node_modules/node-pty/prebuilds/${target}/conpty_console_list.node`);
  }
  writeFile(root, 'node_modules/node-pty/prebuilds/win32-arm64/pty.node');

  writeJson(root, 'node_modules/sharp/package.json', { version: SHARP_VERSION });
  writeJson(root, `node_modules/@img/sharp-${target}/package.json`, { version: SHARP_VERSION });
  writeFile(root, `node_modules/@img/sharp-${target}/lib/sharp-${target}-${SHARP_VERSION}.node`);

  writeFile(root, 'scripts/fetch-rtk.sh', '#!/bin/bash\nRTK_VERSION="9.9.9"\n');
  writeFile(root, 'scripts/fetch-uv.sh', '#!/bin/bash\nUV_VERSION="8.8.8"\n');
  const exeSuffix = target === 'win32-x64' ? '.exe' : '';
  writeFile(root, `scripts/rtk${exeSuffix}`, '', true);
  writeFile(root, `scripts/uv${exeSuffix}`, '', true);

  if (target.startsWith('darwin')) {
    writeFile(root, 'scripts/poppler/bin/pdfinfo', '', true);
    for (const helper of ['system-audio-capture', 'voice-aec-io', 'vision-ocr', 'vision-tagger']) {
      writeFile(root, `scripts/${helper}`, '', true);
    }
    // The dev chain only stages the Dev-named app (tauri.dev.conf.json nulls the
    // production key), so a dev fixture must not carry the production source.
    const cuaName = channel === 'dev' ? 'Agent Neo Computer Use Dev' : 'Agent Neo Computer Use';
    writeFile(root, `.tauri-resources.noindex/scripts/${cuaName}.app/Contents/MacOS/code-agent-cua`, '', true);
    if (channel === 'dev') {
      writeJson(root, 'src-tauri/tauri.dev.conf.json', { bundle: { resources: {
        '../.tauri-resources.noindex/scripts/Agent Neo Computer Use.app': null,
        '../.tauri-resources.noindex/scripts/Agent Neo Computer Use Dev.app': 'scripts/Agent Neo Computer Use Dev.app',
      } } });
    }
  }
  return root;
}

function runWriter(root: string, target: Target, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [writer, target, '--root', root], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function readManifest(root: string) {
  return JSON.parse(readFileSync(resolve(root, 'dist/native/manifest.json'), 'utf8'));
}

function expectedModules(target: Target) {
  const exeSuffix = target === 'win32-x64' ? '.exe' : '';
  const ptyNatives = target === 'win32-x64'
    ? [
      'node_modules/node-pty/prebuilds/win32-x64/conpty.node',
      'node_modules/node-pty/prebuilds/win32-x64/conpty_console_list.node',
      'node_modules/node-pty/prebuilds/win32-x64/pty.node',
    ]
    : [`node_modules/node-pty/prebuilds/${target}/pty.node`];
  const modules: Record<string, unknown> = {
    'better-sqlite3': {
      kind: 'node-module',
      entry: 'dist/native/better-sqlite3',
      native: `dist/native/better-sqlite3/prebuilds/${target}.node`,
      packageVersion: '13.0.3',
    },
    keytar: {
      kind: 'node-module',
      entry: 'node_modules/keytar',
      native: 'node_modules/keytar/build/Release/keytar.node',
      packageVersion: '7.9.0',
    },
    'node-pty': {
      kind: 'node-module',
      entry: 'node_modules/node-pty',
      natives: ptyNatives,
      packageVersion: '1.1.0',
    },
    sharp: {
      kind: 'node-module',
      entry: 'node_modules/sharp',
      native: `node_modules/@img/sharp-${target}/lib/sharp-${target}-${SHARP_VERSION}.node`,
      packageVersion: SHARP_VERSION,
    },
    rtk: { kind: 'tool-binary', path: `scripts/rtk${exeSuffix}`, executable: true, version: '9.9.9' },
    uv: { kind: 'tool-binary', path: `scripts/uv${exeSuffix}`, executable: true, version: '8.8.8' },
  };
  if (target.startsWith('darwin')) {
    modules.poppler = { kind: 'helper-dir', path: 'scripts/poppler' };
    for (const helper of ['system-audio-capture', 'voice-aec-io', 'vision-ocr', 'vision-tagger']) {
      modules[helper] = { kind: 'helper-binary', path: `scripts/${helper}`, executable: true };
    }
    modules['computer-use-app'] = { kind: 'app-bundle', path: 'scripts/Agent Neo Computer Use.app' };
  }
  return modules;
}

describe('gen-native-dep-manifest', () => {
  it.each(['darwin-arm64', 'darwin-x64', 'win32-x64'] as const)('generates the full module set for %s', (target) => {
    const root = createFixture(target);
    const result = runWriter(root, target);

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const manifest = readManifest(root);
    expect(manifest).toEqual({
      schemaVersion: 1,
      kind: 'agent_neo_native_dep_manifest',
      generatedAt: expect.any(String),
      generator: 'scripts/gen-native-dep-manifest.mjs',
      appVersion: '0.33.0',
      platform: target,
      modules: expectedModules(target),
    });
    expect(new Date(manifest.generatedAt).toISOString()).toBe(manifest.generatedAt);
  });

  it('declares both node-pty windows natives and no darwin-only entries for win32-x64', () => {
    const root = createFixture('win32-x64');
    const result = runWriter(root, 'win32-x64');

    expect(result.status).toBe(0);
    const modules = readManifest(root).modules;
    expect(modules['node-pty'].natives).toContain('node_modules/node-pty/prebuilds/win32-x64/conpty.node');
    expect(modules['node-pty'].natives).toContain('node_modules/node-pty/prebuilds/win32-x64/pty.node');
    expect(Object.keys(modules)).toEqual(expect.not.arrayContaining(['poppler', 'computer-use-app',
      'system-audio-capture', 'voice-aec-io', 'vision-ocr', 'vision-tagger']));
    expect(modules.rtk.path).toBe('scripts/rtk.exe');
    expect(modules.uv.path).toBe('scripts/uv.exe');
  });

  it('fails loudly without writing a manifest when the sqlite prebuild is missing', () => {
    const root = createFixture('darwin-arm64', { includeSqlitePrebuild: false });
    const result = runWriter(root, 'darwin-arm64');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Missing native dependency manifest path: dist/native/better-sqlite3/prebuilds/darwin-arm64.node',
    );
    expect(existsSync(resolve(root, 'dist/native/manifest.json'))).toBe(false);
  });

  it('fails loudly without writing a manifest when the keytar native is missing', () => {
    const root = createFixture('darwin-arm64', { includeKeytarNative: false });
    const result = runWriter(root, 'darwin-arm64');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Missing native dependency manifest path: node_modules/keytar/build/Release/keytar.node',
    );
    expect(existsSync(resolve(root, 'dist/native/manifest.json'))).toBe(false);
  });

  it('fails loudly when the win32 conpty native is missing', () => {
    const root = createFixture('win32-x64');
    rmSync(resolve(root, 'node_modules/node-pty/prebuilds/win32-x64/conpty.node'));
    const result = runWriter(root, 'win32-x64');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Missing native dependency manifest path: node_modules/node-pty/prebuilds/win32-x64/conpty.node',
    );
    expect(existsSync(resolve(root, 'dist/native/manifest.json'))).toBe(false);
  });

  it('fails loudly when the CUA app source is missing on darwin', () => {
    const root = createFixture('darwin-arm64');
    rmSync(resolve(root, '.tauri-resources.noindex'), { recursive: true });
    const result = runWriter(root, 'darwin-arm64');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      'Missing native dependency manifest path: .tauri-resources.noindex/scripts/Agent Neo Computer Use.app',
    );
    expect(existsSync(resolve(root, 'dist/native/manifest.json'))).toBe(false);
  });

  it('declares the Dev CUA app instead of the production one when NEO_CHANNEL=dev', () => {
    const root = createFixture('darwin-arm64', { channel: 'dev' });
    const result = runWriter(root, 'darwin-arm64', { NEO_CHANNEL: 'dev' });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    const modules = readManifest(root).modules;
    expect(modules['computer-use-app']).toEqual({
      kind: 'app-bundle',
      path: 'scripts/Agent Neo Computer Use Dev.app',
    });
    expect(JSON.stringify(modules)).not.toContain('scripts/Agent Neo Computer Use.app');
  });

  it('fails on an unknown NEO_CHANNEL instead of guessing', () => {
    const root = createFixture('darwin-arm64');
    const result = runWriter(root, 'darwin-arm64', { NEO_CHANNEL: 'staging' });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Unsupported NEO_CHANNEL: staging');
    expect(existsSync(resolve(root, 'dist/native/manifest.json'))).toBe(false);
  });

  it('fails loudly when the sharp platform lib has no single .node file', () => {
    const root = createFixture('darwin-arm64');
    rmSync(resolve(root, `node_modules/@img/sharp-darwin-arm64/lib/sharp-darwin-arm64-${SHARP_VERSION}.node`));
    const result = runWriter(root, 'darwin-arm64');

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Expected exactly one .node under node_modules/@img/sharp-darwin-arm64/lib');
    expect(existsSync(resolve(root, 'dist/native/manifest.json'))).toBe(false);
  });
});
