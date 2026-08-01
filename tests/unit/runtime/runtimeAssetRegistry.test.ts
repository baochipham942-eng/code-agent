import { describe, expect, it } from 'vitest';
import { RUNTIME_ASSET_DEFINITIONS } from '../../../src/host/runtime/runtimeAssetRegistry';

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
});
