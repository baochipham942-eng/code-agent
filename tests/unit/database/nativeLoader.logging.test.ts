import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import Module from 'module';
import * as os from 'os';
import * as path from 'path';

import { loadBetterSqlite3 } from '../../../src/host/services/core/database/nativeLoader';

type LoaderLogger = Parameters<typeof loadBetterSqlite3>[1];

interface FakeLogger {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
}

type ModuleInternals = {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};

const moduleInternals = Module as unknown as ModuleInternals;
let originalLoad: ModuleInternals['_load'] | null = null;

function createFakeLogger(): FakeLogger {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  };
}

/** 记录加载期全部 require 请求(含 nativeLoader 经 createRequire 发出的),不改行为。 */
function recordModuleLoads(): string[] {
  const requests: string[] = [];
  originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    requests.push(request);
    return originalLoad!(request, parent, isMain);
  };
  return requests;
}

function writeBundleFixture(root: string): string {
  const entryDir = path.join(root, 'dist', 'native', 'better-sqlite3');
  fs.mkdirSync(entryDir, { recursive: true });
  fs.writeFileSync(
    path.join(entryDir, 'index.js'),
    'module.exports = class FixtureBetterSqlite3 {};\n',
    'utf8',
  );
  const manifest = {
    schemaVersion: 1,
    kind: 'agent_neo_native_dep_manifest',
    generatedAt: '2026-10-28T00:00:00.000Z',
    generator: 'scripts/gen-native-dep-manifest.mjs',
    appVersion: '0.0.0-test',
    platform: `${process.platform}-${process.arch}`,
    modules: {
      'better-sqlite3': {
        kind: 'node-module',
        entry: 'dist/native/better-sqlite3',
        native: 'dist/native/better-sqlite3/prebuilds/darwin-arm64.node',
        packageVersion: '13.0.3',
      },
    },
  };
  const manifestPath = path.join(root, 'dist', 'native', 'manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  return manifestPath;
}

describe('loadBetterSqlite3 logging', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-loader-logging-'));
    vi.stubEnv('CODE_AGENT_CLI_MODE', '');
    vi.stubEnv('CODE_AGENT_WEB_MODE', '');
    vi.stubEnv('AGENT_NEO_BUNDLED_RUNTIME_ROOT', '');
    vi.stubEnv('AGENT_NEO_RESOURCE_DIR', '');
  });

  afterEach(() => {
    if (originalLoad) {
      moduleInternals._load = originalLoad;
      originalLoad = null;
    }
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('source mode: single package require, no candidate probes, debug-only logging', () => {
    const requests = recordModuleLoads();
    const logger = createFakeLogger();

    const Database = loadBetterSqlite3(path.join(root, 'a', 'b'), logger as unknown as LoaderLogger);

    expect(Database).toBeTruthy();
    expect(requests.filter((request) => request === 'better-sqlite3')).toHaveLength(1);
    expect(requests.some((request) => request.includes('dist/native'))).toBe(false);
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('Loaded better-sqlite3 from package resolution (source mode)'),
    );
  });

  it('source mode: warn and return null when the package require fails', () => {
    const requests = recordModuleLoads();
    const recordedLoad = moduleInternals._load;
    moduleInternals._load = (request, parent, isMain) => {
      if (request === 'better-sqlite3') {
        requests.push(request);
        throw new Error("Cannot find module 'better-sqlite3'");
      }
      return recordedLoad(request, parent, isMain);
    };
    const logger = createFakeLogger();

    const Database = loadBetterSqlite3(path.join(root, 'a', 'b'), logger as unknown as LoaderLogger);

    expect(Database).toBeNull();
    expect(requests.filter((request) => request === 'better-sqlite3')).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toBe('[DatabaseService] better-sqlite3 unavailable in source mode');
  });

  it('bundle mode: loads the declared entry once and logs the manifest path at info', () => {
    const manifestPath = writeBundleFixture(root);
    vi.stubEnv('AGENT_NEO_BUNDLED_RUNTIME_ROOT', root);
    vi.stubEnv('AGENT_NEO_RESOURCE_DIR', path.join(root, 'Resources'));
    const requests = recordModuleLoads();
    const logger = createFakeLogger();

    const Database = loadBetterSqlite3(path.join(root, 'a', 'b'), logger as unknown as LoaderLogger);

    const entryPath = path.join(root, 'dist', 'native', 'better-sqlite3');
    expect(Database).toBeTruthy();
    expect(requests.filter((request) => request === entryPath)).toHaveLength(1);
    expect(requests.some((request) => request === 'better-sqlite3')).toBe(false);
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toBe(
      `[DatabaseService] Loaded better-sqlite3 from ${entryPath} via native dep manifest ${manifestPath}`,
    );
  });

  it('bundle mode: throws instead of warn+null when the manifest is missing', () => {
    vi.stubEnv('AGENT_NEO_BUNDLED_RUNTIME_ROOT', root);
    vi.stubEnv('AGENT_NEO_RESOURCE_DIR', path.join(root, 'Resources'));
    const logger = createFakeLogger();

    expect(() => loadBetterSqlite3(path.join(root, 'a', 'b'), logger as unknown as LoaderLogger)).toThrow(
      `[native-dep-manifest] bundle mode but manifest is missing: expected ${path.join(
        root,
        'dist',
        'native',
        'manifest.json',
      )}`,
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('CLI mode: returns null before any load attempt', () => {
    const requests = recordModuleLoads();
    vi.stubEnv('CODE_AGENT_CLI_MODE', 'true');
    const logger = createFakeLogger();

    const Database = loadBetterSqlite3(path.join(root, 'a', 'b'), logger as unknown as LoaderLogger);

    expect(Database).toBeNull();
    expect(requests.filter((request) => request === 'better-sqlite3')).toHaveLength(0);
  });
});
