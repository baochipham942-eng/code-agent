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

function loggedText(logger: FakeLogger): string {
  const calls = [
    ...logger.info.mock.calls,
    ...logger.warn.mock.calls,
    ...logger.debug.mock.calls,
    ...logger.error.mock.calls,
  ];
  return calls
    .map((args) => args.map((arg) => (typeof arg === 'string' ? arg : JSON.stringify(arg))).join(' '))
    .join('\n');
}

/** 让包回退 require('better-sqlite3') 失败,其余 require 照常。 */
function failPackageFallback(): void {
  originalLoad = moduleInternals._load;
  moduleInternals._load = (request, parent, isMain) => {
    if (request === 'better-sqlite3') {
      throw new Error("Cannot find module 'better-sqlite3'");
    }
    return originalLoad!(request, parent, isMain);
  };
}

describe('loadBetterSqlite3 logging', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-loader-logging-'));
    vi.stubEnv('CODE_AGENT_CLI_MODE', '');
    vi.stubEnv('CODE_AGENT_WEB_MODE', '');
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

  it('skips absent candidates without warning when the package fallback loads', () => {
    const logger = createFakeLogger();
    const moduleDir = path.join(root, 'host', 'services', 'core', 'database');
    const cwd = path.join(root, 'cwd');
    fs.mkdirSync(cwd, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);

    const Database = loadBetterSqlite3(moduleDir, logger as unknown as LoaderLogger);

    expect(Database).toBeTruthy();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(loggedText(logger)).not.toContain('Cannot find module');
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('candidate not present'));
  });

  it('warns with the real error when a present candidate fails to load', () => {
    const logger = createFakeLogger();
    const moduleDir = path.join(root, 'a', 'b');
    const brokenCandidate = path.join(root, 'a', 'native', 'better-sqlite3');
    const cwd = path.join(root, 'cwd');
    fs.mkdirSync(brokenCandidate, { recursive: true });
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(
      path.join(brokenCandidate, 'index.js'),
      "throw new Error('NODE_MODULE_VERSION 137 mismatch: native binding compiled for a different Node.js');\n",
      'utf8',
    );
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);

    const Database = loadBetterSqlite3(moduleDir, logger as unknown as LoaderLogger);

    expect(Database).toBeTruthy();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, payload] = logger.warn.mock.calls[0] as [
      string,
      { failedCandidates: Array<{ path: string; error: string }> },
    ];
    expect(message).toContain('Loaded better-sqlite3 from package fallback');
    expect(payload.failedCandidates).toHaveLength(1);
    expect(payload.failedCandidates[0].path).toBe(brokenCandidate);
    expect(payload.failedCandidates[0].error).toContain('NODE_MODULE_VERSION 137');
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('candidate unavailable'),
      expect.objectContaining({ error: expect.stringContaining('NODE_MODULE_VERSION 137') }),
    );
  });

  it('reports broken and missing candidates when every attempt fails', () => {
    failPackageFallback();
    const logger = createFakeLogger();
    const moduleDir = path.join(root, 'a', 'b');
    const cwd = path.join(root, 'cwd');
    fs.mkdirSync(cwd, { recursive: true });
    vi.spyOn(process, 'cwd').mockReturnValue(cwd);

    const Database = loadBetterSqlite3(moduleDir, logger as unknown as LoaderLogger);

    expect(Database).toBeNull();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message, payload] = logger.warn.mock.calls[0] as [
      string,
      { failedCandidates: unknown[]; missingCandidates: string[]; fallbackError: string },
    ];
    expect(message).toContain('better-sqlite3 unavailable after all load attempts');
    expect(payload.failedCandidates).toEqual([]);
    expect(payload.missingCandidates).toEqual([
      path.join(root, 'a', 'native', 'better-sqlite3'),
      path.join(root, 'native', 'better-sqlite3'),
      path.join(cwd, 'dist', 'native', 'better-sqlite3'),
    ]);
    expect(payload.fallbackError).toContain("Cannot find module 'better-sqlite3'");
  });
});
