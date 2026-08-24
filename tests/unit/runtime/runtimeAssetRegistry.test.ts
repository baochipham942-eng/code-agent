import { describe, expect, it } from 'vitest';
import {
  createRuntimeAssetDefinitions,
  RUNTIME_ASSET_DEFINITIONS,
} from '../../../src/host/runtime/runtimeAssetRegistry';

describe('runtimeAssetRegistry', () => {
  it('classifies managed runtimes and bundled helpers in one registry', () => {
    expect(Object.fromEntries(
      RUNTIME_ASSET_DEFINITIONS.map((asset) => [asset.id, asset.delivery]),
    )).toMatchObject({
      'onnxruntime-vad': 'optional',
      'playwright-browser-runtime': 'optional',
      'sharp-image-runtime': 'bundled',
      'system-audio-capture': 'bundled',
      'vision-ocr': 'bundled',
      'vision-tagger': 'bundled',
      'computer-use-app': 'bundled',
      uv: 'bundled',
      rtk: 'bundled',
    });
    expect(RUNTIME_ASSET_DEFINITIONS.find((asset) => asset.id === 'uv')).toMatchObject({
      kind: 'tool-binary',
      version: '0.11.16',
      pinnedHashes: expect.objectContaining({
        'darwin-arm64': expect.objectContaining({ hashKind: 'pinnedBinarySha256' }),
      }),
    });
    expect(RUNTIME_ASSET_DEFINITIONS.find((asset) => asset.id === 'computer-use-app')).toMatchObject({
      kind: 'app-bundle',
      version: '0.14.2',
      pinnedHashes: expect.objectContaining({
        'darwin-arm64': expect.objectContaining({
          hash: 'efc8f88a2f6e7424ab68d080331fd6aa94ef699153f2631d7a9214515151098c',
          hashKind: 'pinnedArchiveSha256',
        }),
        'darwin-x64': expect.objectContaining({
          hash: 'efc8f88a2f6e7424ab68d080331fd6aa94ef699153f2631d7a9214515151098c',
          hashKind: 'pinnedArchiveSha256',
        }),
      }),
    });
  });

  it('declares the exact Linux x64 runtime surface and native sharp packages', () => {
    const linuxDefinitions = createRuntimeAssetDefinitions('linux', 'x64');
    const linuxSupported = linuxDefinitions
      .filter((asset) => asset.platforms?.includes('linux-x64'))
      .map((asset) => asset.id);

    expect(linuxSupported).toEqual([
      'onnxruntime-vad',
      'playwright-browser-runtime',
      'sharp-image-runtime',
      'uv',
      'rtk',
    ]);
    expect(linuxDefinitions.find((asset) => asset.id === 'sharp-image-runtime')).toMatchObject({
      delivery: 'bundled',
      nodeModules: expect.arrayContaining([
        'sharp',
        '@img/sharp-linux-x64',
        '@img/sharp-libvips-linux-x64',
      ]),
    });
    expect(linuxDefinitions.find((asset) => asset.id === 'uv')?.pinnedHashes?.['linux-x64'])
      .toMatchObject({ hashKind: 'pinnedBinarySha256' });
    expect(linuxDefinitions.find((asset) => asset.id === 'rtk')?.pinnedHashes?.['linux-x64'])
      .toMatchObject({ hashKind: 'pinnedBinarySha256' });
  });

  it('marks macOS-only Swift helpers and app bundle unsupported on Linux', () => {
    const linuxDefinitions = createRuntimeAssetDefinitions('linux', 'x64');
    const macOnly = [
      'system-audio-capture',
      'vision-ocr',
      'vision-tagger',
      'computer-use-app',
    ];

    for (const assetId of macOnly) {
      const definition = linuxDefinitions.find((asset) => asset.id === assetId);
      expect(definition?.platforms).not.toContain('linux-x64');
      expect(definition?.platforms).toEqual(['darwin-arm64', 'darwin-x64']);
    }
  });
});
