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

const PLATFORM_ARCH = process.arch === 'x64' ? 'x64' : process.arch;
export const CURRENT_RUNTIME_ASSET_PLATFORM = `${process.platform}-${PLATFORM_ARCH}`;

const DARWIN_PLATFORMS = ['darwin-arm64', 'darwin-x64'];
const LINUX_X64_PLATFORM = 'linux-x64';
const PORTABLE_NODE_PLATFORMS = [...DARWIN_PLATFORMS, LINUX_X64_PLATFORM];

const UV_BINARY_HASHES = {
  'darwin-arm64': 'f63ec276fa13f8f392542a334c0f58f36833b24304831e5f4c221e2edf7a16f3',
  'darwin-x64': '51aad75fa6c40c5f1f3f2b2f2ce7ad49faf4723e333d94c820510cf2acf04f49',
  'linux-x64': '1a8423f7d6af28f66920210b05a780665178c0f5650c940b95c4b085a4f284b9',
  'win32-x64': 'c5a583d5f1f6d055fc1c32c87d8eceee90edc69a5b9af5da70811befdfc04880',
};

const RTK_BINARY_HASHES = {
  'darwin-arm64': '7add15f7979c77f3523cdb4a69f46516469edd4ee731e60676e5dfa00492e39c',
  'darwin-x64': 'b9ac6819d2b5af7fcc64027ea6d4635832de8dfb706121733e7ae128192b6d5a',
  'linux-x64': '8126de3da6e19c264dcfee8fbc603de179075b20d7f69bce1ebe1eeb060403ef',
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

function sharpNativePlatform(platform: NodeJS.Platform, arch: string): string {
  if (platform === 'linux' && arch === 'x64') return 'linux-x64';
  if (platform === 'darwin' && (arch === 'arm64' || arch === 'x64')) return `darwin-${arch}`;
  return `unsupported-${platform}-${arch}`;
}

// 🚫 不导出：唯一生产消费方是下面的 RUNTIME_ASSET_DEFINITIONS。为测试而导出会被
// knip 生产死导出棘轮判红（「只有单测 import」不算消费方），测试改用模块重载覆盖平台。
function createRuntimeAssetDefinitions(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): RuntimeAssetDefinition[] {
  const sharpPlatform = sharpNativePlatform(platform, arch);
  return [
    {
      id: 'onnxruntime-vad',
      label: 'Local audio capability components',
      kind: 'node-modules',
      delivery: 'optional',
      nodeModules: ['onnxruntime-node', 'avr-vad'],
      platforms: ['darwin-arm64', LINUX_X64_PLATFORM],
    },
    {
      id: 'playwright-browser-runtime',
      label: 'Browser automation components',
      kind: 'node-modules',
      delivery: 'optional',
      nodeModules: ['playwright', 'playwright-core'],
      platforms: PORTABLE_NODE_PLATFORMS,
    },
    {
      id: 'sharp-image-runtime',
      label: 'Image processing components',
      kind: 'node-modules',
      delivery: 'bundled',
      nodeModules: [
        'sharp',
        '@img/colour',
        `@img/sharp-${sharpPlatform}`,
        `@img/sharp-libvips-${sharpPlatform}`,
        'detect-libc',
      ],
      platforms: PORTABLE_NODE_PLATFORMS,
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
      version: '0.14.2',
      platforms: DARWIN_PLATFORMS,
      pinnedHashes: {
        'darwin-arm64': {
          hash: 'efc8f88a2f6e7424ab68d080331fd6aa94ef699153f2631d7a9214515151098c',
          hashKind: 'pinnedArchiveSha256',
        },
        'darwin-x64': {
          hash: 'efc8f88a2f6e7424ab68d080331fd6aa94ef699153f2631d7a9214515151098c',
          hashKind: 'pinnedArchiveSha256',
        },
      },
    },
    {
      id: 'uv',
      label: 'uv sidecar binary',
      kind: 'tool-binary',
      delivery: 'bundled',
      resourceName: platform === 'win32' ? 'uv.exe' : 'uv',
      resourceKind: 'file',
      version: '0.11.16',
      platforms: ['darwin-arm64', 'darwin-x64', LINUX_X64_PLATFORM, 'win32-x64'],
      pinnedHashes: binaryHashes(UV_BINARY_HASHES),
    },
    {
      id: 'rtk',
      label: 'rtk sidecar binary',
      kind: 'tool-binary',
      delivery: 'bundled',
      resourceName: platform === 'win32' ? 'rtk.exe' : 'rtk',
      resourceKind: 'file',
      version: '0.39.0',
      platforms: ['darwin-arm64', 'darwin-x64', LINUX_X64_PLATFORM, 'win32-x64'],
      pinnedHashes: binaryHashes(RTK_BINARY_HASHES),
    },
  ];
}

export const RUNTIME_ASSET_DEFINITIONS = createRuntimeAssetDefinitions();
