// ============================================================================
// image_generate (native ToolModule) Tests — P1 Wave 4 D2c
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/host/protocol/tools';

const { existsSyncMock, mkdirSyncMock, writeFileSyncMock } = vi.hoisted(() => ({
  existsSyncMock: vi.fn().mockReturnValue(true),
  mkdirSyncMock: vi.fn(),
  writeFileSyncMock: vi.fn(),
}));

vi.mock('fs', () => ({
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
  mkdirSync: (...args: unknown[]) => mkdirSyncMock(...args),
  writeFileSync: (...args: unknown[]) => writeFileSyncMock(...args),
}));

const { getConfigServiceMock, getAuthServiceMock } = vi.hoisted(() => ({
  getConfigServiceMock: vi.fn(),
  getAuthServiceMock: vi.fn(),
}));

vi.mock('../../../../../src/host/services', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

vi.mock('../../../../../src/host/services/core/configService', () => ({
  getConfigService: () => getConfigServiceMock(),
}));

vi.mock('../../../../../src/host/services/auth/authService', () => ({
  getAuthService: () => getAuthServiceMock(),
}));

const { safeExecDetachedMock } = vi.hoisted(() => ({
  safeExecDetachedMock: vi.fn(),
}));

vi.mock('../../../../../src/host/utils/safeShell', () => ({
  safeExecDetached: (...args: unknown[]) => safeExecDetachedMock(...args),
}));

import { imageGenerateModule, executeImageGenerate } from '../../../../../src/host/plugins/builtin/imageCreation/imageGenerate';
import { determineImageEngine } from '../../../../../src/host/services/media/imageGenerationService';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: '/tmp/work',
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  } as unknown as ToolContext;
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('image_generate — schema', () => {
  it('declares correct name and category', () => {
    expect(imageGenerateModule.schema.name).toBe('image_generate');
    expect(imageGenerateModule.schema.category).toBe('network');
    expect(imageGenerateModule.schema.permissionLevel).toBe('network');
  });

  it('requires prompt', () => {
    expect(imageGenerateModule.schema.inputSchema.required).toEqual(['prompt']);
  });
});

describe('image_generate — engine routing', () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ZHIPU_OFFICIAL_API_KEY;
  });
  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('cogview when zhipu official key present', () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'official';
    getConfigServiceMock.mockReturnValue({ getApiKey: vi.fn() });
    expect(determineImageEngine()).toBe('cogview');
  });

  it('flux when only openrouter', () => {
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn((p: string) => (p === 'openrouter' ? 'or' : undefined)),
    });
    expect(determineImageEngine()).toBe('flux');
  });

  it('throws when no API key configured', () => {
    getConfigServiceMock.mockReturnValue({ getApiKey: vi.fn().mockReturnValue(undefined) });
    expect(() => determineImageEngine()).toThrow(/API Key/);
  });
});

describe('image_generate — execute', () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    delete process.env.ZHIPU_OFFICIAL_API_KEY;
    delete process.env.CODE_AGENT_CLI_MODE;
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue(undefined),
    });
    getAuthServiceMock.mockReturnValue({
      getCurrentUser: vi.fn().mockReturnValue({ isAdmin: false }),
    });
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('happy path cogview persists a file artifact by default', async () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'official-key';
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn().mockReturnValue(undefined),
    });

    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // zhipu image gen
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: [{ url: 'https://cdn/img.png' }] }),
        });
      }
      // image download
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      });
    });

    const result = await executeImageGenerate(
      { prompt: '一只猫' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.artifact).toMatchObject({
        kind: 'image',
        sourceTool: 'image_generate',
        path: expect.stringContaining('/tmp/work/.code-agent/artifacts/images/generated-'),
        mimeType: 'image/png',
        sizeBytes: 3,
        metadata: {
          model: 'cogview-4-250304',
          engine: 'cogview',
          aspectRatio: '1:1',
          autoPersisted: true,
          mediaLifecycle: {
            kind: 'generated-image',
            operation: 'generate',
            ownerSessionId: 'test-session',
            sourcePrompt: '一只猫',
            fallbackStrategy: 'file-artifact',
          },
        },
      });
      expect(writeFileSyncMock).toHaveBeenCalled();
      expect(result.meta?.engine).toBe('cogview');
      expect(result.meta?.model).toBe('cogview-4-250304');
      expect(result.meta?.imageBase64).toBeUndefined();
      expect(result.meta?.imagePath).toContain('/tmp/work/.code-agent/artifacts/images/generated-');
    }
  });

  it('saves to file when output_path given', async () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'official-key';
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: [{ url: 'https://cdn/img.png' }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      });
    });

    const result = await executeImageGenerate(
      { prompt: 'cat', output_path: '/tmp/work/out.png' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(writeFileSyncMock).toHaveBeenCalled();
    if (result.ok) {
      expect(result.meta?.artifact).toMatchObject({
        kind: 'image',
        sourceTool: 'image_generate',
        path: '/tmp/work/out.png',
        mimeType: 'image/png',
        sizeBytes: 1,
        metadata: {
          model: 'cogview-4-250304',
          engine: 'cogview',
          aspectRatio: '1:1',
          mediaLifecycle: {
            kind: 'generated-image',
            operation: 'generate',
            ownerSessionId: 'test-session',
            sourcePrompt: 'cat',
            fallbackStrategy: 'file-artifact',
          },
        },
      });
      expect(result.meta?.imagePath).toBe('/tmp/work/out.png');
      expect(result.meta?.imageBase64).toBeUndefined();
    }
  });

  it('admin user gets FLUX Pro model', async () => {
    getConfigServiceMock.mockReturnValue({
      getApiKey: vi.fn((p: string) => (p === 'openrouter' ? 'or-key' : undefined)),
    });
    getAuthServiceMock.mockReturnValue({
      getCurrentUser: vi.fn().mockReturnValue({ isAdmin: true }),
    });

    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            images: [{ image_url: { url: 'data:image/png;base64,xyz' } }],
          },
        }],
      }),
    });

    const result = await executeImageGenerate(
      { prompt: 'test' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta?.engine).toBe('flux');
      expect(result.meta?.model).toBe('black-forest-labs/flux.2-pro');
      expect(result.meta?.isAdmin).toBe(true);
    }
  });

  it('rejects when canUseTool denies', async () => {
    const result = await executeImageGenerate(
      { prompt: 'cat' },
      makeCtx(),
      async () => ({ allow: false, reason: 'no perm' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PERMISSION_DENIED');
    }
  });

  it('rejects pre-aborted signal', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const result = await executeImageGenerate(
      { prompt: 'cat' },
      makeCtx({ abortSignal: ctrl.signal }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('ABORTED');
    }
  });

  it('rejects missing prompt', async () => {
    const result = await executeImageGenerate({}, makeCtx(), allowAll);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('INVALID_ARGS');
    }
  });

  it('returns failure when API errors', async () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'official-key';
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => 'server error',
    });

    const result = await executeImageGenerate(
      { prompt: 'cat' },
      makeCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // 失败收口（工单 2026-07-31）：复述句已经说出去了，失败陈述必须回指它——
      // 带上当时承诺的比例和原话，并据实说磁盘上没有新图，而不是只丢一句「图片生成失败」。
      expect(result.error).toContain('cat');
      expect(result.error).toContain('1:1');
      expect(result.error).toContain('没有出成');
      expect(result.error).toContain('没有生成，磁盘上没有新图');
      expect(result.error).toContain('server error');
    }
  });

  it('emits onProgress', async () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'k';
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: [{ url: 'https://cdn/i.png' }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      });
    });
    const onProgress = vi.fn();
    await executeImageGenerate(
      { prompt: 'cat' },
      makeCtx(),
      allowAll,
      onProgress,
    );
    expect(onProgress).toHaveBeenCalledWith({ stage: 'starting', detail: 'image_generate' });
    expect(onProgress).toHaveBeenCalledWith({ stage: 'completing', percent: 100 });
  });

  it('CLI mode auto-generates output_path and triggers safeExecDetached', async () => {
    process.env.ZHIPU_OFFICIAL_API_KEY = 'k';
    process.env.CODE_AGENT_CLI_MODE = 'true';
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          ok: true,
          json: async () => ({ data: [{ url: 'https://cdn/i.png' }] }),
        });
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => new Uint8Array([1]).buffer,
      });
    });

    const result = await executeImageGenerate(
      { prompt: 'cat' },
      makeCtx(),
      allowAll,
    );

    expect(result.ok).toBe(true);
    expect(safeExecDetachedMock).toHaveBeenCalled();
    if (result.ok) {
      expect(result.meta?.imagePath).toMatch(/generated-/);
    }
  });
});

// ============================================================================
// 出图前复述句 / 出图后验收句 / 失败收口（工单 2026-07-31 路径 A）
//
// 承重点有三个，都在这里钉死：
//  ① 复述句必须发生在**任何**付费 fetch 之前（否则「掏钱前叫停」无从谈起）
//  ② 验收句只说可核对的数字，且不含任何可被润色成「已完成」的状态词
//  ③ 送给出图模型的 prompt 与改动前逐字节一致——复述是回显，不是新一层 prompt 加工
// ============================================================================

/** 造一个带 IHDR 的最小 PNG，让验收句能读出真实像素。 */
function pngBytes(width: number, height: number): Uint8Array {
  const buf = new Uint8Array(64);
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(buf.buffer);
  view.setUint32(16, width, false);
  view.setUint32(20, height, false);
  return buf;
}

describe('image_generate — 复述/验收/失败收口', () => {
  const origEnv = { ...process.env };
  /** 按发生顺序记录「事件」和「网络调用」，用来判定复述句确实早于付费调用。 */
  let timeline: string[];
  let emitted: string[];
  let requestBodies: Array<Record<string, unknown>>;

  function makeNarrationCtx(): ToolContext {
    return makeCtx({
      currentToolCallId: 'call-1',
      emit: (event: unknown) => {
        const e = event as { type: string; data?: { content?: string } };
        if (e.type !== 'tool_output_delta' || !e.data?.content) return;
        timeline.push('emit');
        emitted.push(e.data.content);
      },
    } as Partial<ToolContext>);
  }

  function mockGeneration(dims = { width: 720, height: 1280 }): void {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      callCount++;
      timeline.push('fetch');
      if (typeof init?.body === 'string') {
        requestBodies.push(JSON.parse(init.body) as Record<string, unknown>);
      }
      if (callCount === 1) {
        return Promise.resolve({ ok: true, json: async () => ({ data: [{ url: 'https://cdn/img.png' }] }) });
      }
      return Promise.resolve({
        ok: true,
        headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => pngBytes(dims.width, dims.height).buffer,
      });
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    timeline = [];
    emitted = [];
    requestBodies = [];
    existsSyncMock.mockReturnValue(true);
    delete process.env.CODE_AGENT_CLI_MODE;
    process.env.ZHIPU_OFFICIAL_API_KEY = 'official-key';
    getConfigServiceMock.mockReturnValue({ getApiKey: vi.fn().mockReturnValue(undefined) });
    getAuthServiceMock.mockReturnValue({ getCurrentUser: vi.fn().mockReturnValue({ isAdmin: false }) });
  });

  afterEach(() => {
    process.env = { ...origEnv };
  });

  it('复述句先于任何付费网络调用发出', async () => {
    mockGeneration();
    await executeImageGenerate({ prompt: '一只柯基', aspect_ratio: '9:16' }, makeNarrationCtx(), allowAll);
    expect(timeline[0]).toBe('emit');
    expect(timeline).toContain('fetch');
    expect(timeline.indexOf('emit')).toBeLessThan(timeline.indexOf('fetch'));
  });

  it('复述句回显用户原话、比例朝向、模型、落点，并给出可叫停提示', async () => {
    mockGeneration();
    await executeImageGenerate(
      { prompt: '一只柯基', aspect_ratio: '9:16', style: 'photo' },
      makeNarrationCtx(),
      allowAll,
    );
    const briefing = emitted[0];
    expect(briefing).toContain('一只柯基');
    expect(briefing).toContain('9:16 竖版');
    expect(briefing).toContain('CogView-4');
    expect(briefing).toContain('写实照片');
    expect(briefing).toContain('.code-agent/artifacts/images/generated-');
    expect(briefing).toContain('打断');
  });

  it('未开扩写时复述句明说「原样送给出图模型」，开了才说会先扩写', async () => {
    mockGeneration();
    await executeImageGenerate({ prompt: 'cat' }, makeNarrationCtx(), allowAll);
    expect(emitted[0]).toContain('原样送给出图模型');
    expect(emitted[0]).not.toContain('扩写成出图提示词');
  });

  it('验收句给出落盘 PNG 的实测像素并判定与所要比例相符', async () => {
    mockGeneration({ width: 720, height: 1280 });
    const result = await executeImageGenerate(
      { prompt: '一只柯基', aspect_ratio: '9:16' },
      makeNarrationCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('720×1280');
    expect(result.output).toContain('与你要的 9:16 相符');
    expect(result.output).toContain('cogview-4-250304');
    expect(result.output).toContain('.code-agent/artifacts/images/generated-');
  });

  it('出图模型没按比例出时，验收句必须点破而不是糊过去', async () => {
    mockGeneration({ width: 1024, height: 1024 });
    const result = await executeImageGenerate(
      { prompt: '一只柯基', aspect_ratio: '9:16' },
      makeNarrationCtx(),
      allowAll,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.output).toContain('1024×1024');
    expect(result.output).toContain('不符');
    expect(result.output).toContain('没按比例出');
  });

  it('反套话门：验收句不含任何可被润色成「已完成」的状态词', async () => {
    mockGeneration();
    const result = await executeImageGenerate({ prompt: 'cat' }, makeNarrationCtx(), allowAll);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    for (const word of ['图片生成成功', '已完成', '操作成功', '已生成']) {
      expect(result.output).not.toContain(word);
    }
    // 且必须带实测数字，不能是空句
    expect(result.output).toMatch(/\d+×\d+/);
  });

  it('prompt 未被复述句污染：送给出图模型的正是用户原话', async () => {
    mockGeneration();
    await executeImageGenerate({ prompt: '一只柯基' }, makeNarrationCtx(), allowAll);
    const imageRequest = requestBodies[0];
    // service 层对所有引擎统一追加 NO_TEXT_SUFFIX（既有行为，与本批无关），
    // 所以断言的是「以用户原话开头」+「没有任何复述文案混进去」。
    expect(String(imageRequest.prompt)).toMatch(/^一只柯基/);
    expect(String(imageRequest.prompt).replace(/，画面中不要出现.*$/, '')).toBe('一只柯基');
    const serialized = JSON.stringify(requestBodies);
    expect(serialized).not.toContain('我理解你要的是');
    expect(serialized).not.toContain('打断');
    expect(serialized).not.toContain('对照图核对');
  });

  it('style 仍只经 addStyleSuffix 追加，不掺入复述文案', async () => {
    mockGeneration();
    await executeImageGenerate({ prompt: 'cat', style: 'photo' }, makeNarrationCtx(), allowAll);
    expect(String(requestBodies[0].prompt)).toMatch(
      /^cat, photorealistic, high resolution, professional photography, sharp focus/,
    );
  });

  it('失败收口回指复述句，并据实说磁盘上没有新图', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => 'boom' });
    const result = await executeImageGenerate(
      { prompt: '一只柯基', aspect_ratio: '9:16' },
      makeNarrationCtx(),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(emitted[0]).toContain('一只柯基'); // 复述确实已经说出去了
    expect(result.error).toContain('一只柯基');
    expect(result.error).toContain('9:16 竖版');
    expect(result.error).toContain('没有出成');
    expect(result.error).toContain('磁盘上没有新图');
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });

  it('没有 toolCallId 时静默跳过复述（不崩、不影响出图与验收句）', async () => {
    mockGeneration();
    const result = await executeImageGenerate(
      { prompt: 'cat' },
      makeCtx({ emit: () => { timeline.push('emit'); } } as Partial<ToolContext>),
      allowAll,
    );
    expect(timeline).not.toContain('emit');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.output).toContain('×');
  });
});

describe('image_generate — 扩写静默回退必须当场更正', () => {
  const origEnv = { ...process.env };
  beforeEach(() => {
    vi.clearAllMocks();
    existsSyncMock.mockReturnValue(true);
    process.env.ZHIPU_OFFICIAL_API_KEY = 'official-key';
    getConfigServiceMock.mockReturnValue({ getApiKey: vi.fn().mockReturnValue('zhipu-key') });
    getAuthServiceMock.mockReturnValue({ getCurrentUser: vi.fn().mockReturnValue({ isAdmin: false }) });
  });
  afterEach(() => { process.env = { ...origEnv }; });

  function ctxCollecting(out: string[]): ToolContext {
    return makeCtx({
      currentToolCallId: 'c1',
      emit: (event: unknown) => {
        const e = event as { type: string; data?: { content?: string } };
        if (e.type === 'tool_output_delta' && e.data?.content) out.push(e.data.content);
      },
    } as Partial<ToolContext>);
  }

  /** 扩写调用失败（模拟 key 过期 401），图片调用成功。 */
  function mockExpandFailsThenImageOk(): void {
    let n = 0;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      n++;
      if (String(url).includes('chat/completions')) {
        return Promise.resolve({ ok: false, status: 401, text: async () => 'token expired' });
      }
      if (n <= 2) {
        return Promise.resolve({ ok: true, json: async () => ({ data: [{ url: 'https://cdn/img.png' }] }) });
      }
      return Promise.resolve({
        ok: true, headers: new Headers({ 'content-type': 'image/png' }),
        arrayBuffer: async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
          0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 2, 208, 0, 0, 5, 0]).buffer,
      });
    });
  }

  it('扩写静默失败时，复述里「会先扩写」的承诺必须被当场更正', async () => {
    const out: string[] = [];
    mockExpandFailsThenImageOk();
    const result = await executeImageGenerate(
      { prompt: '一只柯基', expand_prompt: true },
      ctxCollecting(out),
      allowAll,
    );
    expect(result.ok).toBe(true);
    expect(out[0]).toContain('会先让文本模型把这句话扩写成出图提示词');
    expect(out.join('\n')).toContain('更正：扩写没成功');
  });

  it('没开扩写时不会冒出更正句（不制造假更正）', async () => {
    const out: string[] = [];
    mockExpandFailsThenImageOk();
    await executeImageGenerate({ prompt: '一只柯基' }, ctxCollecting(out), allowAll);
    expect(out.join('\n')).not.toContain('更正');
  });
});
