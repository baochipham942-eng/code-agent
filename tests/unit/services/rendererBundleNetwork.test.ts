import { describe, expect, it } from 'vitest';
import { OSS_RELEASES_BASE_URL, RENDERER_BUNDLE_ENDPOINTS } from '../../../src/shared/constants/network';

// 循环6：前端热更 OSS 端点常量（禁硬编码，集中维护）
describe('renderer bundle OSS endpoints', () => {
  it('exposes the OSS releases bucket base url', () => {
    expect(OSS_RELEASES_BASE_URL).toBe('https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com');
  });

  it('points manifest url at renderer-bundle/latest/manifest.json', () => {
    expect(RENDERER_BUNDLE_ENDPOINTS.manifestUrl).toBe(
      'https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/renderer-bundle/latest/manifest.json',
    );
  });
});
