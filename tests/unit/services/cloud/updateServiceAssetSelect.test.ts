// ============================================================================
// updateService fallback 资产选择（OSS release.json 直读路径）
// 与 vercel-api/lib/updateMetadata.ts selectAsset 同语义：
//  - sidecar（runtime manifest json/sha）永不作为下载目标
//  - win32 匹配排除 'darwin'（含子串 'win'）
//  - 按 arch 精确命中；x64/win32 找不到不回退 arm64
// ============================================================================

import { describe, expect, it } from 'vitest';
import { selectReleaseAssetForPlatform } from '../../../../src/host/services/cloud/updateService';

// 对抗性排序：sidecar 与 runtime manifest 排在安装包之前（真实 release.json 顺序可变）
const ASSETS = [
  { name: 'runtime-assets-manifest-darwin-x64.json', browserDownloadUrl: 'https://oss.example/rt-x64.json' },
  { name: 'runtime-assets-manifest-darwin-arm64.json', browserDownloadUrl: 'https://oss.example/rt-arm64.json' },
  { name: 'runtime-assets-manifest-darwin-arm64.sha256', browserDownloadUrl: 'https://oss.example/rt-arm64.sha256' },
  { name: 'Agent-Neo-0.17.0-arm64.dmg', browserDownloadUrl: 'https://oss.example/arm64.dmg', size: 100 },
  { name: 'Agent-Neo-0.17.0-x64.dmg', browserDownloadUrl: 'https://oss.example/x64.dmg', size: 110 },
  { name: 'Agent-Neo-0.17.0-win-x64-setup.exe', browserDownloadUrl: 'https://oss.example/setup.exe', size: 90 },
];

describe('selectReleaseAssetForPlatform', () => {
  it('serves the NSIS exe to win32/x64, never a darwin-named sidecar', () => {
    const asset = selectReleaseAssetForPlatform(ASSETS, 'win32', 'x64');
    expect(asset?.name).toBe('Agent-Neo-0.17.0-win-x64-setup.exe');
  });

  it('serves the arch-matching dmg to darwin clients', () => {
    expect(selectReleaseAssetForPlatform(ASSETS, 'darwin', 'arm64')?.name).toBe('Agent-Neo-0.17.0-arm64.dmg');
    expect(selectReleaseAssetForPlatform(ASSETS, 'darwin', 'x64')?.name).toBe('Agent-Neo-0.17.0-x64.dmg');
  });

  it('falls back to the unmarked legacy asset only for arm64', () => {
    const legacy = [{ name: 'Agent-Neo-0.16.0.dmg', browserDownloadUrl: 'https://oss.example/legacy.dmg' }];
    expect(selectReleaseAssetForPlatform(legacy, 'darwin', 'arm64')?.name).toBe('Agent-Neo-0.16.0.dmg');
    expect(selectReleaseAssetForPlatform(legacy, 'darwin', 'x64')).toBeNull();
  });

  it('returns null for win32 when no windows installer exists (never cross-platform)', () => {
    const macOnly = ASSETS.filter((asset) => !asset.name.endsWith('.exe'));
    expect(selectReleaseAssetForPlatform(macOnly, 'win32', 'x64')).toBeNull();
  });
});
