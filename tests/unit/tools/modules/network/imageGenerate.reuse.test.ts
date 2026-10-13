// ============================================================================
// image_generate 复用账本（N-MEDIA-GEN-IDEMPOTENT-RETRY）
// ============================================================================
// 承重不变量：崩溃恢复 / 自动重试重发相同参数时，已落盘的产物被复用（生成服务零调用、
// 扩写零调用、不再计费）；而模型已看到结果的"再来一张"照常出新图。
// 判定规则的每一支（同 toolCallId 重放 / 无送达 complete / 已 complete / recovered 收口
// 不算送达 / 文件必须完好 / 参数指纹变了不复用）都在这里钉死。
// 复用规则原文见 src/host/plugins/builtin/imageCreation/imageGenerateReuse.ts 顶部注释。

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ToolContext, CanUseToolFn, Logger } from '../../../../../src/host/protocol/tools';

const service = vi.hoisted(() => ({
  determineImageEngine: vi.fn(() => 'cogview' as const),
  generateImage: vi.fn(),
  generateImageFromReference: vi.fn(),
  downloadImageAsBase64: vi.fn(),
  isImageUrl: vi.fn((data: string) => data.startsWith('http')),
}));

const auth = vi.hoisted(() => ({ getCurrentUser: vi.fn(() => ({ isAdmin: false })) }));
const config = vi.hoisted(() => ({ getApiKey: vi.fn(), onSettingsUpdated: vi.fn() }));
const db = vi.hoisted(() => ({ getToolExecutionsBySession: vi.fn(() => [] as unknown[]) }));

vi.mock('../../../../../src/host/services/media/imageGenerationService', () => service);
vi.mock('../../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => auth,
}));
vi.mock('../../../../../src/host/services', () => ({
  getConfigService: () => config,
}));
vi.mock('../../../../../src/host/utils/safeShell', () => ({
  safeExecDetached: vi.fn(),
}));
vi.mock('../../../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => db,
}));

import { executeImageGenerate } from '../../../../../src/host/plugins/builtin/imageCreation/imageGenerate';

/** 带合法 PNG 头（宽@16 高@20）的产物字节：验收句/复用句能读出真实像素。 */
function pngBytes(width = 720, height = 1280): Buffer {
  const buf = Buffer.alloc(64);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}

const PNG_DATA_URL = `data:image/png;base64,${pngBytes().toString('base64')}`;
const SESSION_ID = 'reuse-test-session';

function logger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function ctx(workspace: string, toolCallId: string, controller = new AbortController()): ToolContext {
  return {
    sessionId: SESSION_ID,
    workingDir: workspace,
    abortSignal: controller.signal,
    logger: logger(),
    emit: vi.fn(),
    currentToolCallId: toolCallId,
  } as unknown as ToolContext;
}

const allow: CanUseToolFn = async () => ({ allow: true });

/** 工具执行事件（ToolExecutionEventRecord 的结构子集，按仓储契约：begin 带 toolCallId，complete 只带 executionId）。 */
function setExecutionEvents(
  events: Array<{ executionId: string; toolCallId?: string | null; phase: string; status?: string | null }>,
): void {
  db.getToolExecutionsBySession.mockReturnValue(events);
}

describe('image_generate 复用账本', () => {
  let workspace: string;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'image-generate-reuse-'));
    service.determineImageEngine.mockReturnValue('cogview');
    service.generateImage.mockReset();
    service.generateImageFromReference.mockReset();
    service.downloadImageAsBase64.mockReset();
    service.generateImage.mockImplementation(async () => ({ imageData: PNG_DATA_URL, actualModel: 'mock-model' }));
    service.generateImageFromReference.mockImplementation(async () => ({ imageData: PNG_DATA_URL, actualModel: 'mock-reference-model' }));
    db.getToolExecutionsBySession.mockReset();
    db.getToolExecutionsBySession.mockReturnValue([]);
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    fs.rmSync(workspace, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('①崩溃重放（同 toolCallId）：复用已落盘产物，生成与扩写零调用、不再计费', async () => {
    const args = { prompt: ['一只柯基'], expand_prompt: true };
    fetchSpy.mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'expanded corgi prompt' } }] }),
    } as unknown as Response);

    const first = await executeImageGenerate(args, ctx(workspace, 'call-crash'), allow);
    expect(first.ok).toBe(true);
    expect(service.generateImage).toHaveBeenCalledTimes(1);
    expect(fetchSpy).toHaveBeenCalledTimes(1); // 第一次调用的扩写

    // 崩溃现场：begin 无真实 complete，重启后被 acknowledgeRecovery 以 recovered 收口。
    setExecutionEvents([
      { executionId: 'exec-1', toolCallId: 'call-crash', phase: 'begin' },
      { executionId: 'exec-1', phase: 'complete', status: 'recovered' },
    ]);
    service.generateImage.mockClear();
    fetchSpy.mockClear();

    const replay = await executeImageGenerate(args, ctx(workspace, 'call-crash'), allow);
    expect(replay.ok).toBe(true);
    expect(service.generateImage).not.toHaveBeenCalled();
    expect(service.generateImageFromReference).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled(); // 扩写也整条跳过
    if (!replay.ok) return;
    expect(replay.output).toContain('1/1 saved');
    expect(replay.output).toContain('复用上次生成结果 (reused previous result, no new charge)');
    expect(replay.meta?.reused).toBe(true);
    const perRequest = replay.meta?.per_request as Array<Record<string, unknown>>;
    expect(perRequest[0]).toMatchObject({ index: 1, status: 'saved', reused: true });
    // 复用的是上一次的时间戳路径，不是新路径
    expect(replay.meta?.imagePath).toBe(first.ok ? first.meta?.imagePath : undefined);
  });

  it('①新 toolCallId 且无已送达 complete 事件（自动重试路径）：同样复用，零生成调用', async () => {
    const args = { prompt: ['一只柯基'] };
    const first = await executeImageGenerate(args, ctx(workspace, 'call-A'), allow);
    expect(first.ok).toBe(true);
    expect(service.generateImage).toHaveBeenCalledTimes(1);

    // 无任何 complete 事件：结果从未送达循环（崩溃/打断后模型在新 toolCallId 下重发）
    setExecutionEvents([{ executionId: 'exec-1', toolCallId: 'call-A', phase: 'begin' }]);
    service.generateImage.mockClear();

    const retry = await executeImageGenerate(args, ctx(workspace, 'call-B'), allow);
    expect(retry.ok).toBe(true);
    expect(service.generateImage).not.toHaveBeenCalled();
    if (!retry.ok) return;
    expect(retry.output).toContain('复用上次生成结果');
    expect((retry.meta?.per_request as Array<{ reused?: boolean }>)[0].reused).toBe(true);
  });

  it('②新 toolCallId 且上次调用已 complete（模型看到过结果）：再来一张照常生成', async () => {
    const args = { prompt: ['一只柯基'] };
    const first = await executeImageGenerate(args, ctx(workspace, 'call-A'), allow);
    expect(first.ok).toBe(true);

    setExecutionEvents([
      { executionId: 'exec-1', toolCallId: 'call-A', phase: 'begin' },
      { executionId: 'exec-1', phase: 'complete', status: 'success' },
    ]);

    const another = await executeImageGenerate(args, ctx(workspace, 'call-B'), allow);
    expect(another.ok).toBe(true);
    expect(service.generateImage).toHaveBeenCalledTimes(2);
    if (!another.ok || !first.ok) return;
    expect(another.output).not.toContain('复用上次生成结果');
    expect(another.meta?.reused).toBeUndefined();
    expect((another.meta?.per_request as Array<{ reused?: boolean }>)[0].reused).toBeUndefined();
    // 新图走新路径（默认时间戳路径），不是同一张
    expect(another.meta?.imagePath).not.toBe(first.meta?.imagePath);
  });

  it('②recovered 收口不算"已送达"：崩溃恢复后新 toolCallId 的重试仍复用', async () => {
    const args = { prompt: ['一只柯基'] };
    await executeImageGenerate(args, ctx(workspace, 'call-A'), allow);
    setExecutionEvents([
      { executionId: 'exec-1', toolCallId: 'call-A', phase: 'begin' },
      { executionId: 'exec-1', phase: 'complete', status: 'recovered' },
    ]);
    service.generateImage.mockClear();

    const retry = await executeImageGenerate(args, ctx(workspace, 'call-B'), allow);
    expect(retry.ok).toBe(true);
    expect(service.generateImage).not.toHaveBeenCalled();
  });

  it('②参数变了（prompt/比例/风格/参考图内容）就是新请求：不复用，重新生成', async () => {
    fs.writeFileSync(path.join(workspace, 'ref.png'), 'reference-content-v1');
    const base = { prompt: ['一只柯基'], aspect_ratio: '1:1' };
    expect((await executeImageGenerate(base, ctx(workspace, 'c1'), allow)).ok).toBe(true);

    // 换 prompt
    expect((await executeImageGenerate({ ...base, prompt: ['一只柴犬'] }, ctx(workspace, 'c2'), allow)).ok).toBe(true);
    // 换比例
    expect((await executeImageGenerate({ ...base, aspect_ratio: '16:9' }, ctx(workspace, 'c3'), allow)).ok).toBe(true);
    // 换风格
    expect((await executeImageGenerate({ ...base, style: 'photo' }, ctx(workspace, 'c4'), allow)).ok).toBe(true);
    // 参考图：首次带参考图，之后仅改变参考图内容
    const refArgs = { prompt: ['参照图画一张'], reference_images: ['ref.png'] };
    const refFirst = await executeImageGenerate(refArgs, ctx(workspace, 'c5'), allow);
    expect(refFirst.ok).toBe(true);
    expect(service.generateImageFromReference).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(workspace, 'ref.png'), 'reference-content-v2-different');
    const refSecond = await executeImageGenerate(refArgs, ctx(workspace, 'c6'), allow);
    expect(refSecond.ok).toBe(true);
    expect(service.generateImageFromReference).toHaveBeenCalledTimes(2); // 内容变了 → 重新生成

    expect(service.generateImage).toHaveBeenCalledTimes(4); // c1-c4，参考图两次走 fromReference
  });

  it('②产物文件被删或大小变化：不复用，重新生成', async () => {
    const args = { prompt: ['一只柯基'], output_file_path: 'images/out.png' };
    expect((await executeImageGenerate(args, ctx(workspace, 'call-A'), allow)).ok).toBe(true);
    const savedPath = path.join(workspace, 'images/out.png');
    expect(fs.existsSync(savedPath)).toBe(true);

    // 删除文件 → 同 toolCallId 重放也不能复用不存在的产物
    fs.rmSync(savedPath);
    service.generateImage.mockClear();
    const afterDelete = await executeImageGenerate(args, ctx(workspace, 'call-A'), allow);
    expect(afterDelete.ok).toBe(true);
    expect(service.generateImage).toHaveBeenCalledTimes(1);

    // 大小变了（内容被覆盖成更长的文件）→ 视为产物失真，重新生成
    fs.writeFileSync(savedPath, Buffer.concat([pngBytes(100, 100), Buffer.alloc(32)]));
    service.generateImage.mockClear();
    const afterResize = await executeImageGenerate(args, ctx(workspace, 'call-A'), allow);
    expect(afterResize.ok).toBe(true);
    expect(service.generateImage).toHaveBeenCalledTimes(1);
    if (!afterResize.ok) return;
    expect(afterResize.output).not.toContain('复用上次生成结果');
  });

  it('③部分批次：已保存的条目复用，只有缺失的条目生成', async () => {
    const args = { prompt: ['one', 'two'], output_file_path: 'images/batch.png' };
    // 第一次：'two' 失败，'one' 落盘并记账（批次中途失败的崩溃现场粒度）
    service.generateImage.mockImplementation(async (_engine: unknown, _model: unknown, prompt: string) => {
      if (prompt.startsWith('two')) throw new Error('mock failure');
      return { imageData: PNG_DATA_URL, actualModel: 'mock-model' };
    });
    const first = await executeImageGenerate(args, ctx(workspace, 'call-A'), allow);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.output).toMatch(/^1\/2 saved/);
    const firstPath = (first.meta?.per_request as Array<{ path?: string }>)[0].path;

    // 修复故障后同 toolCallId 重放：one 复用，two 生成
    service.generateImage.mockImplementation(async () => ({ imageData: PNG_DATA_URL, actualModel: 'mock-model' }));
    service.generateImage.mockClear();
    const replay = await executeImageGenerate(args, ctx(workspace, 'call-A'), allow);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.output).toMatch(/^2\/2 saved/);
    expect(service.generateImage).toHaveBeenCalledTimes(1);
    expect(service.generateImage).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'two',
      expect.anything(),
      expect.anything(),
    );
    const perRequest = replay.meta?.per_request as Array<Record<string, unknown>>;
    expect(perRequest[0]).toMatchObject({ index: 1, status: 'saved', path: firstPath, reused: true });
    expect(perRequest[1]).toMatchObject({ index: 2, status: 'saved' });
    expect(perRequest[1].reused).toBeUndefined();
    expect(replay.output).toContain('复用上次生成结果');
  });

  it('③复用时输出与 meta 走既有契约：N/M saved、per_request、artifacts 一应俱全', async () => {
    const args = { prompt: ['一只柯基'] };
    expect((await executeImageGenerate(args, ctx(workspace, 'call-A'), allow)).ok).toBe(true);
    service.generateImage.mockClear();

    const replay = await executeImageGenerate(args, ctx(workspace, 'call-A'), allow);
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.output).toMatch(/^1\/1 saved\nper_request /);
    expect(replay.meta?.artifact).toMatchObject({ kind: 'image', sourceTool: 'image_generate' });
    expect(replay.meta?.artifacts).toHaveLength(1);
    expect(replay.meta?.model).toBe('mock-model'); // 复用不谎报模型
    expect(replay.output).toContain('720×1280'); // 从落盘文件重读的实测像素
    expect(replay.meta).toMatchObject({
      artifact: expect.objectContaining({ metadata: { reused: true } }),
    });
  });
});
