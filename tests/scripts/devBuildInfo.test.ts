import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
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
  it('finalizes the dev bundle from the shared Tauri resource declarations', () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const finalizer = readFileSync(
      resolve(repoRoot, 'scripts/tauri-finalize-dev-bundle.mjs'),
      'utf8',
    );

    expect(packageJson.scripts?.['tauri:package:dev']).toContain(
      'node scripts/tauri-finalize-dev-bundle.mjs',
    );
    expect(finalizer).toContain("'src-tauri/tauri.conf.json'");
    // 槽位配置是本次构建的真源；回退到模板 tauri.dev.conf.json 会让槽 2 的构建
    // 去 finalize 槽 1 的 .app（productName 不同），静默同步到错误的包上。
    expect(finalizer).toContain("'src-tauri/tauri.dev.slot.conf.json'");
    expect(finalizer).not.toContain("'src-tauri/tauri.dev.conf.json'");
    expect(finalizer).toContain('codesign');
  });

  it('runs the shared resource inventory and packaged health smoke after install', () => {
    const script = readInstallScript();
    const verifier = readFileSync(resolve(repoRoot, 'scripts/verify-tauri-dev-app.sh'), 'utf8');
    const copyIndex = script.indexOf('cp -R "$SOURCE_APP" "/Applications/$APP_NAME.app"');
    const resignIndex = script.indexOf('resign_app_if_possible "/Applications/$APP_NAME.app"', copyIndex);
    const verifyIndex = script.indexOf('bash "$PROJECT_ROOT/scripts/verify-tauri-dev-app.sh"', copyIndex);
    const cleanupIndex = script.indexOf('rm -rf "$SOURCE_APP" "$SOURCE_APP.tar.gz"', copyIndex);

    expect(verifyIndex).toBeGreaterThan(resignIndex);
    expect(cleanupIndex).toBeGreaterThan(verifyIndex);
    expect(verifier).toContain('tauri-resource-inventory.mjs');
    expect(verifier).toContain('desktop-shell-packaged-smoke.mjs');
    // 冒烟端口跟随本槽：写死 8181 时装槽 2 会去探槽 1 的端口，撞上别人正在跑的包。
    expect(verifier).toContain('--port "${DEV_APP_WEB_PORT:-8181}"');
    expect(verifier).toContain('--app-port "${DEV_APP_WEB_PORT:-8181}"');
    expect(verifier).toContain('--health-only');
    expect(script).toContain('export DEV_APP_WEB_PORT');
  });

  it('fails the shared inventory when a required startup resource is missing', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'agent-neo-dev-resources-'));
    tempDirs.push(tempDir);
    const renderer = join(tempDir, 'dist/renderer/index.html');
    const native = join(
      tempDir,
      `dist/native/better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`,
    );
    mkdirSync(resolve(renderer, '..'), { recursive: true });
    mkdirSync(resolve(native, '..'), { recursive: true });
    writeFileSync(renderer, '<!doctype html>');
    writeFileSync(native, 'fixture');

    const command = ['scripts/tauri-resource-inventory.mjs', '--root', tempDir];
    const green = spawnSync('node', command, { cwd: repoRoot, encoding: 'utf8' });
    expect(green.status).toBe(0);

    rmSync(renderer);
    const red = spawnSync('node', command, { cwd: repoRoot, encoding: 'utf8' });
    expect(red.status).not.toBe(0);
    expect(red.stderr).toContain('dist/renderer/index.html');
  });

  it('clears only this slot renderer hot-update cache after install', () => {
    const script = readInstallScript();

    // 槽名从 .dev-slot.json 读，不在 shell 里另算一遍
    expect(script).toContain('read_slot_field dataDirName');
    // 只删 renderer-cache/active，不删整个 renderer-cache/
    expect(script).toContain('rm -rf "$HOME/$DEV_DATA_DIR_NAME/renderer-cache/active"');
    expect(script).not.toMatch(/rm -rf "\$HOME\/\$DEV_DATA_DIR_NAME\/renderer-cache"/);
    // 结尾提示语用真实槽位数据目录，不写死 ~/.code-agent-dev（槽 2 是 ~/.code-agent-dev2）
    // 花括号是必须的：裸 $VAR 紧跟全角字符时 bash 3.2 会把「）」吃进变量名，
    // shell-fail-loud-lint 会因此报红（本批 CI 实测踩到）。
    expect(script).toContain('数据目录 ~/${DEV_DATA_DIR_NAME}');
    expect(script).not.toContain('数据目录 ~/.code-agent-dev）：open');
  });

  it('has no DMG detach leftovers (bundle.targets is app-only)', () => {
    const script = readInstallScript();

    // bundle.targets 已是 ["app"]，不产 DMG；且 "$APP_NAME"* 前缀 glob 会让槽 1 命中槽 2 的卷
    expect(script).not.toContain('hdiutil detach');
    expect(script).not.toContain('/Volumes/');
  });

  it('disables LTO for dev packages by default with a NEO_DEV_FULL_LTO escape hatch', () => {
    const packageJson = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const devScript = packageJson.scripts?.['tauri:package:dev'];

    // 默认关 LTO；NEO_DEV_FULL_LTO=1 时不带这两个变量，让 Cargo.toml 的发版配置生效
    expect(devScript).toContain('NEO_DEV_FULL_LTO');
    expect(devScript).toContain('CARGO_PROFILE_RELEASE_LTO=false');
    expect(devScript).toContain('CARGO_PROFILE_RELEASE_CODEGEN_UNITS=16');
    // 发版链路一律不带 LTO 覆盖
    expect(packageJson.scripts?.['tauri:package']).not.toContain('CARGO_PROFILE_RELEASE');
    expect(packageJson.scripts?.['tauri:release:bundle']).not.toContain('CARGO_PROFILE_RELEASE');
  });

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
