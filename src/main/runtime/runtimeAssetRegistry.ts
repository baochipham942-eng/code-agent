export interface RuntimeAssetDefinition {
  id: string;
  label: string;
  delivery: 'optional' | 'bundled';
  nodeModules: string[];
}

// sharp 的 native 子包按运行架构区分（darwin-arm64 / darwin-x64）。
// 打包态由 build-runtime-assets 按 arch 产对应资产，运行态据 process.arch 解析。
const SHARP_NATIVE_ARCH = process.arch === 'x64' ? 'x64' : 'arm64';

export const RUNTIME_ASSET_DEFINITIONS: RuntimeAssetDefinition[] = [
  {
    id: 'onnxruntime-vad',
    label: 'Local audio capability components',
    delivery: 'optional',
    nodeModules: ['onnxruntime-node', 'avr-vad'],
  },
  {
    id: 'playwright-browser-runtime',
    label: 'Browser automation components',
    delivery: 'optional',
    nodeModules: ['playwright', 'playwright-core'],
  },
  {
    id: 'sharp-image-runtime',
    label: 'Image processing components',
    delivery: 'bundled',
    nodeModules: [
      'sharp',
      '@img/colour',
      `@img/sharp-darwin-${SHARP_NATIVE_ARCH}`,
      `@img/sharp-libvips-darwin-${SHARP_NATIVE_ARCH}`,
      'detect-libc',
    ],
  },
];
