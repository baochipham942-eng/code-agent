import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));

function readRepoFile(path: string): string {
  return readFileSync(resolve(repoRoot, path), 'utf8');
}

function runReleaseBundle(env: NodeJS.ProcessEnv) {
  return spawnSync('bash', ['scripts/tauri-release-bundle.sh'], {
    cwd: repoRoot,
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      ...env,
    },
    encoding: 'utf8',
  });
}

describe('macOS release fail-closed gates', () => {
  it('requires updater signing material before building updater artifacts', () => {
    const result = runReleaseBundle({});

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('TAURI_UPDATER_PUBKEY or TAURI_UPDATER_PUBKEY_PATH is required');
  });

  it('requires an explicit Developer ID Application identity when notarization is required', () => {
    const result = runReleaseBundle({
      REQUIRE_NOTARIZATION: '1',
      TAURI_UPDATER_PUBKEY: 'updater-public-key',
      TAURI_SIGNING_PRIVATE_KEY: 'updater-private-key',
      CODE_AGENT_CONTROL_PLANE_KEY_ID: 'release-key',
      CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY: 'release-public-key',
      APPLE_ID: 'release@example.com',
      APPLE_PASSWORD: 'app-specific-password',
      APPLE_TEAM_ID: 'TEAM123456',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'APPLE_SIGNING_IDENTITY or TAURI_MACOS_SIGNING_IDENTITY is required',
    );
  });

  it('rejects non-Developer ID identities for release signing', () => {
    const result = runReleaseBundle({
      REQUIRE_NOTARIZATION: '1',
      TAURI_UPDATER_PUBKEY: 'updater-public-key',
      TAURI_SIGNING_PRIVATE_KEY: 'updater-private-key',
      CODE_AGENT_CONTROL_PLANE_KEY_ID: 'release-key',
      CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY: 'release-public-key',
      APPLE_ID: 'release@example.com',
      APPLE_PASSWORD: 'app-specific-password',
      APPLE_TEAM_ID: 'TEAM123456',
      APPLE_SIGNING_IDENTITY: 'Apple Development: Agent Neo',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('must be a Developer ID Application identity');
  });

  it('requires Apple notarization credentials when notarization is enabled', () => {
    const result = runReleaseBundle({
      REQUIRE_NOTARIZATION: '1',
      TAURI_UPDATER_PUBKEY: 'updater-public-key',
      TAURI_SIGNING_PRIVATE_KEY: 'updater-private-key',
      CODE_AGENT_CONTROL_PLANE_KEY_ID: 'release-key',
      CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY: 'release-public-key',
      APPLE_SIGNING_IDENTITY: 'Developer ID Application: Agent Neo (TEAM123456)',
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Apple notarization credentials are incomplete');
  });

  it('keeps notarization, Gatekeeper, TeamIdentifier, and control-plane checks in verify script', () => {
    const verifyScript = readRepoFile('scripts/verify-macos-release.sh');

    expect(verifyScript).toContain('codesign --verify --deep --strict');
    expect(verifyScript).toContain('Authority=Developer ID Application:');
    expect(verifyScript).toContain('TeamIdentifier=[A-Za-z0-9]');
    expect(verifyScript).toContain('xcrun stapler validate "${APP_PATH}"');
    expect(verifyScript).toContain('xcrun stapler validate "${dmg_path}"');
    expect(verifyScript).toContain('spctl --assess --type execute');
    expect(verifyScript).toContain('spctl --assess --type open');
    expect(verifyScript).toContain('control-plane public keys file has no keys');
  });

  it('keeps release workflow publishing updater archives and signatures', () => {
    const workflow = readRepoFile('.github/workflows/release.yml');

    expect(workflow).toContain('REQUIRE_NOTARIZATION:');
    expect(workflow).toContain('APPLE_CERTIFICATE_P12_BASE64');
    expect(workflow).toContain('APPLE_SIGNING_IDENTITY');
    expect(workflow).toContain('TAURI_UPDATER_PUBKEY');
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY');
    expect(workflow).toContain('CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS');
    expect(workflow).toContain('src-tauri/target/release/bundle/macos/*.app.tar.gz');
    expect(workflow).toContain('src-tauri/target/release/bundle/macos/*.app.tar.gz.sig');
    expect(workflow).toContain('npm run release:runtime-assets');
    expect(workflow).toContain('runtime-assets-manifest-darwin-arm64.json');
    expect(workflow).toContain('src-tauri/target/release/runtime-assets/*.sha256');
    expect(workflow).toContain('src-tauri/target/release/runtime-assets/*.tar.gz');
  });

  it('keeps runtime asset archives free of unsupported link entries', () => {
    const builder = readRepoFile('scripts/build-runtime-assets.mjs');

    expect(builder).toContain('entry.isSymbolicLink()');
    expect(builder).toContain("relativePath === 'node_modules/.bin'");
    expect(builder).toContain("relativePath.endsWith('/node_modules/.bin')");
  });

  it('wires package release scripts through notarize and verify gates', () => {
    const packageJson = JSON.parse(readRepoFile('package.json')) as {
      scripts: Record<string, string>;
    };

    expect(packageJson.scripts['tauri:release:bundle']).toContain('bash scripts/tauri-release-bundle.sh');
    expect(packageJson.scripts['tauri:release:bundle']).toContain('npm run release:notarize-macos');
    expect(packageJson.scripts['tauri:release:bundle']).toContain('npm run release:verify-macos');
    expect(packageJson.scripts['release:notarize-macos']).toBe('bash scripts/tauri-notarize.sh');
    expect(packageJson.scripts['release:verify-macos']).toBe('bash scripts/verify-macos-release.sh');
  });

  it('keeps managed runtime pilot modules out of default Tauri resources', () => {
    const tauriConfig = JSON.parse(readRepoFile('src-tauri/tauri.conf.json')) as {
      bundle?: { resources?: string[] };
    };
    const resources = tauriConfig.bundle?.resources ?? [];

    expect(resources.some((resource) => resource.includes('node_modules/onnxruntime-node'))).toBe(false);
    expect(resources.some((resource) => resource.includes('node_modules/avr-vad'))).toBe(false);
    expect(resources.some((resource) => resource.includes('node_modules/playwright'))).toBe(false);
    expect(resources.some((resource) => resource.includes('node_modules/playwright-core'))).toBe(false);
    expect(resources.some((resource) => resource.includes('node_modules/sharp'))).toBe(false);
    expect(resources.some((resource) => resource.includes('node_modules/@img/colour'))).toBe(false);
    expect(resources.some((resource) => resource.includes('node_modules/@img/sharp-darwin-arm64'))).toBe(false);
    expect(resources.some((resource) => resource.includes('node_modules/@img/sharp-libvips-darwin-arm64'))).toBe(false);
    expect(resources.some((resource) => resource.includes('node_modules/detect-libc'))).toBe(false);
  });

  it('keeps better-sqlite3 source and build inputs out of default Tauri resources', () => {
    const tauriConfig = JSON.parse(readRepoFile('src-tauri/tauri.conf.json')) as {
      bundle?: { resources?: string[] };
    };
    const resources = tauriConfig.bundle?.resources ?? [];

    expect(resources).toContain('../node_modules/better-sqlite3/package.json');
    expect(resources).toContain('../node_modules/better-sqlite3/lib/**/*');
    expect(resources).toContain('../node_modules/better-sqlite3/build/Release/better_sqlite3.node');
    expect(resources.some((resource) => resource.includes('node_modules/better-sqlite3/deps'))).toBe(false);
    expect(resources.some((resource) => resource.includes('node_modules/better-sqlite3/src'))).toBe(false);
    expect(resources.some((resource) => resource === '../node_modules/better-sqlite3/**/*')).toBe(false);
  });
});
