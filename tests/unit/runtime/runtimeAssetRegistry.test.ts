import { describe, expect, it } from 'vitest';
import { RUNTIME_ASSET_DEFINITIONS } from '../../../src/main/runtime/runtimeAssetRegistry';

describe('runtimeAssetRegistry', () => {
  it('classifies Sharp as bundled and keeps browser/audio runtimes optional', () => {
    expect(Object.fromEntries(
      RUNTIME_ASSET_DEFINITIONS.map((asset) => [asset.id, asset.delivery]),
    )).toEqual({
      'onnxruntime-vad': 'optional',
      'playwright-browser-runtime': 'optional',
      'sharp-image-runtime': 'bundled',
    });
  });
});
