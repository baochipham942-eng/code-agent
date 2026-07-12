import type {
  RuntimeAssetDelivery,
  RuntimeAssetHashKind,
  RuntimeAssetRegistryKind,
} from '../../shared/contract/update';

export interface RuntimeAssetDefinition {
  id: string;
  label: string;
  kind: RuntimeAssetRegistryKind;
  delivery: RuntimeAssetDelivery;
  nodeModules?: string[];
  resourceName?: string;
  resourceKind?: 'file' | 'directory';
  version?: string;
  minShellVersion?: string;
  platforms?: string[];
  pinnedHashes?: Record<string, {
    hash: string;
    hashKind: RuntimeAssetHashKind;
  }>;
}

// sharp 的 native 子包按运行架构区分（darwin-arm64 / darwin-x64）。
// 打包态由 build-runtime-assets 按 arch 产对应资产，运行态据 process.arch 解析。
const SHARP_NATIVE_ARCH = process.arch === 'x64' ? 'x64' : 'arm64';
const PLATFORM_ARCH = process.arch === 'x64' ? 'x64' : process.arch;
export const CURRENT_RUNTIME_ASSET_PLATFORM = `${process.platform}-${PLATFORM_ARCH}`;

const DARWIN_PLATFORMS = ['darwin-arm64', 'darwin-x64'];

const UV_BINARY_HASHES = {
  'darwin-arm64': 'f63ec276fa13f8f392542a334c0f58f36833b24304831e5f4c221e2edf7a16f3',
  'darwin-x64': '51aad75fa6c40c5f1f3f2b2f2ce7ad49faf4723e333d94c820510cf2acf04f49',
  'win32-x64': 'c5a583d5f1f6d055fc1c32c87d8eceee90edc69a5b9af5da70811befdfc04880',
};

const RTK_BINARY_HASHES = {
  'darwin-arm64': '7add15f7979c77f3523cdb4a69f46516469edd4ee731e60676e5dfa00492e39c',
  'darwin-x64': 'b9ac6819d2b5af7fcc64027ea6d4635832de8dfb706121733e7ae128192b6d5a',
  'win32-x64': '731583957e8cea7cfa858fb56835c001b71f75e595710a5441ebaee12fc6c83b',
};

function binaryHashes(
  hashes: Record<string, string>,
): RuntimeAssetDefinition['pinnedHashes'] {
  return Object.fromEntries(
    Object.entries(hashes).map(([platform, hash]) => [
      platform,
      { hash, hashKind: 'pinnedBinarySha256' as const },
    ]),
  );
}

export const RUNTIME_ASSET_DEFINITIONS: RuntimeAssetDefinition[] = [
  {
    id: 'onnxruntime-vad',
    label: 'Local audio capability components',
    kind: 'node-modules',
    delivery: 'optional',
    nodeModules: ['onnxruntime-node', 'avr-vad'],
    platforms: ['darwin-arm64'],
  },
  {
    id: 'playwright-browser-runtime',
    label: 'Browser automation components',
    kind: 'node-modules',
    delivery: 'optional',
    nodeModules: ['playwright', 'playwright-core'],
    platforms: DARWIN_PLATFORMS,
  },
  {
    id: 'sharp-image-runtime',
    label: 'Image processing components',
    kind: 'node-modules',
    delivery: 'bundled',
    nodeModules: [
      'sharp',
      '@img/colour',
      `@img/sharp-darwin-${SHARP_NATIVE_ARCH}`,
      `@img/sharp-libvips-darwin-${SHARP_NATIVE_ARCH}`,
      'detect-libc',
    ],
  },
  {
    id: 'system-audio-capture',
    label: 'System audio capture helper',
    kind: 'helper-binary',
    delivery: 'bundled',
    resourceName: 'system-audio-capture',
    resourceKind: 'file',
    platforms: DARWIN_PLATFORMS,
  },
  {
    id: 'vision-ocr',
    label: 'Vision OCR helper',
    kind: 'helper-binary',
    delivery: 'bundled',
    resourceName: 'vision-ocr',
    resourceKind: 'file',
    platforms: DARWIN_PLATFORMS,
  },
  {
    id: 'vision-tagger',
    label: 'Vision tagger helper',
    kind: 'helper-binary',
    delivery: 'bundled',
    resourceName: 'vision-tagger',
    resourceKind: 'file',
    platforms: DARWIN_PLATFORMS,
  },
  {
    id: 'computer-use-app',
    label: 'Agent Neo Computer Use app',
    kind: 'app-bundle',
    delivery: 'bundled',
    resourceName: 'Agent Neo Computer Use.app',
    resourceKind: 'directory',
    version: '0.5.1',
    platforms: DARWIN_PLATFORMS,
    pinnedHashes: {
      'darwin-arm64': {
        hash: '1b0d0138b0cb8ef0dcdeed1677473ed5bc4e1c3e99bae0e85a5fa945ac50323e',
        hashKind: 'pinnedArchiveSha256',
      },
      'darwin-x64': {
        hash: '1b0d0138b0cb8ef0dcdeed1677473ed5bc4e1c3e99bae0e85a5fa945ac50323e',
        hashKind: 'pinnedArchiveSha256',
      },
    },
  },
  {
    id: 'uv',
    label: 'uv sidecar binary',
    kind: 'tool-binary',
    delivery: 'bundled',
    resourceName: process.platform === 'win32' ? 'uv.exe' : 'uv',
    resourceKind: 'file',
    version: '0.11.16',
    platforms: ['darwin-arm64', 'darwin-x64', 'win32-x64'],
    pinnedHashes: binaryHashes(UV_BINARY_HASHES),
  },
  {
    id: 'rtk',
    label: 'rtk sidecar binary',
    kind: 'tool-binary',
    delivery: 'bundled',
    resourceName: process.platform === 'win32' ? 'rtk.exe' : 'rtk',
    resourceKind: 'file',
    version: '0.39.0',
    platforms: ['darwin-arm64', 'darwin-x64', 'win32-x64'],
    pinnedHashes: binaryHashes(RTK_BINARY_HASHES),
  },
];
