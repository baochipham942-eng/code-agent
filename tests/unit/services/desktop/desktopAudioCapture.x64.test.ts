import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  loadVadRuntime: vi.fn(),
}));

vi.mock('../../../../src/host/services/infra/logger', () => ({
  createLogger: () => mocks.logger,
}));

vi.mock('../../../../src/host/services/desktop/audioVadRuntime', () => ({
  isOrtTensor: vi.fn(() => false),
  loadVadRuntime: (...args: unknown[]) => mocks.loadVadRuntime(...args),
}));

vi.mock('../../../../src/host/services/desktop/nativeDesktopService', () => ({
  getNativeDesktopService: () => ({ getStatus: () => ({}) }),
}));

vi.mock('../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => '/tmp/code-agent-test-config',
}));

const originalPlatform = process.platform;
const originalArch = process.arch;

function setRuntimeTarget(platform: NodeJS.Platform, arch: string): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform });
  Object.defineProperty(process, 'arch', { configurable: true, value: arch });
}

afterAll(() => {
  setRuntimeTarget(originalPlatform, originalArch);
});

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadVadRuntime.mockReturnValue({
    ok: false,
    reason: 'missing-runtime',
    tauriNodeModules: '/missing/node_modules',
  });
});

describe('桌面环境音采集缺少 VAD runtime', () => {
  it('darwin/x64 明确说明永久能力边界，并在采集启动前返回', async () => {
    setRuntimeTarget('darwin', 'x64');
    const { startDesktopAudioCapture } = await import(
      '../../../../src/host/services/desktop/desktopAudioCapture'
    );

    await startDesktopAudioCapture('/tmp/fake-audio.fifo', 'microphone');

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      '[音频采集] Intel Mac 不支持 VAD 运行组件，桌面环境音采集未启动',
      { module: 'onnxruntime-node', platform: 'darwin', arch: 'x64' },
    );
    expect(mocks.logger.warn).toHaveBeenCalledWith('[音频采集] VAD 初始化失败，跳过音频采集');
    expect(mocks.logger.info).not.toHaveBeenCalledWith('[音频采集] 后台音频采集已启动');
  });

  it('其他架构缺 runtime 时不声称等待组件准备', async () => {
    setRuntimeTarget('darwin', 'arm64');
    const { startDesktopAudioCapture } = await import(
      '../../../../src/host/services/desktop/desktopAudioCapture'
    );

    await startDesktopAudioCapture('/tmp/fake-audio.fifo', 'microphone');

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      '[音频采集] 本地推理运行时缺失（onnxruntime 按需资产未安装），桌面环境音采集未启动',
      { module: 'onnxruntime-node', platform: 'darwin', arch: 'arm64' },
    );
    expect(JSON.stringify(mocks.logger.warn.mock.calls)).not.toContain('等待本地能力组件准备完成');
  });
});
