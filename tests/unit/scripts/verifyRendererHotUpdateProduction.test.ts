import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PRODUCTION_CLOUD_API_URL } from '../../../src/shared/constants/network';
import {
  deriveRendererBundleReleaseRecordUrl,
  inspectRendererHotUpdateRemoteArtifacts,
  parseRendererHotUpdateProductionArgs,
  RENDERER_HOT_UPDATE_CONTROL_PLANE_ARTIFACTS,
  RendererHotUpdateProductionVerificationError,
  verifyRendererHotUpdateProduction,
  verifyRendererHotUpdateProductionWithRetry,
} from '../../../scripts/verify-renderer-hot-update-production.mjs';
import { CONTROL_PLANE_ARTIFACTS } from '../../../scripts/control-plane-smoke.mjs';
import { DEFAULT_MIN_MANIFEST_VALIDITY_SECONDS } from '../../../scripts/verify-renderer-bundle-publish.mjs';

describe('verifyRendererHotUpdateProduction', () => {
  it('verifies production control-plane and latest renderer bundle by default', async () => {
    const controlPlaneCalls: unknown[] = [];
    const rendererCalls: unknown[] = [];

    const summary = await verifyRendererHotUpdateProduction({
      ...parseRendererHotUpdateProductionArgs([], {}),
      runControlPlaneSmokeImpl: async (options: unknown) => {
        controlPlaneCalls.push(options);
        return [{
          name: 'renderer bundle rollout policy',
          endpoint: `${PRODUCTION_CLOUD_API_URL}/api/v1/control-plane?artifact=renderer_bundle_rollout`,
          status: 200,
          kind: 'renderer_bundle_rollout',
          keyId: 'prod-key',
          contentHash: 'sha256:'.concat('a'.repeat(64)),
          expiresAt: '2099-12-31T23:59:59.000Z',
        }];
      },
      verifyRendererBundlePublishImpl: async (options: unknown) => {
        rendererCalls.push(options);
        return {
          manifestUrl: 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/latest/manifest.json',
          releaseRecordUrl: 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/latest/release-record.json',
          releaseRecordVerified: true,
          version: '0.16.93',
          bundleBytes: 1234,
        };
      },
    });

    expect(controlPlaneCalls).toEqual([{
      baseUrl: PRODUCTION_CLOUD_API_URL,
      token: undefined,
      artifacts: RENDERER_HOT_UPDATE_CONTROL_PLANE_ARTIFACTS,
      fetchImpl: expect.any(Function),
    }]);
    expect(rendererCalls).toEqual([{
      manifestUrl: 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/latest/manifest.json',
      releaseRecordUrl: 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/latest/release-record.json',
      fetchImpl: expect.any(Function),
      expectedVersion: undefined,
      minRequiredShellCapabilities: 1,
      minManifestValiditySeconds: DEFAULT_MIN_MANIFEST_VALIDITY_SECONDS,
      allowUnknownShellCapabilities: false,
      expectedReleaseChannel: 'latest',
      expectedCohort: undefined,
      expectedRolloutPercent: undefined,
    }]);
    expect(summary).toMatchObject({
      controlPlane: { skipped: false, checked: 1 },
      rendererBundle: {
        skipped: false,
        version: '0.16.93',
        releaseRecordVerified: true,
      },
    });
  });

  it('derives channel manifest and release-record URLs', () => {
    const args = parseRendererHotUpdateProductionArgs([
      '--release-channel',
      'beta',
      '--expected-cohort',
      'staff',
      '--expected-rollout-percent',
      '25',
    ], {});

    expect(args).toMatchObject({
      manifestUrl: 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/channels/beta/manifest.json',
      releaseRecordUrl: 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/channels/beta/release-record.json',
      expectedReleaseChannel: 'beta',
      expectedCohort: 'staff',
      expectedRolloutPercent: '25',
    });
  });

  it('scopes production control-plane verification to renderer rollout by default', () => {
    const args = parseRendererHotUpdateProductionArgs([], {});

    expect(args.controlPlaneArtifacts).toEqual([{
      name: 'renderer bundle rollout policy',
      path: '/api/v1/control-plane?artifact=renderer_bundle_rollout',
      expectedKind: 'renderer_bundle_rollout',
    }]);
  });

  it('can opt into full control-plane smoke when requested', () => {
    const args = parseRendererHotUpdateProductionArgs(['--full-control-plane-smoke'], {});

    expect(args.controlPlaneArtifacts).toEqual(CONTROL_PLANE_ARTIFACTS);
  });

  it('parses remote snapshot diagnostics flags', () => {
    expect(parseRendererHotUpdateProductionArgs([
      '--include-remote-snapshot',
      '--skip-bundle-hash-snapshot',
    ], {})).toMatchObject({
      includeRemoteSnapshot: true,
      includeBundleHashSnapshot: false,
    });
  });

  it('can derive expected renderer version from app update metadata', async () => {
    const rendererCalls: unknown[] = [];
    const fetchUrls: string[] = [];
    const fetchImpl = async (url: string) => {
      fetchUrls.push(url);
      return new Response(JSON.stringify({
        success: true,
        hasUpdate: true,
        forceUpdate: false,
        currentVersion: '0.0.0',
        latestVersion: '0.16.94',
        channel: 'stable',
        source: 'github_releases',
      }), { status: 200 });
    };

    const summary = await verifyRendererHotUpdateProduction({
      ...parseRendererHotUpdateProductionArgs([
        '--skip-control-plane',
        '--expected-version-from-app-update',
        '--app-update-url',
        'https://control-plane.example/api/update?action=check&version=0.0.0&platform=darwin&channel=stable',
      ], {}),
      fetchImpl,
      verifyRendererBundlePublishImpl: async (options: unknown) => {
        rendererCalls.push(options);
        return { version: '0.16.94' };
      },
    });

    expect(fetchUrls).toEqual([
      'https://control-plane.example/api/update?action=check&version=0.0.0&platform=darwin&channel=stable',
    ]);
    expect(rendererCalls).toEqual([
      expect.objectContaining({ expectedVersion: '0.16.94' }),
    ]);
    expect(summary.appUpdate).toMatchObject({
      skipped: false,
      expectedVersion: '0.16.94',
      latestVersion: '0.16.94',
    });
  });

  it('fails when explicit expected version conflicts with app update latest version', async () => {
    const fetchImpl = async () => new Response(JSON.stringify({
      success: true,
      hasUpdate: true,
      forceUpdate: false,
      currentVersion: '0.0.0',
      latestVersion: '0.16.94',
      channel: 'stable',
      source: 'github_releases',
    }), { status: 200 });

    await expect(verifyRendererHotUpdateProduction({
      ...parseRendererHotUpdateProductionArgs([
        '--skip-control-plane',
        '--expected-version',
        '0.16.93',
        '--expected-version-from-app-update',
      ], {}),
      fetchImpl,
      verifyRendererBundlePublishImpl: async () => ({ version: '0.16.93' }),
    })).rejects.toMatchObject({
      code: 'app_update_expected_version_mismatch',
      failures: [
        {
          target: 'app-update',
          code: 'app_update_expected_version_mismatch',
        },
      ],
    });
  });

  it('passes explicit public keys to renderer bundle verification', async () => {
    const rendererCalls: unknown[] = [];

    await verifyRendererHotUpdateProduction({
      ...parseRendererHotUpdateProductionArgs([
        '--skip-control-plane',
        '--public-keys-json',
        JSON.stringify({ 'prod-key': '-----BEGIN PUBLIC KEY-----\\ntest\\n-----END PUBLIC KEY-----' }),
      ], {}),
      verifyRendererBundlePublishImpl: async (options: unknown) => {
        rendererCalls.push(options);
        return { version: '0.16.93' };
      },
    });

    expect(rendererCalls).toEqual([
      expect.objectContaining({
        publicKeys: {
          'prod-key': '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
        },
      }),
    ]);
  });

  it('reads explicit public keys from a JSON file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'renderer-hot-update-keys-'));
    const file = join(dir, 'public-keys.json');
    writeFileSync(file, JSON.stringify({
      keys: {
        'file-key': '-----BEGIN PUBLIC KEY-----\\nfile\\n-----END PUBLIC KEY-----',
      },
    }));

    expect(parseRendererHotUpdateProductionArgs(['--public-keys-file', file], {})).toMatchObject({
      publicKeys: {
        'file-key': '-----BEGIN PUBLIC KEY-----\nfile\n-----END PUBLIC KEY-----',
      },
    });
  });

  it('requires single public key id and value together', () => {
    expect(() => parseRendererHotUpdateProductionArgs([
      '--public-key-id',
      'prod-key',
    ], {})).toThrowError(RendererHotUpdateProductionVerificationError);

    expect(parseRendererHotUpdateProductionArgs([
      '--public-key-id',
      'prod-key',
      '--public-key',
      '-----BEGIN PUBLIC KEY-----\\ntest\\n-----END PUBLIC KEY-----',
    ], {})).toMatchObject({
      publicKeys: {
        'prod-key': '-----BEGIN PUBLIC KEY-----\ntest\n-----END PUBLIC KEY-----',
      },
    });
  });

  it('lets rollback verification allow empty required shell capabilities', () => {
    const args = parseRendererHotUpdateProductionArgs([
      '--allow-empty-required-shell-capabilities',
    ], {});

    expect(args.minRequiredShellCapabilities).toBe(0);
  });

  it('parses the minimum manifest validity window for production checks', () => {
    expect(parseRendererHotUpdateProductionArgs([], {})).toMatchObject({
      minManifestValiditySeconds: DEFAULT_MIN_MANIFEST_VALIDITY_SECONDS,
    });
    expect(parseRendererHotUpdateProductionArgs([
      '--min-manifest-validity-seconds',
      '86400',
    ], {})).toMatchObject({
      minManifestValiditySeconds: 86400,
    });
    expect(parseRendererHotUpdateProductionArgs([
      '--allow-short-manifest-validity',
    ], {
      RENDERER_BUNDLE_MIN_MANIFEST_VALIDITY_SECONDS: '86400',
    })).toMatchObject({
      minManifestValiditySeconds: 0,
    });
    expect(() => parseRendererHotUpdateProductionArgs([
      '--min-manifest-validity-seconds',
      '-1',
    ], {})).toThrowError(RendererHotUpdateProductionVerificationError);
  });

  it('parses bounded retry options for deployment propagation windows', () => {
    expect(parseRendererHotUpdateProductionArgs([
      '--retry-attempts',
      '3',
      '--retry-delay-ms',
      '250',
    ], {})).toMatchObject({
      retryAttempts: 3,
      retryDelayMs: 250,
    });
    expect(parseRendererHotUpdateProductionArgs([], {
      RENDERER_HOT_UPDATE_PRODUCTION_VERIFY_RETRY_ATTEMPTS: '4',
      RENDERER_HOT_UPDATE_PRODUCTION_VERIFY_RETRY_DELAY_MS: '1000',
    })).toMatchObject({
      retryAttempts: 4,
      retryDelayMs: 1000,
    });
    expect(() => parseRendererHotUpdateProductionArgs([
      '--retry-attempts',
      '0',
    ], {})).toThrowError(RendererHotUpdateProductionVerificationError);
    expect(() => parseRendererHotUpdateProductionArgs([
      '--retry-delay-ms',
      '-1',
    ], {})).toThrowError(RendererHotUpdateProductionVerificationError);
  });

  it('parses bounded network timeouts for production verification', () => {
    expect(parseRendererHotUpdateProductionArgs([
      '--network-timeout-ms',
      '1234',
      '--bundle-timeout-ms',
      '5678',
    ], {})).toMatchObject({
      networkTimeoutMs: 1234,
      bundleTimeoutMs: 5678,
    });
    expect(parseRendererHotUpdateProductionArgs([], {
      RENDERER_HOT_UPDATE_NETWORK_TIMEOUT_MS: '2222',
      RENDERER_HOT_UPDATE_BUNDLE_TIMEOUT_MS: '3333',
    })).toMatchObject({
      networkTimeoutMs: 2222,
      bundleTimeoutMs: 3333,
    });
    expect(() => parseRendererHotUpdateProductionArgs([
      '--network-timeout-ms',
      '-1',
    ], {})).toThrowError(RendererHotUpdateProductionVerificationError);
    expect(() => parseRendererHotUpdateProductionArgs([
      '--bundle-timeout-ms',
      '-1',
    ], {})).toThrowError(RendererHotUpdateProductionVerificationError);
  });

  it('bounds control-plane fetches with stage diagnostics', async () => {
    const hangingFetch = async () => new Promise<Response>(() => {
      // Intentionally never settles; production verification must bound it.
    });
    const endpoint = 'https://control-plane.example/api/v1/control-plane?artifact=renderer_bundle_rollout';

    await expect(verifyRendererHotUpdateProduction({
      controlPlaneBaseUrl: 'https://control-plane.example',
      skipRendererBundle: true,
      networkTimeoutMs: 5,
      fetchImpl: hangingFetch,
      runControlPlaneSmokeImpl: async (options: unknown) => {
        const { fetchImpl: controlPlaneFetch } = options as {
          fetchImpl: (url: string) => Promise<Response>;
        };
        await controlPlaneFetch(endpoint);
        return [];
      },
    })).rejects.toMatchObject({
      code: 'fetch_timeout',
      failures: [{
        target: 'control-plane',
        code: 'fetch_timeout',
        endpoint,
        details: {
          stage: 'control-plane:metadata',
          timeoutMs: 5,
        },
      }],
    });
  });

  it('requires a release-record URL when a custom manifest URL cannot derive one', () => {
    expect(() => parseRendererHotUpdateProductionArgs([
      '--manifest-url',
      'https://cdn.example.com/canary.json',
    ], {})).toThrowError(RendererHotUpdateProductionVerificationError);

    expect(parseRendererHotUpdateProductionArgs([
      '--manifest-url',
      'https://cdn.example.com/canary.json',
      '--skip-release-record',
    ], {})).toMatchObject({
      manifestUrl: 'https://cdn.example.com/canary.json',
      releaseRecordUrl: undefined,
    });
  });

  it('supports checking only one side of the production surface', async () => {
    let controlPlaneCalls = 0;
    let rendererCalls = 0;

    const rendererOnly = await verifyRendererHotUpdateProduction({
      ...parseRendererHotUpdateProductionArgs(['--skip-control-plane'], {}),
      runControlPlaneSmokeImpl: async () => {
        controlPlaneCalls += 1;
        return [];
      },
      verifyRendererBundlePublishImpl: async () => {
        rendererCalls += 1;
        return { version: '0.16.93' };
      },
    });
    expect(rendererOnly.controlPlane).toEqual({ skipped: true });
    expect(rendererOnly.rendererBundle).toMatchObject({ skipped: false, version: '0.16.93' });

    const controlPlaneOnly = await verifyRendererHotUpdateProduction({
      ...parseRendererHotUpdateProductionArgs(['--skip-renderer-bundle'], {}),
      runControlPlaneSmokeImpl: async () => {
        controlPlaneCalls += 1;
        return [];
      },
      verifyRendererBundlePublishImpl: async () => {
        rendererCalls += 1;
        return { version: 'unused' };
      },
    });
    expect(controlPlaneOnly.controlPlane).toMatchObject({ skipped: false, checked: 0 });
    expect(controlPlaneOnly.rendererBundle).toEqual({ skipped: true });
    expect(controlPlaneCalls).toBe(1);
    expect(rendererCalls).toBe(1);
  });

  it('rejects when both sides are skipped', () => {
    expect(() => parseRendererHotUpdateProductionArgs([
      '--skip-control-plane',
      '--skip-renderer-bundle',
    ], {})).toThrowError(RendererHotUpdateProductionVerificationError);
  });

  it('aggregates production verification failures from both sides', async () => {
    await expect(verifyRendererHotUpdateProduction({
      controlPlaneBaseUrl: 'https://control-plane.example',
      manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
      releaseRecordUrl: 'https://oss.example/renderer-bundle/latest/release-record.json',
      runControlPlaneSmokeImpl: async () => {
        const error = new Error('rollout policy missing') as Error & { code?: string };
        error.code = 'control_plane_unconfigured';
        throw error;
      },
      verifyRendererBundlePublishImpl: async () => {
        const error = new Error('bundle sha mismatch') as Error & { code?: string; details?: unknown };
        error.code = 'bundle_hash_mismatch';
        error.details = { expected: 'a', actual: 'b' };
        throw error;
      },
    })).rejects.toMatchObject({
      code: 'renderer_hot_update_production_verification_failed',
      failures: [
        { target: 'control-plane', code: 'control_plane_unconfigured' },
        { target: 'renderer-bundle', code: 'bundle_hash_mismatch' },
      ],
    });
  });

  it('retries production verification while Vercel deployment propagates', async () => {
    const controlPlaneCalls: unknown[] = [];
    const rendererCalls: unknown[] = [];
    const sleeps: number[] = [];

    const summary = await verifyRendererHotUpdateProductionWithRetry({
      ...parseRendererHotUpdateProductionArgs([
        '--retry-attempts',
        '2',
        '--retry-delay-ms',
        '25',
      ], {}),
      retrySleep: async (ms: number) => {
        sleeps.push(ms);
      },
      runControlPlaneSmokeImpl: async (options: unknown) => {
        controlPlaneCalls.push(options);
        if (controlPlaneCalls.length === 1) {
          const error = new Error('renderer rollout policy still deploying') as Error & { code?: string };
          error.code = 'http_status';
          throw error;
        }
        return [{
          name: 'renderer bundle rollout policy',
          endpoint: `${PRODUCTION_CLOUD_API_URL}/api/v1/control-plane?artifact=renderer_bundle_rollout`,
          status: 200,
          kind: 'renderer_bundle_rollout',
          keyId: 'prod-key',
          contentHash: 'sha256:'.concat('b'.repeat(64)),
          expiresAt: '2099-12-31T23:59:59.000Z',
        }];
      },
      verifyRendererBundlePublishImpl: async (options: unknown) => {
        rendererCalls.push(options);
        return {
          version: '0.16.93',
          releaseRecordVerified: true,
        };
      },
    });

    expect(controlPlaneCalls).toHaveLength(2);
    expect(rendererCalls).toHaveLength(2);
    expect(sleeps).toEqual([25]);
    expect(summary).toMatchObject({
      controlPlane: { checked: 1 },
      rendererBundle: { version: '0.16.93' },
    });
  });

  it('can include unsigned remote artifact diagnostics when verification fails', async () => {
    const bundleBytes = Buffer.from('renderer-bundle');
    const expectedHash = 'a3f511529d69aae807dc87c741e8c94471dfd399e00040546614e5c1412b8149';
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/manifest.json')) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          kind: 'renderer_bundle',
          issuedAt: '2026-06-05T16:05:26.220Z',
          expiresAt: '2000-01-01T00:00:00.000Z',
          contentHash: 'sha256:'.concat('a'.repeat(64)),
          keyId: 'prod-key',
          payload: {
            version: '0.16.92',
            minShellVersion: '0.16.92',
            contentHash: expectedHash,
            bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
          },
          signature: 'signed',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.endsWith('/release-record.json')) {
        return new Response('<Error><Code>NoSuchKey</Code></Error>', {
          status: 404,
          headers: { 'Content-Type': 'application/xml' },
        });
      }
      if (url.includes('/api/update?action=check')) {
        return new Response(JSON.stringify({
          success: true,
          hasUpdate: true,
          forceUpdate: false,
          currentVersion: '0.0.0',
          latestVersion: '0.16.94',
          channel: 'stable',
          source: 'github_releases',
          publishedAt: '2026-06-06T01:24:49.062Z',
        }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(bundleBytes, {
        status: 200,
        headers: { 'Content-Type': 'application/gzip' },
      });
    };

    await expect(verifyRendererHotUpdateProduction({
      controlPlaneBaseUrl: 'https://control-plane.example',
      manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
      releaseRecordUrl: 'https://oss.example/renderer-bundle/latest/release-record.json',
      expectedVersion: '0.16.94',
      expectedReleaseChannel: 'latest',
      includeRemoteSnapshot: true,
      fetchImpl,
      runControlPlaneSmokeImpl: async () => {
        const error = new Error('rollout policy missing') as Error & { code?: string };
        error.code = 'http_status';
        throw error;
      },
      verifyRendererBundlePublishImpl: async () => {
        const error = new Error('control-plane public keys are required') as Error & { code?: string };
        error.code = 'missing_public_keys';
        throw error;
      },
    })).rejects.toMatchObject({
      details: {
        remoteSnapshot: {
          manifest: {
            ok: true,
            status: 200,
            envelope: {
              keyId: 'prod-key',
              expired: true,
              payload: {
                version: '0.16.92',
                expected: '0.16.94',
                matchesExpected: false,
                contentHash: expectedHash,
              },
            },
          },
          releaseRecord: {
            ok: false,
            status: 404,
            textSample: expect.stringContaining('NoSuchKey'),
          },
          appUpdate: {
            ok: true,
            status: 200,
            latestVersion: '0.16.94',
            channel: 'stable',
            source: 'github_releases',
            rendererManifestExpectation: {
              version: '0.16.92',
              matchesLatestVersion: false,
            },
          },
          bundle: {
            ok: true,
            status: 200,
            expectedSha256: expectedHash,
            matchesManifestPayload: true,
          },
        },
      },
    });
  });
});

describe('deriveRendererBundleReleaseRecordUrl', () => {
  it('derives release-record.json next to manifest.json', () => {
    expect(deriveRendererBundleReleaseRecordUrl(
      'https://oss.example/renderer-bundle/latest/manifest.json',
    )).toBe('https://oss.example/renderer-bundle/latest/release-record.json');
  });

  it('returns undefined for non-manifest paths', () => {
    expect(deriveRendererBundleReleaseRecordUrl(
      'https://oss.example/renderer-bundle/latest/canary.json',
    )).toBeUndefined();
  });
});

describe('inspectRendererHotUpdateRemoteArtifacts', () => {
  it('summarizes manifest, release record, and bundle hash without trusting them', async () => {
    const bundleBytes = Buffer.from('renderer-bundle');
    const expectedHash = 'a3f511529d69aae807dc87c741e8c94471dfd399e00040546614e5c1412b8149';
    const fetchImpl = async (url: string) => {
      if (url.endsWith('/manifest.json')) {
        return new Response(JSON.stringify({
          schemaVersion: 1,
          kind: 'renderer_bundle',
          expiresAt: '2099-01-01T00:00:00.000Z',
          keyId: 'prod-key',
          payload: {
            version: '0.16.93',
            minShellVersion: '0.16.93',
            contentHash: expectedHash,
            bundleUrl: 'https://oss.example/renderer-bundle/latest/bundle.tar.gz',
            requiredShellCapabilities: ['domain:update/check'],
          },
        }), { status: 200 });
      }
      if (url.endsWith('/release-record.json')) {
        return new Response(JSON.stringify({
          kind: 'renderer_bundle_release_record',
          version: '0.16.93',
          channel: 'latest',
        }), { status: 200 });
      }
      if (url.includes('/api/update?action=check')) {
        return new Response(JSON.stringify({
          success: true,
          hasUpdate: true,
          forceUpdate: false,
          currentVersion: '0.0.0',
          latestVersion: '0.16.93',
          channel: 'stable',
          source: 'github_releases',
        }), { status: 200 });
      }
      return new Response(bundleBytes, { status: 200 });
    };

    await expect(inspectRendererHotUpdateRemoteArtifacts({
      manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
      releaseRecordUrl: 'https://oss.example/renderer-bundle/latest/release-record.json',
      appUpdateUrl: 'https://control-plane.example/api/update?action=check&version=0.0.0&platform=darwin&channel=stable',
      expectedVersion: '0.16.93',
      expectedReleaseChannel: 'latest',
      fetchImpl,
    })).resolves.toMatchObject({
      manifest: {
        ok: true,
        envelope: {
          kind: 'renderer_bundle',
          expired: false,
          payload: {
            version: '0.16.93',
            expected: '0.16.93',
            matchesExpected: true,
            requiredShellCapabilitiesCount: 1,
          },
        },
      },
      releaseRecord: {
        ok: true,
        kind: 'renderer_bundle_release_record',
        version: '0.16.93',
        expected: '0.16.93',
        matchesExpected: true,
        channelExpectation: {
          expected: 'latest',
          matchesExpected: true,
        },
      },
      appUpdate: {
        ok: true,
        latestVersion: '0.16.93',
        rendererManifestExpectation: {
          version: '0.16.93',
          matchesLatestVersion: true,
        },
      },
      bundle: {
        ok: true,
        matchesManifestPayload: true,
      },
    });
  });

  it('fails fast with stage details when a remote artifact fetch hangs', async () => {
    const fetchImpl = async () => new Promise<Response>(() => {
      // Intentionally never settles; verifier timeout must bound it.
    });

    await expect(inspectRendererHotUpdateRemoteArtifacts({
      manifestUrl: 'https://oss.example/renderer-bundle/latest/manifest.json',
      fetchImpl,
      networkTimeoutMs: 5,
      bundleTimeoutMs: 5,
    })).rejects.toMatchObject({
      code: 'fetch_timeout',
      endpoint: 'https://oss.example/renderer-bundle/latest/manifest.json',
      details: {
        stage: 'remote-snapshot:manifest',
        timeoutMs: 5,
      },
    });
  });
});
