import { afterEach, describe, expect, it } from 'vitest';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const installScript = join(repoRoot, 'scripts/tauri-install.sh');
const APP_NAME = 'NTauriSignAnchor';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function run(
  command: string,
  args: string[],
  opts: { env?: NodeJS.ProcessEnv } = {},
): { status: number; stdout: string; stderr: string } {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    env: opts.env,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tauri-install-sign-anchor-'));
  tempDirs.push(dir);
  mkdirSync(join(dir, 'Applications'), { recursive: true });
  mkdirSync(join(dir, 'bundle/macos'), { recursive: true });
  return dir;
}

function writeFakeApp(appPath: string, markerName?: string): void {
  mkdirSync(join(appPath, 'Contents/MacOS'), { recursive: true });
  if (markerName) {
    mkdirSync(join(appPath, 'Contents/Resources'), { recursive: true });
    writeFileSync(join(appPath, 'Contents/Resources', markerName), markerName);
  }
  writeFileSync(
    join(appPath, 'Contents/Info.plist'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleExecutable</key><string>fixture</string>
  <key>CFBundleIdentifier</key><string>com.fixture.tauri-install-sign-anchor</string>
  <key>CFBundleName</key><string>${APP_NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
`,
  );
  const executable = join(appPath, 'Contents/MacOS/fixture');
  writeFileSync(executable, '#!/bin/bash\necho fixture\n');
  chmodSync(executable, 0o755);
}

function codesignDump(appPath: string): string {
  const result = run('codesign', ['-dvv', appPath]);
  return `${result.stdout}\n${result.stderr}`;
}

function signAdhoc(appPath: string): void {
  const result = run('codesign', ['--sign', '-', '--force', '--deep', appPath]);
  expect(result.status, result.stderr).toBe(0);
}

function signWithIdentity(appPath: string, identity: string): void {
  const result = run('codesign', [
    '--sign',
    identity,
    '--force',
    '--deep',
    '--options',
    'runtime',
    appPath,
  ]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function firstDeveloperIdIdentity(): string | undefined {
  const result = run('security', ['find-identity', '-v', '-p', 'codesigning']);
  return result.stdout.match(/"(Developer ID Application: [^"]+)"/)?.[1];
}

function hideDeveloperIdIdentities(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    join(binDir, 'security'),
    `#!/bin/bash
if [ "$1" = "find-identity" ]; then
  /usr/bin/security "$@" | grep -v "Developer ID Application:" || true
  exit 0
fi
exec /usr/bin/security "$@"
`,
  );
  chmodSync(join(binDir, 'security'), 0o755);
}

function installEnv(scratch: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.SIGNING_IDENTITY;
  return {
    ...env,
    APPLICATIONS_DIR: join(scratch, 'Applications'),
    BUNDLE_DIR: join(scratch, 'bundle'),
    APP_NAME,
    LEGACY_APP_NAME: `${APP_NAME}Legacy`,
    DMG_VOLUME_NAME: `${APP_NAME}Dmg`,
    WEB_PORT: '28180',
    ...extra,
  };
}

function runInstall(scratch: string, extra: Record<string, string> = {}) {
  return run('bash', [installScript], { env: installEnv(scratch, extra) });
}

describe('tauri-install sign-anchor contract', () => {
  it('anchors Developer ID preservation on the installed app before rm -rf', () => {
    const script = readFileSync(installScript, 'utf8');
    const preserveIndex = script.indexOf('preserve_installed_signing_chain "$INSTALLED_APP"');
    const deleteIndex = script.indexOf('rm -rf "$INSTALLED_APP"');
    const copyIndex = script.indexOf('cp -R "$SOURCE_APP" "$INSTALLED_APP"');
    const resignIndex = script.indexOf('resign_app_if_possible "$INSTALLED_APP"');

    expect(script).toContain('APPLICATIONS_DIR="${APPLICATIONS_DIR:-/Applications}"');
    expect(script).toContain('BUNDLE_DIR="${BUNDLE_DIR:-$PROJECT_ROOT/src-tauri/target/release/bundle}"');
    expect(preserveIndex).toBeGreaterThan(0);
    expect(deleteIndex).toBeGreaterThan(preserveIndex);
    expect(copyIndex).toBeGreaterThan(deleteIndex);
    expect(resignIndex).toBeGreaterThan(copyIndex);
    expect(script).not.toContain('skipping re-sign to preserve notarization');
    expect(script).toContain('Authority=Developer ID Application:');
    expect(script).toContain('SIGNING_IDENTITY_EXPLICIT');
    expect(run('bash', ['-n', installScript]).status).toBe(0);
  });
});

const developerIdIdentity =
  process.platform === 'darwin' ? firstDeveloperIdIdentity() : undefined;

describe.skipIf(process.platform !== 'darwin')('tauri-install sign-anchor fixtures', () => {
  it('re-signs as before when the installed app is missing', () => {
    const scratch = scratchDir();
    const source = join(scratch, 'bundle/macos', `${APP_NAME}.app`);
    const installed = join(scratch, 'Applications', `${APP_NAME}.app`);
    writeFakeApp(source, 'SOURCE_MARKER');
    signAdhoc(source);

    const result = runInstall(scratch);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(installed, 'Contents/Resources/SOURCE_MARKER'))).toBe(true);
    expect(result.stderr).not.toContain('会打断 Developer ID 签名链');
    expect(codesignDump(installed)).not.toMatch(/Authority=Developer ID Application:/);
  });

  it('re-signs as before when the installed app is adhoc/self-signed (reverse mutation)', () => {
    const scratch = scratchDir();
    const source = join(scratch, 'bundle/macos', `${APP_NAME}.app`);
    const installed = join(scratch, 'Applications', `${APP_NAME}.app`);
    writeFakeApp(source, 'SOURCE_MARKER');
    writeFakeApp(installed, 'OLD_MARKER');
    signAdhoc(source);
    signAdhoc(installed);

    const result = runInstall(scratch);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(existsSync(join(installed, 'Contents/Resources/SOURCE_MARKER'))).toBe(true);
    expect(existsSync(join(installed, 'Contents/Resources/OLD_MARKER'))).toBe(false);
    expect(result.stderr).not.toContain('会打断 Developer ID 签名链');
    expect(result.stdout).not.toContain('已装实例');
  });

  it.skipIf(!developerIdIdentity)('keeps a Developer ID signed new package untouched when the installed app is self-signed', () => {
    const identity = developerIdIdentity as string;

    const scratch = scratchDir();
    const source = join(scratch, 'bundle/macos', `${APP_NAME}.app`);
    const installed = join(scratch, 'Applications', `${APP_NAME}.app`);
    writeFakeApp(source, 'SOURCE_MARKER');
    writeFakeApp(installed, 'OLD_MARKER');
    signWithIdentity(source, identity);
    signAdhoc(installed);

    const result = runInstall(scratch);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('新包已带 Developer ID 签名');
    expect(existsSync(join(installed, 'Contents/Resources/SOURCE_MARKER'))).toBe(true);
    const dump = codesignDump(installed);
    expect(dump).toContain(`Authority=${identity}`);
  });

  it.skipIf(!developerIdIdentity)('keeps a Developer ID signed new package untouched when nothing is installed', () => {
    const identity = developerIdIdentity as string;

    const scratch = scratchDir();
    const source = join(scratch, 'bundle/macos', `${APP_NAME}.app`);
    const installed = join(scratch, 'Applications', `${APP_NAME}.app`);
    writeFakeApp(source, 'SOURCE_MARKER');
    signWithIdentity(source, identity);

    const result = runInstall(scratch);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    const dump = codesignDump(installed);
    expect(dump).toContain(`Authority=${identity}`);
  });

  it.skipIf(!developerIdIdentity)('succeeds without the identity when both packages are Developer ID signed', () => {
    const identity = developerIdIdentity as string;

    const scratch = scratchDir();
    const source = join(scratch, 'bundle/macos', `${APP_NAME}.app`);
    const installed = join(scratch, 'Applications', `${APP_NAME}.app`);
    writeFakeApp(source, 'SOURCE_MARKER');
    writeFakeApp(installed, 'OLD_MARKER');
    signWithIdentity(source, identity);
    signWithIdentity(installed, identity);

    const binDir = join(scratch, 'bin');
    hideDeveloperIdIdentities(binDir);
    const result = runInstall(scratch, { PATH: `${binDir}:${process.env.PATH ?? ''}` });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('新包已带 Developer ID 签名');
    expect(existsSync(join(installed, 'Contents/Resources/SOURCE_MARKER'))).toBe(true);
    expect(codesignDump(installed)).toContain(`Authority=${identity}`);
  });

  it.skipIf(!developerIdIdentity)('fail-loud before deleting a Developer ID install when that identity is missing', () => {
    const identity = developerIdIdentity as string;

    const scratch = scratchDir();
    const source = join(scratch, 'bundle/macos', `${APP_NAME}.app`);
    const installed = join(scratch, 'Applications', `${APP_NAME}.app`);
    writeFakeApp(source, 'SOURCE_MARKER');
    writeFakeApp(installed, 'OLD_MARKER');
    signAdhoc(source);
    signWithIdentity(installed, identity);
    expect(codesignDump(installed)).toContain('Authority=Developer ID Application:');

    const binDir = join(scratch, 'bin');
    hideDeveloperIdIdentities(binDir);
    const result = runInstall(scratch, { PATH: `${binDir}:${process.env.PATH ?? ''}` });

    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('会打断 Developer ID 签名链');
    expect(existsSync(join(installed, 'Contents/Resources/OLD_MARKER'))).toBe(true);
    expect(existsSync(join(installed, 'Contents/Resources/SOURCE_MARKER'))).toBe(false);
    expect(codesignDump(installed)).toContain(`Authority=${identity}`);
  });

  it.skipIf(!developerIdIdentity)('auto-switches to the matching Developer ID identity before overwrite', () => {
    const identity = developerIdIdentity as string;

    const scratch = scratchDir();
    const source = join(scratch, 'bundle/macos', `${APP_NAME}.app`);
    const installed = join(scratch, 'Applications', `${APP_NAME}.app`);
    writeFakeApp(source, 'SOURCE_MARKER');
    writeFakeApp(installed, 'OLD_MARKER');
    signAdhoc(source);
    signWithIdentity(installed, identity);

    const result = runInstall(scratch);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain(`将 SIGNING_IDENTITY 切到 '${identity}'`);
    expect(existsSync(join(installed, 'Contents/Resources/SOURCE_MARKER'))).toBe(true);
    expect(existsSync(join(installed, 'Contents/Resources/OLD_MARKER'))).toBe(false);
    const dump = codesignDump(installed);
    expect(dump).toContain(`Authority=${identity}`);
    expect(dump).toMatch(/TeamIdentifier=[A-Z0-9]+/);
    expect(dump).not.toMatch(/TeamIdentifier=not set/);
  });

  it.skipIf(!developerIdIdentity)('warns but does not block when SIGNING_IDENTITY is an explicit self-signed override', () => {
    const identity = developerIdIdentity as string;

    const scratch = scratchDir();
    const source = join(scratch, 'bundle/macos', `${APP_NAME}.app`);
    const installed = join(scratch, 'Applications', `${APP_NAME}.app`);
    writeFakeApp(source, 'SOURCE_MARKER');
    writeFakeApp(installed, 'OLD_MARKER');
    signAdhoc(source);
    signWithIdentity(installed, identity);

    const result = runInstall(scratch, { SIGNING_IDENTITY: 'Code Agent Dev' });
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toContain('SIGNING_IDENTITY 已显式设为');
    expect(existsSync(join(installed, 'Contents/Resources/SOURCE_MARKER'))).toBe(true);
    const dump = codesignDump(installed);
    expect(dump).not.toContain(`Authority=${identity}`);
    expect(dump).toMatch(/Authority=Code Agent Dev|Signature=adhoc/);
  });
});
