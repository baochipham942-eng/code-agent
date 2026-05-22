export interface RuntimeAssetDefinition {
  id: string;
  label: string;
  nodeModules: string[];
}

export const RUNTIME_ASSET_DEFINITIONS: RuntimeAssetDefinition[] = [
  {
    id: 'onnxruntime-vad',
    label: 'Local audio capability components',
    nodeModules: ['onnxruntime-node', 'avr-vad'],
  },
  {
    id: 'playwright-browser-runtime',
    label: 'Browser automation components',
    nodeModules: ['playwright', 'playwright-core'],
  },
  {
    id: 'sharp-image-runtime',
    label: 'Image processing components',
    nodeModules: [
      'sharp',
      '@img/colour',
      '@img/sharp-darwin-arm64',
      '@img/sharp-libvips-darwin-arm64',
      'detect-libc',
    ],
  },
];
