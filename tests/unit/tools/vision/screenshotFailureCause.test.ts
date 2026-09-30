import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../../../src/host/tools/types';
import type {
  CanUseToolFn,
  Logger,
  ToolContext as ProtocolToolContext,
} from '../../../../src/host/protocol/tools';

const {
  execMock,
  existsSyncMock,
  mkdirSyncMock,
  statSyncMock,
} = vi.hoisted(() => ({
  execMock: vi.fn(),
  existsSyncMock: vi.fn().mockReturnValue(true),
  mkdirSyncMock: vi.fn(),
  statSyncMock: vi.fn().mockReturnValue({ size: 8192 }),
}));

vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => execMock(...args),
}));

vi.mock('fs', () => {
  const fsMock = {
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
    statSync: (...args: unknown[]) => statSyncMock(...args),
    createReadStream: vi.fn(),
    appendFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    readFileSync: vi.fn(),
  };
  return { ...fsMock, default: fsMock };
});

vi.mock('../../../../src/host/services/desktop/visionAnalysisService', () => ({
  analyzeImageWithVisionDetailed: vi.fn(),
}));

vi.mock('../../../../src/host/services/desktop/computerSurface', () => ({
  getComputerSurface: () => ({
    getDisplayInfo: vi.fn().mockResolvedValue(null),
    setLastAnalyzedImageDims: vi.fn(),
    getLastAnalyzedImageDims: vi.fn().mockReturnValue(null),
  }),
}));

vi.mock('../../../../src/host/tools/artifacts/artifactMeta', () => ({
  createFileArtifact: vi.fn(),
  createVirtualArtifact: vi.fn(),
  inferArtifactKind: vi.fn().mockReturnValue('image'),
}));

import { screenshotModule } from '../../../../src/host/plugins/builtin/computerUse/screenshot';
import { screenshotTool } from '../../../../src/host/tools/vision/screenshot';
import { detectScreenshotFailureCause } from '../../../../src/host/tools/vision/screenshotFailureCause';

const originalPlatform = process.platform;

function setProcessPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function clearDetectionEnv(): void {
  for (const key of ['SSH_CONNECTION', 'SSH_TTY', 'SSH_CLIENT', 'DISPLAY', 'WAYLAND_DISPLAY']) {
    vi.stubEnv(key, '');
  }
}

function makeLegacyCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDirectory: '/tmp/work',
    requestPermission: vi.fn().mockResolvedValue(true),
    emit: vi.fn(),
    ...overrides,
  };
}

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeProtocolCtx(overrides: Partial<ProtocolToolContext> = {}): ProtocolToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/work',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: vi.fn(),
    ...overrides,
  } as unknown as ProtocolToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

function failExec(message: string, stderr = ''): void {
  execMock.mockImplementationOnce((_command: string, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
    callback(Object.assign(new Error(message), { stderr }), '', stderr);
  });
}

describe('screenshot failure cause detection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T12:34:56.789Z'));
    setProcessPlatform(originalPlatform);
    clearDetectionEnv();
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ size: 8192 });
    execMock.mockImplementation((_command: string, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      callback(null, '', '');
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    setProcessPlatform(originalPlatform);
  });

  it.each([
    {
      name: 'returns ssh_session_no_gui for darwin + SSH env',
      input: { platform: 'darwin', env: { SSH_CONNECTION: 'host' } },
      kind: 'ssh_session_no_gui',
      text: 'SSH session without a graphical session',
    },
    {
      name: 'returns screen_recording_permission for permission text',
      input: { platform: 'darwin', env: {}, message: 'Screen Recording: not authorized' },
      kind: 'screen_recording_permission',
      text: 'screen recording permission denied',
    },
    {
      name: 'returns no_display_server for linux without DISPLAY/WAYLAND_DISPLAY',
      input: { platform: 'linux', env: {} },
      kind: 'no_display_server',
      text: 'no display server detected',
    },
    {
      name: 'returns unknown otherwise',
      input: { platform: 'win32', env: {}, message: 'capture failed' },
      kind: 'unknown',
      text: 'unknown',
    },
  ])('$name', ({ input, kind, text }) => {
    expect(detectScreenshotFailureCause(input)).toEqual({ kind, text });
  });

  it('gives SSH session detection precedence over permission text', () => {
    expect(detectScreenshotFailureCause({
      platform: 'darwin',
      env: { SSH_TTY: '/dev/ttys001' },
      message: 'screen recording not authorized',
    })).toEqual({
      kind: 'ssh_session_no_gui',
      text: 'SSH session without a graphical session',
    });
  });

  it('screenshotTool.execute keeps the original command error first and adds the SSH cause', async () => {
    setProcessPlatform('darwin');
    vi.stubEnv('SSH_CONNECTION', 'host');
    failExec('capture command failed', 'screencapture failed');

    const result = await screenshotTool.execute({}, makeLegacyCtx());

    expect(result.error?.startsWith('Failed to capture screenshot: capture command failed')).toBe(true);
    expect(result.error).toContain('Detected cause: SSH session without a graphical session');
    expect(result.metadata).toMatchObject({ failureCause: 'ssh_session_no_gui' });
  });

  it('screenshotModule preserves the detected cause text and metadata', async () => {
    setProcessPlatform('darwin');
    vi.stubEnv('SSH_CLIENT', 'host');
    failExec('capture command failed');

    const handler = await screenshotModule.createHandler();
    const result = await handler.execute({}, makeProtocolCtx(), allowAll);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected screenshot wrapper to fail');
    expect(result.error).toContain('Detected cause: SSH session without a graphical session');
    expect(result.meta).toMatchObject({ failureCause: 'ssh_session_no_gui' });
  });

  it('reports unknown without inventing simulator, container, or virtual causes', async () => {
    setProcessPlatform('win32');
    failExec('capture command failed');

    const result = await screenshotTool.execute({}, makeLegacyCtx());

    expect(result.error).toContain('Cause: unknown (not detected by the tool; do not assume one)');
    expect(result.error).not.toMatch(/simulator|container|virtual/i);
    expect(result.metadata).toMatchObject({ failureCause: 'unknown' });
  });

  it('reports a missing Linux display server when no screenshot file is created', async () => {
    setProcessPlatform('linux');
    existsSyncMock.mockReturnValue(false);

    const result = await screenshotTool.execute({}, makeLegacyCtx());

    expect(result.error).toBe('Screenshot was not created\nDetected cause: no display server detected');
    expect(result.metadata).toMatchObject({ failureCause: 'no_display_server' });
  });

  it('keeps successful output byte-identical to the existing screenshot format', async () => {
    setProcessPlatform('linux');
    vi.stubEnv('DISPLAY', ':1');

    const result = await screenshotTool.execute({}, makeLegacyCtx());

    expect(result.success).toBe(true);
    expect(result.output).toBe([
      'Screenshot captured successfully:',
      '- Path: /tmp/work/.screenshots/screenshot_1790771696789.png',
      '- Size: 8.00 KB',
      '- Target: screen',
      '- Timestamp: 2026-09-30T12:34:56.789Z',
    ].join('\n'));
  });
});
