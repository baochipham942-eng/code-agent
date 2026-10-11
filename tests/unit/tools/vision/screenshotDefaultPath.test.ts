// ============================================================================
// screenshot 默认落盘位置（N-RETENTION-SHOTS-APPDIR）
// 无 outputPath 时不再写 <workdir>/.screenshots/，改落数据目录下按会话隔离的
// tool-screenshots/<sessionId>/；显式 outputPath 原样使用。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ToolContext } from '../../../../src/host/tools/types';

const {
  execMock,
  existsSyncMock,
  mkdirSyncMock,
  statSyncMock,
  appendFileSyncMock,
  analyzeImageWithVisionDetailedMock,
} = vi.hoisted(() => ({
  execMock: vi.fn(),
  existsSyncMock: vi.fn().mockReturnValue(true),
  mkdirSyncMock: vi.fn(),
  statSyncMock: vi.fn().mockReturnValue({ size: 8192 }),
  appendFileSyncMock: vi.fn(),
  analyzeImageWithVisionDetailedMock: vi.fn(),
}));

vi.mock('child_process', () => ({
  exec: (...args: unknown[]) => execMock(...args),
}));

vi.mock('fs', () => {
  // 覆盖 `import * as fs`：工具本体 + browserComputerProofStore（sessionId 存在时会
  // 走真实 persist）用到的方法都给齐，不落真盘。
  const fsMock = {
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
    statSync: (...args: unknown[]) => statSyncMock(...args),
    appendFileSync: (...args: unknown[]) => appendFileSyncMock(...args),
    rmSync: vi.fn(),
    renameSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    createReadStream: vi.fn(),
  };
  return { ...fsMock, default: fsMock };
});

vi.mock('../../../../src/host/services/desktop/visionAnalysisService', () => ({
  analyzeImageWithVisionDetailed: (...args: unknown[]) => analyzeImageWithVisionDetailedMock(...args),
}));

vi.mock('../../../../src/host/services/desktop/computerSurface', () => ({
  getComputerSurface: () => ({
    getDisplayInfo: vi.fn().mockResolvedValue(null),
    setLastAnalyzedImageDims: vi.fn(),
    getLastAnalyzedImageDims: vi.fn().mockReturnValue(null),
  }),
}));

import { screenshotTool } from '../../../../src/host/tools/vision/screenshot';

const cleanups: Array<() => Promise<void>> = [];
const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDirectory: '/tmp/work',
    requestPermission: vi.fn().mockResolvedValue(true),
    emit: vi.fn(),
    ...overrides,
  } as ToolContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  existsSyncMock.mockReturnValue(true);
  statSyncMock.mockReturnValue({ size: 8192 });
  execMock.mockImplementation(
    (_command: string, callback: (error: Error | null) => void) => {
      callback(null);
    },
  );
});

afterEach(async () => {
  vi.unstubAllEnvs();
  if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
  else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
  while (cleanups.length) await cleanups.pop()!();
});

describe('screenshot 默认输出路径', () => {
  it('无 outputPath 时落数据目录 tool-screenshots/<sessionId>/，不写工作目录', async () => {
    const dataDir = await tempDir('screenshot-default-data-');
    const workingDir = await tempDir('screenshot-default-work-');
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);

    const result = await screenshotTool.execute(
      { analyze: false },
      makeCtx({ workingDirectory: workingDir, sessionId: 'sess-abc123' }),
    );

    expect(result.success).toBe(true);
    const expectedDir = path.join(dataDir, 'tool-screenshots', 'sess-abc123');
    expect(result.outputPath).toMatch(new RegExp(`^${escapeRegExp(expectedDir)}/screenshot_\\d+\\.png$`));
    expect(result.outputPath!.startsWith(workingDir)).toBe(false);
    // 旧默认位置（工作目录 .screenshots/）不应再出现
    expect(result.outputPath).not.toContain(path.join(workingDir, '.screenshots'));
    // screencapture 拿到的是同一个新路径
    expect(execMock.mock.calls[0][0]).toContain(result.outputPath);
  });

  it('会话 id 含 ../ 时被清洗，路径无法逃出 tool-screenshots 根目录', async () => {
    const dataDir = await tempDir('screenshot-default-data-');
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);

    const result = await screenshotTool.execute(
      { analyze: false },
      makeCtx({ workingDirectory: '/tmp/work', sessionId: '../escape' }),
    );

    expect(result.success).toBe(true);
    const escapeDir = path.join(dataDir, 'tool-screenshots', 'escape');
    expect(result.outputPath).toMatch(
      new RegExp(`^${escapeRegExp(escapeDir)}/screenshot_\\d+\\.png$`),
    );
    expect(result.outputPath!.startsWith(path.join(dataDir, 'tool-screenshots'))).toBe(true);
  });

  it('结果文本与 proof 证据引用都指向实际落盘的新路径', async () => {
    const dataDir = await tempDir('screenshot-default-data-');
    vi.stubEnv('CODE_AGENT_DATA_DIR', dataDir);

    const result = await screenshotTool.execute(
      { analyze: false },
      makeCtx({ workingDirectory: '/tmp/work', sessionId: 'sess-abc123' }),
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain(`- Path: ${result.outputPath}`);
    const evidenceRefs = (result.metadata?.evidenceRefs ?? []) as Array<{ ref?: string }>;
    expect(evidenceRefs[0]?.ref).toBe(result.outputPath);
    expect(result.metadata?.browserComputerProof).toMatchObject({
      evidenceRefs: [expect.objectContaining({ ref: result.outputPath })],
    });
  });

  it('显式 outputPath 原样使用（相对路径行为不变）', async () => {
    const result = await screenshotTool.execute(
      { analyze: false, outputPath: '/tmp/work/.screenshots/manual.png' },
      makeCtx({ workingDirectory: '/tmp/work' }),
    );

    expect(result.success).toBe(true);
    expect(result.outputPath).toBe('/tmp/work/.screenshots/manual.png');
    expect(execMock.mock.calls[0][0]).toContain('/tmp/work/.screenshots/manual.png');
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
