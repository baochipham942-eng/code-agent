import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  analyzeImageWithVisionDetailedMock,
  createFileArtifactMock,
} = vi.hoisted(() => ({
  execMock: vi.fn(),
  existsSyncMock: vi.fn().mockReturnValue(true),
  mkdirSyncMock: vi.fn(),
  statSyncMock: vi.fn().mockReturnValue({ size: 8192 }),
  analyzeImageWithVisionDetailedMock: vi.fn(),
  createFileArtifactMock: vi.fn(async (filePath: string, tool: string, ctx: { sessionId?: string }, options?: { metadata?: unknown }) => ({
    artifactId: `artifact:${filePath}`,
    kind: 'image',
    sourceTool: tool,
    createdAt: '2026-05-12T00:00:00.000Z',
    sessionId: ctx.sessionId,
    path: filePath,
    mimeType: 'image/png',
    sizeBytes: 8192,
    metadata: options?.metadata,
  })),
}));

vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => execMock(...args),
}));

vi.mock('fs', () => {
  // vitest 4 对命名空间/default 导入更严：显式给齐代码路径(含 transitive)用到的
  // fs 方法 + default 自指，覆盖 `import * as fs` 与 `import fs from 'fs'` 两种写法。
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
  analyzeImageWithVisionDetailed: (...args: unknown[]) => analyzeImageWithVisionDetailedMock(...args),
}));

// screenshot.ts 现在依赖 computerSurface（Gap 2：取 displayInfo + 写尺寸记账）。
// 直接 mock 这个依赖，避免拉入 backgroundCgEventSurface 的 native helper 栈。
vi.mock('../../../../src/host/services/desktop/computerSurface', () => ({
  getComputerSurface: () => ({
    getDisplayInfo: vi.fn().mockResolvedValue(null),
    setLastAnalyzedImageDims: vi.fn(),
    getLastAnalyzedImageDims: vi.fn().mockReturnValue(null),
  }),
}));

vi.mock('../../../../src/host/tools/artifacts/artifactMeta', () => ({
  // createFileArtifactMock 是带类型签名的 vi.fn，直接引用避免 unknown[] 展开类型不匹配
  createFileArtifact: createFileArtifactMock,
  createVirtualArtifact: vi.fn(),
  inferArtifactKind: vi.fn().mockReturnValue('image'),
}));

import { screenshotTool } from '../../../../src/host/tools/vision/screenshot';
import { screenshotModule } from '../../../../src/host/plugins/builtin/computerUse/screenshot';

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

describe('screenshotTool analyze failure handling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    execMock.mockImplementation((_command: string, callback: (error: Error | null, stdout?: string, stderr?: string) => void) => {
      callback(null, '', '');
    });
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({ size: 8192 });
    analyzeImageWithVisionDetailedMock.mockResolvedValue({
      ok: false,
      analysis: null,
      reason: 'http_error',
      error: 'Vision analysis request failed with HTTP 403: {"error":"model_not_allowed"}',
      model: 'glm-4.6v-flash',
      httpStatus: 403,
      retryable: false,
    });
  });

  it('fails the legacy screenshot result when analyze=true but vision fails', async () => {
    const outputPath = '/tmp/work/.screenshots/tencent-meeting.png';

    const result = await screenshotTool.execute(
      { analyze: true, outputPath },
      makeLegacyCtx(),
    );

    expect(result.success).toBe(false);
    expect(result.outputPath).toBe(outputPath);
    expect(result.error).toContain('AI vision analysis failed');
    expect(result.error).toContain('cannot observe or describe the screen content');
    expect(result.error).toContain('model_not_allowed');
    expect(result.error).toContain(outputPath);
    expect(result.metadata).toMatchObject({
      path: outputPath,
      size: 8192,
      analyzed: false,
      analysisRequested: true,
      analysis: null,
      cannotObserveScreen: true,
      browserComputerProof: {
        evidenceRefs: expect.arrayContaining([
          expect.objectContaining({
            kind: 'screenshot',
            source: 'screenshot',
            freshness: expect.objectContaining({ state: 'fresh' }),
          }),
        ]),
        visualObservation: {
          observed: false,
          source: 'none',
          reason: 'screenshot_analysis_failed',
          cannotObserveScreen: true,
        },
      },
      browserComputerEvidenceCard: {
        status: 'not_observed',
      },
      visionAnalysis: {
        ok: false,
        reason: 'http_error',
        httpStatus: 403,
      },
    });
  });

  it('preserves artifact metadata through the protocol screenshot wrapper', async () => {
    const outputPath = '/tmp/work/.screenshots/tencent-meeting.png';
    const handler = await screenshotModule.createHandler();

    const result = await handler.execute(
      { analyze: true, outputPath },
      makeProtocolCtx(),
      allowAll,
    );

    expect(result.ok).toBe(false);
    // 收窄判别联合：ok:true 分支没有 error 字段
    if (result.ok) throw new Error('expected handler to fail when vision analysis fails');
    expect(result.error).toContain('cannot observe or describe the screen content');
    expect(result.meta).toMatchObject({
      path: outputPath,
      analyzed: false,
      analysisRequested: true,
      cannotObserveScreen: true,
      tool: 'screenshot',
      browserComputerProof: {
        visualObservation: {
          observed: false,
          reason: 'screenshot_analysis_failed',
        },
      },
    });
    expect(result.meta?.artifact).toMatchObject({
      kind: 'image',
      sourceTool: 'screenshot',
      path: outputPath,
      mimeType: 'image/png',
      sizeBytes: 8192,
    });
  });

  it('does not treat a saved screenshot path as visual observation when analyze=false', async () => {
    const outputPath = '/tmp/work/.screenshots/path-only.png';

    const result = await screenshotTool.execute(
      { analyze: false, outputPath },
      makeLegacyCtx(),
    );

    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({
      path: outputPath,
      analyzed: false,
      analysisRequested: false,
      cannotObserveScreen: true,
      browserComputerProof: {
        visualObservation: {
          observed: false,
          source: 'none',
          reason: 'screenshot_path_only',
          cannotObserveScreen: true,
        },
      },
      browserComputerEvidenceCard: {
        status: 'not_observed',
      },
    });
    expect(result.metadata?.evidenceRefs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'screenshot',
        freshness: expect.objectContaining({ state: 'fresh' }),
      }),
    ]));
    expect(analyzeImageWithVisionDetailedMock).not.toHaveBeenCalled();
  });
});
