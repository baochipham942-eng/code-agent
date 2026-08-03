import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tempDirs: string[] = [];

afterEach(() => {
  vi.doUnmock('fs');
  vi.resetModules();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function readInstallScript(): string {
  return readFileSync(resolve(repoRoot, 'scripts/tauri-install-dev.sh'), 'utf8');
}

function functionBody(script: string, name: string): string {
  const start = script.indexOf(`${name}() {`);
  const nextFunction = script.indexOf('\n}\n\n', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(nextFunction).toBeGreaterThan(start);
  return script.slice(start, nextFunction + 3);
}

describe('dev build-info install gate', () => {
  it('writes build-info after copying the app and before resigning it', () => {
    const script = readInstallScript();
    const copyIndex = script.indexOf('cp -R "$SOURCE_APP" "/Applications/$APP_NAME.app"');
    const writeIndex = script.indexOf('write_build_info', copyIndex);
    const resignIndex = script.indexOf('resign_app_if_possible "/Applications/$APP_NAME.app"', copyIndex);

    expect(copyIndex).toBeGreaterThanOrEqual(0);
    expect(writeIndex).toBeGreaterThan(copyIndex);
    expect(resignIndex).toBeGreaterThan(writeIndex);
    expect(script).toContain('Contents/Resources/build-info.json');
    expect(functionBody(script, 'write_build_info')).toContain(
      'status --porcelain --untracked-files=normal',
    );
    expect(functionBody(script, 'write_build_info')).toContain(
      'installedFrom: nullable(process.env.BUILD_INSTALLED_FROM)',
    );
  });

  it('compares the existing and incoming builds before a cross-session overwrite', () => {
    const script = readInstallScript();
    const warningCallIndex = script.indexOf('\nwarn_about_existing_install\n');
    const deleteIndex = script.indexOf('rm -rf "/Applications/$APP_NAME.app"');
    const warningBody = functionBody(script, 'warn_about_existing_install');

    expect(warningCallIndex).toBeGreaterThanOrEqual(0);
    expect(deleteIndex).toBeGreaterThan(warningCallIndex);
    expect(warningBody).toContain('info.installedFrom ?? info.worktree');
    expect(warningBody).toContain('INCOMING_BRANCH');
    expect(warningBody).toContain('INCOMING_COMMIT_SHORT');
    expect(warningBody).toContain('跨会话覆盖');
    expect(warningBody).toContain('槽位原有');
    expect(warningBody).toContain('本次安装');
    expect(warningBody).toContain('info.branch');
    expect(warningBody).toContain('info.commitShort');
    expect(warningBody).toContain('info.builtAt');
    expect(warningBody).toContain('无 build-info 的旧包');
    expect(warningBody).not.toMatch(/\bexit\b/);
  });

  it('reads a real build-info file and returns null for malformed JSON', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'agent-neo-build-info-'));
    const tempBuildInfo = join(tempDir, 'build-info.json');
    tempDirs.push(tempDir);

    const expected = {
      appName: 'Agent Neo Dev',
      branch: 'feat/dev-build-info',
      commit: '1234567890123456789012345678901234567890',
      commitShort: '1234567',
      dirty: true,
      worktree: '/tmp/worktree with spaces',
      installedFrom: '/tmp/worktree with spaces',
      builtAt: '2026-07-27T12:34:56.000Z',
    };
    writeFileSync(tempBuildInfo, JSON.stringify(expected));

    vi.doMock('fs', async () => {
      const actual = await vi.importActual<typeof import('fs')>('fs');
      return {
        ...actual,
        readFileSync: (path: Parameters<typeof actual.readFileSync>[0], options?: unknown) => (
          String(path).endsWith('/build-info.json')
            ? actual.readFileSync(tempBuildInfo, options as never)
            : actual.readFileSync(path, options as never)
        ),
      };
    });

    const validModule = await import('../../src/host/platform/appPaths');
    expect(validModule.getBuildInfo()).toEqual(expected);
    expect(validModule.getBuildInfo()).toBe(validModule.getBuildInfo());

    const { installedFrom: _installedFrom, ...legacyBuildInfo } = expected;
    writeFileSync(tempBuildInfo, JSON.stringify(legacyBuildInfo));
    vi.resetModules();
    const legacyModule = await import('../../src/host/platform/appPaths');
    expect(legacyModule.getBuildInfo()).toEqual(expected);

    writeFileSync(tempBuildInfo, '{bad json');
    vi.resetModules();
    const malformedModule = await import('../../src/host/platform/appPaths');
    expect(malformedModule.getBuildInfo()).toBeNull();
  });
});
