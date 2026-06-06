import { describe, expect, it } from 'vitest';
import {
  OSS_RELEASES_BASE_URL,
  RENDERER_BUNDLE_CHANNEL_ENV,
  RENDERER_BUNDLE_COHORT_ENV,
  RENDERER_BUNDLE_ENDPOINTS,
  RENDERER_BUNDLE_MANIFEST_URL_ENV,
  RENDERER_BUNDLE_ROLLOUT_POLICY_URL_ENV,
  RendererBundleEndpointError,
  resolveRendererBundleEndpoint,
} from '../../../src/shared/constants/network';

// 循环6：前端热更 OSS 端点常量（禁硬编码，集中维护）
describe('renderer bundle OSS endpoints', () => {
  it('exposes the OSS releases bucket base url', () => {
    expect(OSS_RELEASES_BASE_URL).toBe('https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com');
  });

  it('points manifest url at renderer-bundle/latest/manifest.json', () => {
    expect(RENDERER_BUNDLE_ENDPOINTS.getManifestUrl({})).toBe(
      'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/latest/manifest.json',
    );
  });

  it('points named channels at renderer-bundle/channels/<channel>/manifest.json', () => {
    expect(RENDERER_BUNDLE_ENDPOINTS.getManifestUrl({ [RENDERER_BUNDLE_CHANNEL_ENV]: 'beta' })).toBe(
      'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/channels/beta/manifest.json',
    );
    expect(resolveRendererBundleEndpoint({ [RENDERER_BUNDLE_CHANNEL_ENV]: 'beta' })).toEqual({
      channel: 'beta',
      manifestUrl: 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/channels/beta/manifest.json',
    });
  });

  it('allows a full manifest url override for controlled canary validation', () => {
    expect(
      RENDERER_BUNDLE_ENDPOINTS.getManifestUrl({
        [RENDERER_BUNDLE_CHANNEL_ENV]: 'beta',
        [RENDERER_BUNDLE_MANIFEST_URL_ENV]: 'https://cdn.example.com/custom/manifest.json',
      }),
    ).toBe('https://cdn.example.com/custom/manifest.json');
    expect(
      resolveRendererBundleEndpoint({
        [RENDERER_BUNDLE_CHANNEL_ENV]: 'beta',
        [RENDERER_BUNDLE_MANIFEST_URL_ENV]: 'https://cdn.example.com/custom/manifest.json',
      }),
    ).toEqual({
      channel: 'beta',
      manifestUrl: 'https://cdn.example.com/custom/manifest.json',
      manifestUrlOverride: true,
    });
  });

  it('exposes an optional rollout policy url and cohort for control-plane canary routing', () => {
    expect(
      resolveRendererBundleEndpoint({
        [RENDERER_BUNDLE_ROLLOUT_POLICY_URL_ENV]: 'https://agentneo.example/api/v1/control-plane?kind=renderer_bundle_rollout',
        [RENDERER_BUNDLE_COHORT_ENV]: 'staff',
      }),
    ).toEqual({
      channel: 'latest',
      manifestUrl: 'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/latest/manifest.json',
      rolloutPolicyUrl: 'https://agentneo.example/api/v1/control-plane?kind=renderer_bundle_rollout',
      rolloutPolicyUrlOverride: true,
      cohort: 'staff',
    });
  });

  it('rejects invalid channel names instead of falling back to latest', () => {
    expect(() => RENDERER_BUNDLE_ENDPOINTS.getManifestUrl({ [RENDERER_BUNDLE_CHANNEL_ENV]: '../beta' }))
      .toThrow(RendererBundleEndpointError);
  });

  it('rejects invalid rollout policy urls instead of silently ignoring control-plane config', () => {
    expect(() => resolveRendererBundleEndpoint({ [RENDERER_BUNDLE_ROLLOUT_POLICY_URL_ENV]: 'file:///tmp/policy.json' }))
      .toThrow(RendererBundleEndpointError);
  });
});
