import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { ControlPlaneEnvelope } from '../../../src/shared/contract/controlPlane';
import {
  RENDERER_BUNDLE_CHANNEL_ENV,
  RENDERER_BUNDLE_COHORT_ENV,
  RENDERER_BUNDLE_ROLLOUT_POLICY_URL_ENV,
} from '../../../src/shared/constants/network';
import {
  buildControlPlaneContentHash,
  buildControlPlaneSigningPayload,
  CONTROL_PLANE_PUBLIC_KEYS_REMEDIATION_HINT,
} from '../../../src/main/services/cloud/controlPlaneTrust';
import { applyRendererBundleUpdate } from '../../../src/main/services/renderer/rendererBundleFetcher';
import {
  activeBundleDir,
  readActiveBundleMeta,
  readRendererBundleStatus,
} from '../../../src/main/services/renderer/rendererBundleCache';

let dataDir: string;
let workDir: string;
let archivePath: string;
let archiveSha256: string;

/** 造一个真实 bundle.tar.gz（含 index.html + assets/app.js），返回路径 + sha256。 */
function buildBundleFixture(indexBody: string): { archivePath: string; sha256: string } {
  const src = fs.mkdtempSync(path.join(workDir, 'bundle-src-'));
  fs.mkdirSync(path.join(src, 'assets'));
  fs.writeFileSync(
    path.join(src, 'index.html'),
    `<!doctype html><html><head></head><body>${indexBody}</body></html>`,
    'utf-8',
  );
  fs.writeFileSync(path.join(src, 'assets', 'app.js'), 'console.log("cloud")', 'utf-8');
  const out = path.join(workDir, `bundle-${crypto.randomUUID()}.tar.gz`);
  // -C src . 把内容放在 tar 根（解压后直接是 index.html / assets/）
  execFileSync('tar', ['-czf', out, '-C', src, '.']);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
  return { archivePath: out, sha256 };
}

/** 签一个 renderer_bundle envelope，payload 为 RendererBundleManifest。 */
function buildSignedManifest(
  payload: Record<string, unknown>,
  opts: { expiresAt?: string; kind?: string; keyId?: string } = {},
) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const envelope: ControlPlaneEnvelope<Record<string, unknown>> = {
    schemaVersion: 1,
    kind: (opts.kind ?? 'renderer_bundle') as ControlPlaneEnvelope['kind'],
    issuedAt: '2026-06-01T00:00:00.000Z',
    expiresAt: opts.expiresAt ?? '2099-12-31T23:59:59.000Z',
    contentHash: buildControlPlaneContentHash(payload),
    keyId: opts.keyId ?? 'rb-key',
    payload,
  };
  envelope.signature = crypto
    .sign(null, Buffer.from(buildControlPlaneSigningPayload(envelope)), privateKey)
    .toString('base64');
  return {
    envelope,
    publicKeys: { [envelope.keyId]: publicKey.export({ type: 'spki', format: 'pem' }).toString() },
  };
}

function seedExistingActive(version: string, contentHash: string, body: string): void {
  const active = activeBundleDir(dataDir);
  fs.mkdirSync(active, { recursive: true });
  fs.writeFileSync(
    path.join(active, 'index.html'),
    `<!doctype html><html><head></head><body>${body}</body></html>`,
    'utf-8',
  );
  fs.writeFileSync(path.join(active, '.bundle-meta.json'), JSON.stringify({ version, contentHash }), 'utf-8');
}

beforeEach(() => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-data-'));
  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-work-'));
  const fx = buildBundleFixture('CLOUD-V2');
  archivePath = fx.archivePath;
  archiveSha256 = fx.sha256;
});

afterEach(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe('applyRendererBundleUpdate', () => {
  it('skips before fetching when renderer hot update is disabled', async () => {
    seedExistingActive('0.16.0', 'oldhash', 'OLD-ACTIVE');
    let fetched = false;

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys: {},
      disabledReason: 'CODE_AGENT_DISABLE_RENDERER_HOT_UPDATE',
      fetchJson: async () => {
        fetched = true;
        throw new Error('should not fetch');
      },
      downloadToFile: async () => {
        throw new Error('should not download');
      },
    });

    expect(result).toEqual({ applied: false, reason: 'disabled' });
    expect(fetched).toBe(false);
    expect(fs.readFileSync(path.join(activeBundleDir(dataDir), 'index.html'), 'utf-8')).toContain('OLD-ACTIVE');
    expect(readRendererBundleStatus(dataDir)).toMatchObject({
      lastAttempt: {
        outcome: 'skipped',
        reason: 'disabled',
      },
    });
  });

  it('fetches a named renderer bundle channel when the channel env is set', async () => {
    const manifest = {
      version: '0.17.0-beta.1',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/renderer-bundle/channels/beta/bundle.tar.gz',
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);
    const fetchedUrls: string[] = [];

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      env: { [RENDERER_BUNDLE_CHANNEL_ENV]: 'beta' },
      publicKeys,
      fetchJson: async (url) => {
        fetchedUrls.push(url);
        return envelope;
      },
      downloadToFile: async (_url, dest) => { fs.copyFileSync(archivePath, dest); },
    });

    const expectedManifestUrl =
      'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/channels/beta/manifest.json';
    expect(result).toEqual({ applied: true, version: '0.17.0-beta.1', contentHash: archiveSha256 });
    expect(fetchedUrls).toEqual([expectedManifestUrl]);
    expect(readRendererBundleStatus(dataDir).lastAttempt?.manifestUrl).toBe(expectedManifestUrl);
  });

  it('uses a signed rollout policy to select the target renderer manifest', async () => {
    const policyUrl = 'https://agentneo.example/api/v1/control-plane?kind=renderer_bundle_rollout';
    const betaManifestUrl =
      'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/channels/beta/manifest.json';
    const policy = {
      version: 'policy-1',
      channel: 'beta',
      cohorts: ['staff'],
      platforms: [process.platform],
      rolloutPercent: 100,
    };
    const manifest = {
      version: '0.17.0-beta.1',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/renderer-bundle/channels/beta/bundle.tar.gz',
    };
    const { envelope: policyEnvelope, publicKeys: policyKeys } = buildSignedManifest(policy, {
      kind: 'renderer_bundle_rollout',
      keyId: 'rollout-key',
    });
    const { envelope: manifestEnvelope, publicKeys: manifestKeys } = buildSignedManifest(manifest, {
      keyId: 'manifest-key',
    });
    const fetchedUrls: string[] = [];
    const env = {
      [RENDERER_BUNDLE_ROLLOUT_POLICY_URL_ENV]: policyUrl,
      [RENDERER_BUNDLE_COHORT_ENV]: 'staff',
    };

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      env,
      publicKeys: { ...policyKeys, ...manifestKeys },
      rolloutSeed: 'device-1',
      fetchJson: async (url) => {
        fetchedUrls.push(url);
        if (url === policyUrl) return policyEnvelope;
        if (url === betaManifestUrl) return manifestEnvelope;
        throw new Error(`unexpected url: ${url}`);
      },
      downloadToFile: async (_url, dest) => { fs.copyFileSync(archivePath, dest); },
    });

    expect(result).toEqual({ applied: true, version: '0.17.0-beta.1', contentHash: archiveSha256 });
    expect(fetchedUrls).toEqual([policyUrl, betaManifestUrl]);
    expect(readRendererBundleStatus(dataDir, env)).toMatchObject({
      source: {
        channel: 'latest',
        rolloutPolicyUrl: policyUrl,
        rolloutPolicyUrlOverride: true,
        cohort: 'staff',
      },
      lastAttempt: {
        manifestUrl: betaManifestUrl,
        outcome: 'applied',
        rollout: {
          policyUrl,
          policyVersion: 'policy-1',
          decision: 'use-manifest',
          rolloutApplied: true,
          rolloutPercent: 100,
        },
      },
    });
  });

  it('skips before fetching a manifest when the signed rollout policy is paused', async () => {
    const policyUrl = 'https://agentneo.example/api/v1/control-plane?kind=renderer_bundle_rollout';
    const { envelope, publicKeys } = buildSignedManifest(
      { version: 'policy-1', paused: true, pauseReason: 'watching errors' },
      { kind: 'renderer_bundle_rollout', keyId: 'rollout-key' },
    );
    const fetchedUrls: string[] = [];

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      env: { [RENDERER_BUNDLE_ROLLOUT_POLICY_URL_ENV]: policyUrl },
      publicKeys,
      fetchJson: async (url) => {
        fetchedUrls.push(url);
        return envelope;
      },
      downloadToFile: async () => {
        throw new Error('should not download');
      },
    });

    expect(result).toEqual({ applied: false, reason: 'rollout-paused' });
    expect(fetchedUrls).toEqual([policyUrl]);
    expect(readRendererBundleStatus(dataDir)).toMatchObject({
      lastAttempt: {
        outcome: 'skipped',
        reason: 'rollout-paused',
        rollout: {
          policyUrl,
          policyVersion: 'policy-1',
          decision: 'skip',
          reason: 'rollout-paused',
        },
      },
    });
  });

  it('clears active overlay when the signed rollout policy commands rollback to builtin', async () => {
    seedExistingActive('0.17.0', 'bad-active-hash', 'BAD-ACTIVE');
    const policyUrl = 'https://agentneo.example/api/v1/control-plane?kind=renderer_bundle_rollout';
    const { envelope, publicKeys } = buildSignedManifest(
      { version: 'policy-1', rollbackToBuiltin: true, rollbackReason: 'bad overlay' },
      { kind: 'renderer_bundle_rollout', keyId: 'rollout-key' },
    );

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      env: { [RENDERER_BUNDLE_ROLLOUT_POLICY_URL_ENV]: policyUrl },
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async () => {
        throw new Error('should not download');
      },
    });

    expect(result).toEqual({ applied: false, reason: 'rollout-rollback-to-builtin' });
    expect(fs.existsSync(activeBundleDir(dataDir))).toBe(false);
    expect(readRendererBundleStatus(dataDir)).toMatchObject({
      activeBundle: null,
      lastAttempt: {
        outcome: 'rolled-back',
        reason: 'rollout-rollback-to-builtin',
        rollout: {
          policyUrl,
          policyVersion: 'policy-1',
          decision: 'rollback-to-builtin',
          rollbackReason: 'bad overlay',
        },
      },
    });
  });

  it('records an invalid renderer bundle channel before fetching', async () => {
    let fetched = false;

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      env: { [RENDERER_BUNDLE_CHANNEL_ENV]: '../beta' },
      publicKeys: {},
      fetchJson: async () => {
        fetched = true;
        throw new Error('should not fetch');
      },
      downloadToFile: async () => {
        throw new Error('should not download');
      },
    });

    expect(result).toEqual({ applied: false, reason: 'invalid-renderer-bundle-channel' });
    expect(fetched).toBe(false);
    expect(readRendererBundleStatus(dataDir)).toMatchObject({
      lastAttempt: {
        manifestUrl: `${RENDERER_BUNDLE_CHANNEL_ENV}=../beta`,
        outcome: 'failed',
        reason: 'invalid-renderer-bundle-channel',
      },
    });
  });

  it('applies a healthy, signed, integrity-checked bundle and swaps it into active/', async () => {
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredRuntimeAssets: ['playwright-browser-runtime'],
      requiredResources: ['resources/browser-relay-extension'],
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async (_url, dest) => { fs.copyFileSync(archivePath, dest); },
      resolveDependencyContext: async () => ({
        availableRuntimeAssets: ['playwright-browser-runtime'],
        availableResources: ['resources/browser-relay-extension'],
      }),
    });

    expect(result).toEqual({ applied: true, version: '0.17.0', contentHash: archiveSha256 });
    const active = activeBundleDir(dataDir);
    expect(fs.readFileSync(path.join(active, 'index.html'), 'utf-8')).toContain('CLOUD-V2');
    expect(fs.existsSync(path.join(active, 'assets', 'app.js'))).toBe(true);
    expect(readActiveBundleMeta(dataDir)).toEqual({ version: '0.17.0', contentHash: archiveSha256 });
    expect(readRendererBundleStatus(dataDir)).toMatchObject({
      activeBundle: { version: '0.17.0', contentHash: archiveSha256 },
      lastAttempt: {
        outcome: 'applied',
        manifest: {
          version: '0.17.0',
          contentHash: archiveSha256,
          requiredShellCapabilitiesCount: 0,
          requiredRuntimeAssetsCount: 1,
          requiredResourcesCount: 1,
        },
      },
    });
  });

  it('skips before downloading when declared runtime assets are missing locally', async () => {
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredRuntimeAssets: ['playwright-browser-runtime'],
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);
    let downloaded = false;

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async () => { downloaded = true; },
      resolveDependencyContext: async () => ({ availableRuntimeAssets: [] }),
    });

    expect(result).toEqual({ applied: false, reason: 'missing-runtime-asset' });
    expect(downloaded).toBe(false);
    expect(readRendererBundleStatus(dataDir)).toMatchObject({
      activeBundle: null,
      lastAttempt: {
        outcome: 'skipped',
        reason: 'missing-runtime-asset',
        missingRuntimeAssets: ['playwright-browser-runtime'],
        manifest: {
          version: '0.17.0',
          requiredRuntimeAssetsCount: 1,
        },
      },
    });
  });

  it('prepares missing runtime assets and retries the dependency gate before downloading', async () => {
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredRuntimeAssets: ['playwright-browser-runtime'],
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);
    let dependencyChecks = 0;
    const preparedAssets: string[][] = [];

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async (_url, dest) => { fs.copyFileSync(archivePath, dest); },
      resolveDependencyContext: async () => {
        dependencyChecks += 1;
        return {
          availableRuntimeAssets: dependencyChecks === 1 ? [] : ['playwright-browser-runtime'],
        };
      },
      prepareRuntimeAssets: async (missingAssets) => {
        preparedAssets.push([...missingAssets]);
        return {
          installed: [{
            assetId: 'playwright-browser-runtime',
            root: '/tmp/runtime/playwright-browser-runtime',
            reusedExistingInstall: false,
          }],
          skipped: [],
        };
      },
    });

    expect(result).toEqual({ applied: true, version: '0.17.0', contentHash: archiveSha256 });
    expect(preparedAssets).toEqual([['playwright-browser-runtime']]);
    expect(dependencyChecks).toBe(2);
    expect(readRendererBundleStatus(dataDir)).toMatchObject({
      activeBundle: { version: '0.17.0', contentHash: archiveSha256 },
      lastAttempt: {
        outcome: 'applied',
        runtimeAssetPreparation: {
          attempted: true,
          installed: [{ assetId: 'playwright-browser-runtime' }],
          skipped: [],
        },
      },
    });
  });

  it('keeps the current renderer when runtime asset preparation fails', async () => {
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredRuntimeAssets: ['playwright-browser-runtime'],
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);
    let downloaded = false;

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async () => { downloaded = true; },
      resolveDependencyContext: async () => ({ availableRuntimeAssets: [] }),
      prepareRuntimeAssets: async () => {
        throw new Error('runtime metadata unavailable');
      },
    });

    expect(result).toEqual({ applied: false, reason: 'missing-runtime-asset' });
    expect(downloaded).toBe(false);
    expect(readRendererBundleStatus(dataDir)).toMatchObject({
      activeBundle: null,
      lastAttempt: {
        outcome: 'skipped',
        reason: 'missing-runtime-asset',
        missingRuntimeAssets: ['playwright-browser-runtime'],
        runtimeAssetPreparation: {
          attempted: true,
          installed: [],
          skipped: [],
          errorMessage: 'runtime metadata unavailable',
        },
      },
    });
  });

  it('skips before downloading when declared resources are missing locally', async () => {
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
      requiredResources: ['resources/browser-relay-extension'],
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);
    let downloaded = false;

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async () => { downloaded = true; },
      resolveDependencyContext: async () => ({ availableResources: [] }),
    });

    expect(result).toEqual({ applied: false, reason: 'missing-resource' });
    expect(downloaded).toBe(false);
    expect(readRendererBundleStatus(dataDir)).toMatchObject({
      activeBundle: null,
      lastAttempt: {
        outcome: 'skipped',
        reason: 'missing-resource',
        missingResources: ['resources/browser-relay-extension'],
        manifest: {
          version: '0.17.0',
          requiredResourcesCount: 1,
        },
      },
    });
  });

  it('records renderer hot-update telemetry from the same status envelope used by diagnostics', async () => {
    const manifest = {
      version: '0.17.0-beta.1',
      contentHash: archiveSha256,
      minShellVersion: '0.16.93',
      bundleUrl: 'https://oss.example/renderer-bundle/channels/beta/bundle.tar.gz',
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);
    const telemetryStatuses: Array<ReturnType<typeof readRendererBundleStatus>> = [];

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.93',
      env: { [RENDERER_BUNDLE_CHANNEL_ENV]: 'beta' },
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async (_url, dest) => { fs.copyFileSync(archivePath, dest); },
      recordTelemetryAttempt: async (status) => { telemetryStatuses.push(status); },
    });

    expect(result).toEqual({ applied: true, version: '0.17.0-beta.1', contentHash: archiveSha256 });
    expect(telemetryStatuses).toHaveLength(1);
    expect(telemetryStatuses[0]).toMatchObject({
      source: { channel: 'beta' },
      activeBundle: { version: '0.17.0-beta.1', contentHash: archiveSha256 },
      lastAttempt: {
        outcome: 'applied',
        currentShellVersion: '0.16.93',
        manifest: {
          version: '0.17.0-beta.1',
          contentHash: archiveSha256,
        },
      },
    });
  });

  it('keeps renderer hot-update non-blocking when telemetry recording fails', async () => {
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);
    const logs: string[] = [];

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async (_url, dest) => { fs.copyFileSync(archivePath, dest); },
      logger: (message) => { logs.push(message); },
      recordTelemetryAttempt: async () => { throw new Error('telemetry unavailable'); },
    });

    expect(result).toEqual({ applied: true, version: '0.17.0', contentHash: archiveSha256 });
    expect(fs.readFileSync(path.join(activeBundleDir(dataDir), 'index.html'), 'utf-8')).toContain('CLOUD-V2');
    expect(logs.some((entry) => entry.includes('telemetry record failed'))).toBe(true);
  });

  it('rejects when shell is too old (contract gate), without downloading', async () => {
    const manifest = {
      version: '0.18.0',
      contentHash: archiveSha256,
      minShellVersion: '0.18.0',
      bundleUrl: 'https://oss.example/bundle.tar.gz',
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);
    let downloaded = false;

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async () => { downloaded = true; },
    });

    expect(result).toEqual({ applied: false, reason: 'shell-too-old' });
    expect(downloaded).toBe(false);
    expect(fs.existsSync(activeBundleDir(dataDir))).toBe(false);
  });

  it('rejects when the bundle requires a shell capability this app does not expose', async () => {
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      requiredShellCapabilities: ['domain:local/newAction'],
      bundleUrl: 'https://oss.example/bundle.tar.gz',
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);
    let downloaded = false;

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async () => { downloaded = true; },
    });

    expect(result).toEqual({ applied: false, reason: 'missing-shell-capability' });
    expect(downloaded).toBe(false);
    expect(fs.existsSync(activeBundleDir(dataDir))).toBe(false);
    expect(readRendererBundleStatus(dataDir)).toMatchObject({
      activeBundle: null,
      lastAttempt: {
        outcome: 'skipped',
        reason: 'missing-shell-capability',
        missingShellCapabilities: ['domain:local/newAction'],
      },
    });
  });

  it('records invalid signed manifests without poisoning the readable status envelope', async () => {
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      bundleUrl: 'https://oss.example/bundle.tar.gz',
      // minShellVersion 故意缺失：签名可信，但 payload 不满足 renderer manifest 契约。
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);
    let downloaded = false;

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async () => { downloaded = true; },
    });

    expect(result).toEqual({ applied: false, reason: 'invalid-manifest' });
    expect(downloaded).toBe(false);
    const status = readRendererBundleStatus(dataDir);
    expect(status.lastAttempt).toMatchObject({
      outcome: 'failed',
      reason: 'invalid-manifest',
    });
    expect(status.lastAttempt?.manifest).toBeUndefined();
  });

  it('skips when bundle is already the current active', async () => {
    seedExistingActive('0.17.0', archiveSha256, 'OLD-ACTIVE');
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/bundle.tar.gz',
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async () => { throw new Error('should not download'); },
    });

    expect(result).toEqual({ applied: false, reason: 'already-current' });
  });

  it('applies a signed rollback manifest by clearing active overlay without downloading', async () => {
    seedExistingActive('0.17.0', 'bad-active-hash', 'BAD-ACTIVE');
    const manifest = {
      version: '0.17.1',
      minShellVersion: '0.16.93',
      rollbackToBuiltin: true,
      rollbackReason: 'bad renderer overlay',
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);
    let downloaded = false;

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.93',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async () => { downloaded = true; },
    });

    expect(result).toEqual({ applied: false, reason: 'rollback-to-builtin' });
    expect(downloaded).toBe(false);
    expect(fs.existsSync(activeBundleDir(dataDir))).toBe(false);
    expect(readRendererBundleStatus(dataDir)).toMatchObject({
      activeBundle: null,
      lastAttempt: {
        outcome: 'rolled-back',
        reason: 'rollback-to-builtin',
        manifest: {
          version: '0.17.1',
          minShellVersion: '0.16.93',
          rollbackToBuiltin: true,
          rollbackReason: 'bad renderer overlay',
        },
      },
    });
  });

  it('rejects an untrusted envelope (wrong signing key) and leaves active untouched', async () => {
    seedExistingActive('0.16.0', 'oldhash', 'OLD-ACTIVE');
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/bundle.tar.gz',
    };
    const { envelope } = buildSignedManifest(manifest);
    // 用一把不匹配的公钥
    const { publicKey: otherPub } = crypto.generateKeyPairSync('ed25519');

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys: { 'rb-key': otherPub.export({ type: 'spki', format: 'pem' }).toString() },
      fetchJson: async () => envelope,
      downloadToFile: async (_url, dest) => { fs.copyFileSync(archivePath, dest); },
    });

    expect(result.applied).toBe(false);
    // 兜底：现有 active 不被破坏
    expect(fs.readFileSync(path.join(activeBundleDir(dataDir), 'index.html'), 'utf-8')).toContain('OLD-ACTIVE');
  });

  it('logs actionable diagnostics when the renderer bundle key id is unknown', async () => {
    seedExistingActive('0.16.0', 'oldhash', 'OLD-ACTIVE');
    const manifest = {
      version: '0.17.0',
      contentHash: archiveSha256,
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/bundle.tar.gz',
    };
    const { envelope } = buildSignedManifest(manifest);
    const logs: string[] = [];

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys: {},
      fetchJson: async () => envelope,
      downloadToFile: async (_url, dest) => { fs.copyFileSync(archivePath, dest); },
      logger: (message) => logs.push(message),
    });

    expect(result).toEqual({ applied: false, reason: 'envelope-untrusted' });
    expect(logs.find((message) => message.includes('envelope untrusted'))).toEqual(expect.stringContaining('keyId=rb-key'));
    expect(logs.find((message) => message.includes('envelope untrusted'))).toEqual(expect.stringContaining('knownKeyCount=0'));
    expect(logs.find((message) => message.includes('envelope untrusted'))).toEqual(expect.stringContaining(
      `remediationHint=${CONTROL_PLANE_PUBLIC_KEYS_REMEDIATION_HINT}`,
    ));
    expect(readRendererBundleStatus(dataDir)).toMatchObject({
      lastAttempt: {
        outcome: 'failed',
        reason: 'envelope-untrusted',
        diagnostics: ['unknown_key_id'],
      },
    });
    expect(fs.readFileSync(path.join(activeBundleDir(dataDir), 'index.html'), 'utf-8')).toContain('OLD-ACTIVE');
  });

  it('rejects on sha256 integrity mismatch and preserves existing active', async () => {
    seedExistingActive('0.16.0', 'oldhash', 'OLD-ACTIVE');
    const manifest = {
      version: '0.17.0',
      contentHash: 'f'.repeat(64), // 与真实 archive sha256 不符
      minShellVersion: '0.16.0',
      bundleUrl: 'https://oss.example/bundle.tar.gz',
    };
    const { envelope, publicKeys } = buildSignedManifest(manifest);

    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys,
      fetchJson: async () => envelope,
      downloadToFile: async (_url, dest) => { fs.copyFileSync(archivePath, dest); },
    });

    expect(result).toEqual({ applied: false, reason: 'integrity-mismatch' });
    expect(fs.readFileSync(path.join(activeBundleDir(dataDir), 'index.html'), 'utf-8')).toContain('OLD-ACTIVE');
    expect(readActiveBundleMeta(dataDir)).toEqual({ version: '0.16.0', contentHash: 'oldhash' });
  });

  it('returns a failure result (never throws) when manifest fetch fails', async () => {
    const result = await applyRendererBundleUpdate({
      dataDir,
      currentShellVersion: '0.16.90',
      publicKeys: {},
      fetchJson: async () => { throw new Error('network down'); },
      downloadToFile: async () => {},
    });

    expect(result.applied).toBe(false);
    expect(result).toHaveProperty('reason');
    expect(readRendererBundleStatus(dataDir)).toMatchObject({
      activeBundle: null,
      lastAttempt: {
        outcome: 'failed',
        reason: 'error',
        errorMessage: 'network down',
      },
    });
  });
});
