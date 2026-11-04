import fs from 'fs';
import os from 'os';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, describe, expect, it } from 'vitest';
import { readNativeDepManifest, resolveNativeDepEntry } from '../../../src/host/runtime/nativeDepManifest';

const CURRENT_PLATFORM = `${process.platform}-${process.arch}`;
const FIXTURE_GENERATED_AT = '2026-10-28T00:00:00.000Z';

const tempRoots: string[] = [];

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-neo-native-dep-manifest-'));
  tempRoots.push(root);
  return root;
}

interface FixtureOptions {
  platform?: string;
  schemaVersion?: number;
  kind?: string;
  createEntryDir?: boolean;
}

/** 按 writer(scripts/gen-native-dep-manifest.mjs)的真实形状落一份清单 fixture。 */
function writeManifestFixture(root: string, options: FixtureOptions = {}): string {
  if (options.createEntryDir !== false) {
    const entryDir = path.join(root, 'dist', 'native', 'better-sqlite3');
    fs.mkdirSync(entryDir, { recursive: true });
    fs.writeFileSync(path.join(entryDir, 'index.js'), 'module.exports = { __fixtureNativeDep: true };\n', 'utf8');
  }
  const manifest = {
    schemaVersion: options.schemaVersion ?? 1,
    kind: options.kind ?? 'agent_neo_native_dep_manifest',
    generatedAt: FIXTURE_GENERATED_AT,
    generator: 'scripts/gen-native-dep-manifest.mjs',
    appVersion: '0.0.0-test',
    platform: options.platform ?? CURRENT_PLATFORM,
    modules: {
      'better-sqlite3': {
        kind: 'node-module',
        entry: 'dist/native/better-sqlite3',
        native: 'dist/native/better-sqlite3/prebuilds/darwin-arm64.node',
        packageVersion: '13.0.3',
      },
    },
  };
  fs.mkdirSync(path.join(root, 'dist', 'native'), { recursive: true });
  const manifestPath = path.join(root, 'dist', 'native', 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
}

function bundleEnv(root: string): NodeJS.ProcessEnv {
  return { AGENT_NEO_BUNDLED_RUNTIME_ROOT: root, AGENT_NEO_RESOURCE_DIR: path.join(root, 'Resources') };
}

function captureError(action: () => unknown): Error | undefined {
  try {
    action();
    return undefined;
  } catch (error) {
    return error as Error;
  }
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe('readNativeDepManifest', () => {
  it('(a) resolves better-sqlite3 from a valid manifest', () => {
    const root = makeTempRoot();
    const manifestPath = writeManifestFixture(root);

    const manifest = readNativeDepManifest(bundleEnv(root));

    expect(manifest).not.toBeNull();
    expect(manifest!.manifestPath).toBe(manifestPath);
    expect(manifest!.platform).toBe(CURRENT_PLATFORM);
    const entryPath = resolveNativeDepEntry(manifest!, 'better-sqlite3');
    expect(entryPath).toBe(path.join(root, 'dist', 'native', 'better-sqlite3'));
    expect(fs.existsSync(entryPath)).toBe(true);
    const loaded = createRequire(import.meta.url)(entryPath) as { __fixtureNativeDep: boolean };
    expect(loaded.__fixtureNativeDep).toBe(true);
  });

  it('(b) throws the ADR-086 §4.4 message when the manifest file is missing', () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'dist', 'native'), { recursive: true });

    const error = captureError(() => readNativeDepManifest(bundleEnv(root)));

    expect(error?.message).toBe(
      `[native-dep-manifest] bundle mode but manifest is missing: expected ${path.join(
        root,
        'dist',
        'native',
        'manifest.json',
      )}. This app bundle is incomplete (packaging bug). Fix: rebuild the bundle so scripts/gen-native-dep-manifest.mjs runs (tauri:package / tauri:package:dev chains). Do not hand-patch the bundle.`,
    );
  });

  it('(b2) treats an unparsable or wrong-kind manifest as missing', () => {
    const root = makeTempRoot();
    const corruptRoot = makeTempRoot();
    writeManifestFixture(root, { kind: 'something-else' });
    fs.mkdirSync(path.join(corruptRoot, 'dist', 'native'), { recursive: true });
    fs.writeFileSync(path.join(corruptRoot, 'dist', 'native', 'manifest.json'), '{ not json', 'utf8');

    for (const target of [root, corruptRoot]) {
      const error = captureError(() => readNativeDepManifest(bundleEnv(target)));
      expect(error?.message).toContain(
        `[native-dep-manifest] bundle mode but manifest is missing: expected ${path.join(
          target,
          'dist',
          'native',
          'manifest.json',
        )}`,
      );
      expect(error?.message).toContain('Do not hand-patch the bundle.');
    }
  });

  it('(c) throws the ADR-086 §4.4 message when the declared entry path is missing', () => {
    const root = makeTempRoot();
    writeManifestFixture(root, { createEntryDir: false });

    const manifest = readNativeDepManifest(bundleEnv(root));
    expect(manifest).not.toBeNull();
    const error = captureError(() => resolveNativeDepEntry(manifest!, 'better-sqlite3'));

    expect(error?.message).toBe(
      `[native-dep-manifest] module 'better-sqlite3' is declared at ${path.join(
        root,
        'dist',
        'native',
        'better-sqlite3',
      )} but the path is missing (manifest platform=${CURRENT_PLATFORM}, generatedAt=${FIXTURE_GENERATED_AT}). The bundle was assembled inconsistently. Fix: rebuild the bundle; manifest entries must match the shipped files.`,
    );
  });

  it('(d) throws the ADR-086 §4.4 message when the manifest platform mismatches', () => {
    const root = makeTempRoot();
    writeManifestFixture(root, { platform: 'fakeos-fakearch' });

    const error = captureError(() => readNativeDepManifest(bundleEnv(root)));

    expect(error?.message).toBe(
      `[native-dep-manifest] manifest platform fakeos-fakearch does not match this process ${CURRENT_PLATFORM}; wrong overlay used at build time. Fix: rebuild with the matching arch/platform overlay.`,
    );
  });

  it('(e) stays in source mode when only AGENT_NEO_BUNDLED_RUNTIME_ROOT is set (harness shape)', () => {
    const root = makeTempRoot();
    writeManifestFixture(root);

    const manifest = readNativeDepManifest({ AGENT_NEO_BUNDLED_RUNTIME_ROOT: root });
    const blankResourceDir = readNativeDepManifest({
      AGENT_NEO_BUNDLED_RUNTIME_ROOT: root,
      AGENT_NEO_RESOURCE_DIR: '   ',
    });

    expect(manifest).toBeNull();
    expect(blankResourceDir).toBeNull();
  });

  it('(f) returns null when neither env var is set', () => {
    expect(readNativeDepManifest({})).toBeNull();
  });
});
