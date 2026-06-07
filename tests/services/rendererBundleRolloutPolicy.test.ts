import { describe, expect, it } from 'vitest';
import {
  decideRendererBundleRollout,
  rendererBundleRolloutBucket,
} from '../../src/main/services/renderer/rendererBundleRolloutPolicy';

const fallbackEndpoint = {
  channel: 'latest',
  manifestUrl: 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/latest/manifest.json',
};

const baseContext = {
  currentShellVersion: '0.16.93',
  fallbackEndpoint,
  rolloutSeed: 'device-1',
  cohort: 'staff',
  platform: 'darwin',
};

describe('decideRendererBundleRollout', () => {
  it('selects a target channel when rollout gates match', () => {
    expect(
      decideRendererBundleRollout(
        {
          version: 'policy-1',
          channel: 'beta',
          cohorts: ['staff'],
          platforms: ['darwin'],
          minShellVersion: '0.16.0',
          maxShellVersion: '0.17.0',
        },
        baseContext,
      ),
    ).toMatchObject({
      action: 'use-manifest',
      channel: 'beta',
      manifestUrl: 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/channels/beta/manifest.json',
      policyVersion: 'policy-1',
      rolloutApplied: true,
    });
  });

  it('uses fallback latest when cohort, platform, or shell gate does not match', () => {
    expect(
      decideRendererBundleRollout(
        { version: 'policy-1', channel: 'beta', cohorts: ['internal'] },
        baseContext,
      ),
    ).toMatchObject({
      action: 'use-manifest',
      channel: 'latest',
      rolloutApplied: false,
      fallbackReason: 'rollout-cohort-mismatch',
    });

    expect(
      decideRendererBundleRollout(
        { version: 'policy-1', channel: 'beta', platforms: ['win32'] },
        baseContext,
      ),
    ).toMatchObject({
      action: 'use-manifest',
      channel: 'latest',
      fallbackReason: 'rollout-platform-mismatch',
    });

    expect(
      decideRendererBundleRollout(
        { version: 'policy-1', channel: 'beta', minShellVersion: '0.17.0' },
        baseContext,
      ),
    ).toMatchObject({
      action: 'use-manifest',
      channel: 'latest',
      fallbackReason: 'rollout-shell-too-old',
    });
  });

  it('applies deterministic rollout percent buckets', () => {
    const bucket = rendererBundleRolloutBucket('device-1', 'policy-1');
    expect(bucket).toBeGreaterThanOrEqual(0);
    expect(bucket).toBeLessThan(100);

    expect(
      decideRendererBundleRollout(
        { version: 'policy-1', channel: 'beta', rolloutPercent: Math.max(0, bucket - 0.01) },
        baseContext,
      ),
    ).toMatchObject({
      action: 'use-manifest',
      channel: 'latest',
      rolloutApplied: false,
      fallbackReason: 'rollout-percent-excluded',
      rolloutBucket: bucket,
    });

    expect(
      decideRendererBundleRollout(
        { version: 'policy-1', channel: 'beta', rolloutPercent: Math.min(100, bucket + 0.01) },
        baseContext,
      ),
    ).toMatchObject({
      action: 'use-manifest',
      channel: 'beta',
      rolloutApplied: true,
      rolloutBucket: bucket,
    });
  });

  it('skips when the signed policy pauses rollout', () => {
    expect(
      decideRendererBundleRollout(
        { version: 'policy-1', paused: true, pauseReason: 'watching error rate' },
        baseContext,
      ),
    ).toEqual({
      action: 'skip',
      reason: 'rollout-paused',
      policyVersion: 'policy-1',
      pauseReason: 'watching error rate',
    });
  });

  it('returns a rollback command when the policy asks for builtin renderer', () => {
    expect(
      decideRendererBundleRollout(
        { version: 'policy-1', rollbackToBuiltin: true, rollbackReason: 'bad overlay' },
        baseContext,
      ),
    ).toEqual({
      action: 'rollback-to-builtin',
      reason: 'rollout-rollback-to-builtin',
      policyVersion: 'policy-1',
      rollbackReason: 'bad overlay',
    });
  });

  it('fails closed on invalid policy shape or target endpoint', () => {
    expect(decideRendererBundleRollout({ channel: 'beta' }, baseContext)).toEqual({
      action: 'skip',
      reason: 'invalid-rollout-policy',
    });

    expect(
      decideRendererBundleRollout(
        { version: 'policy-1', channel: '../beta' },
        baseContext,
      ),
    ).toMatchObject({
      action: 'skip',
      reason: 'invalid-rollout-policy',
      policyVersion: 'policy-1',
    });
  });
});
