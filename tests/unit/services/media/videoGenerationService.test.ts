import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getApiKeyMock } = vi.hoisted(() => ({ getApiKeyMock: vi.fn() }));
vi.mock('../../../../src/host/services/core/configService', () => ({
  getConfigService: () => ({ getApiKey: getApiKeyMock }),
}));

import { generateVideo, downloadVideoAsBuffer } from '../../../../src/host/services/media/videoGenerationService';

function jsonResponse(obj: unknown): Response {
  return { ok: true, status: 200, json: async () => obj, text: async () => JSON.stringify(obj) } as unknown as Response;
}

interface CapturedCall { url: string; body?: Record<string, unknown>; headers?: Record<string, string>; }

function installFetchMock(videoUrl = 'https://oss.example.com/out.mp4'): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, headers: init?.headers as Record<string, string> });
    if (url.includes('/tasks/')) {
      return jsonResponse({ output: { task_status: 'SUCCEEDED', video_url: videoUrl } });
    }
    return jsonResponse({ output: { task_id: 'task-vid-1', task_status: 'PENDING' } });
  }) as unknown as typeof fetch;
  return calls;
}

beforeEach(() => {
  getApiKeyMock.mockReset();
  getApiKeyMock.mockReturnValue('sk-dashscope-test');
  delete process.env.DASHSCOPE_API_KEY;
});

describe('generateVideo — t2v', () => {
  it('提交到视频端点，body 形如 {model,input:{prompt},parameters:{resolution,duration}}，解析 output.video_url', { timeout: 30000 }, async () => {
    const calls = installFetchMock();
    const res = await generateVideo({ model: 'wan2.7-t2v', mode: 't2v', prompt: '一只猫在跑', durationSec: 8 });
    expect(res.url).toBe('https://oss.example.com/out.mp4');
    expect(res.actualModel).toBe('wan2.7-t2v');
    expect(res.durationSec).toBe(8);
    const submit = calls[0];
    expect(submit.url).toContain('/services/aigc/video-generation/video-synthesis');
    expect(submit.headers?.['X-DashScope-Async']).toBe('enable');
    expect(submit.body).toMatchObject({
      model: 'wan2.7-t2v',
      input: { prompt: '一只猫在跑' },
      parameters: { duration: 8 },
    });
    expect((submit.body?.parameters as Record<string, unknown>).resolution).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/tasks/task-vid-1'))).toBe(true);
  });
});

describe('generateVideo — i2v', () => {
  it('底图走 input.img_url，prompt 可选，时长按固定模型 clamp 到 5s', { timeout: 30000 }, async () => {
    const calls = installFetchMock();
    const res = await generateVideo({
      model: 'wanx2.1-i2v-turbo',
      mode: 'i2v',
      imageDataUrl: 'data:image/png;base64,AAAA',
      durationSec: 12,
    });
    expect(res.durationSec).toBe(5);
    expect(calls[0].body).toMatchObject({
      model: 'wanx2.1-i2v-turbo',
      input: { img_url: 'data:image/png;base64,AAAA' },
    });
  });

  it('i2v 缺底图直接抛错，不发起任何请求（防付费空调用）', async () => {
    const calls = installFetchMock();
    await expect(generateVideo({ model: 'wanx2.1-i2v-turbo', mode: 'i2v' })).rejects.toThrow();
    expect(calls.length).toBe(0);
  });
});

describe('generateVideo — 守门与失败', () => {
  it('未知模型抛错，不发起请求', async () => {
    const calls = installFetchMock();
    await expect(generateVideo({ model: 'no-such', mode: 't2v', prompt: 'x' })).rejects.toThrow();
    expect(calls.length).toBe(0);
  });

  it('缺 key 抛可读错误，不发起请求', async () => {
    getApiKeyMock.mockReturnValue(undefined);
    const calls = installFetchMock();
    await expect(generateVideo({ model: 'wan2.7-t2v', mode: 't2v', prompt: 'x' })).rejects.toThrow(/DashScope|百炼|Key/);
    expect(calls.length).toBe(0);
  });

  it('任务 FAILED 抛错', { timeout: 30000 }, async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/tasks/')) return jsonResponse({ output: { task_status: 'FAILED', message: 'boom' } });
      return jsonResponse({ output: { task_id: 't1', task_status: 'PENDING' } });
    }) as unknown as typeof fetch;
    await expect(generateVideo({ model: 'wan2.7-t2v', mode: 't2v', prompt: 'x' })).rejects.toThrow(/FAILED|boom/);
  });
});

describe('generateVideo — 提交即终态（Fix A）', () => {
  it('提交即返回 FAILED 状态：抛出该 message，不进入轮询', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return { ok: true, status: 200, json: async () => ({ output: { task_status: 'FAILED', message: '内容审核未通过' } }), text: async () => '' } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(generateVideo({ model: 'wan2.7-t2v', mode: 't2v', prompt: 'x' })).rejects.toThrow(/内容审核未通过|FAILED/);
    // 只发了提交那一次，没有进入 /tasks/ 轮询
    expect(calls.some((u) => u.includes('/tasks/'))).toBe(false);
  });
});

describe('generateVideo — 轮询失败路径（Fix C）', () => {
  it('轮询 CANCELED：抛错', { timeout: 30000 }, async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/tasks/')) return jsonResponse({ output: { task_status: 'CANCELED' } });
      return jsonResponse({ output: { task_id: 't1', task_status: 'PENDING' } });
    }) as unknown as typeof fetch;
    await expect(generateVideo({ model: 'wan2.7-t2v', mode: 't2v', prompt: 'x' })).rejects.toThrow(/CANCELED/);
  });

  it('轮询 UNKNOWN：抛错', { timeout: 30000 }, async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/tasks/')) return jsonResponse({ output: { task_status: 'UNKNOWN' } });
      return jsonResponse({ output: { task_id: 't1', task_status: 'PENDING' } });
    }) as unknown as typeof fetch;
    await expect(generateVideo({ model: 'wan2.7-t2v', mode: 't2v', prompt: 'x' })).rejects.toThrow(/UNKNOWN/);
  });

  it('轮询 SUCCEEDED 但无 video_url：抛错', { timeout: 30000 }, async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/tasks/')) return jsonResponse({ output: { task_status: 'SUCCEEDED' } });
      return jsonResponse({ output: { task_id: 't1', task_status: 'PENDING' } });
    }) as unknown as typeof fetch;
    await expect(generateVideo({ model: 'wan2.7-t2v', mode: 't2v', prompt: 'x' })).rejects.toThrow(/video_url|无/);
  });

  it('提交 HTTP !ok：抛错且不轮询', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return { ok: false, status: 500, json: async () => ({}), text: async () => 'upstream boom' } as unknown as Response;
    }) as unknown as typeof fetch;
    await expect(generateVideo({ model: 'wan2.7-t2v', mode: 't2v', prompt: 'x' })).rejects.toThrow(/500|提交失败/);
    expect(calls.some((u) => u.includes('/tasks/'))).toBe(false);
  });
});

describe('downloadVideoAsBuffer — SSRF 守卫 + 下载', () => {
  it('拒绝非 https / 私网 url，不发起请求', async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    await expect(downloadVideoAsBuffer('http://127.0.0.1/x.mp4')).rejects.toThrow();
    await expect(downloadVideoAsBuffer('https://10.0.0.1/x.mp4')).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('HTTP !ok 抛错', async () => {
    globalThis.fetch = vi.fn(async () => ({ ok: false, status: 500, arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response) as unknown as typeof fetch;
    await expect(downloadVideoAsBuffer('https://oss.example.com/x.mp4')).rejects.toThrow(/500|下载失败/);
  });
  it('happy path 返回视频字节 Buffer', async () => {
    const bytes = new TextEncoder().encode('MP4BYTES');
    globalThis.fetch = vi.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => bytes.buffer }) as unknown as Response) as unknown as typeof fetch;
    const buf = await downloadVideoAsBuffer('https://oss.example.com/x.mp4');
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString()).toBe('MP4BYTES');
  });
});

// ── P3 MiniMax 海螺：按 provider 路由到 submit→query→files/retrieve 三步流程 ──
function installMinimaxFetchMock(downloadUrl = 'https://minimax.example.com/out.mp4'): CapturedCall[] {
  const calls: CapturedCall[] = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url, body, headers: init?.headers as Record<string, string> });
    if (url.includes('/files/retrieve')) {
      return jsonResponse({ file: { download_url: downloadUrl }, base_resp: { status_code: 0, status_msg: 'success' } });
    }
    if (url.includes('/query/video_generation')) {
      return jsonResponse({ status: 'Success', file_id: 'file-123', base_resp: { status_code: 0, status_msg: 'success' } });
    }
    // submit
    return jsonResponse({ task_id: 'mm-task-1', base_resp: { status_code: 0, status_msg: 'success' } });
  }) as unknown as typeof fetch;
  return calls;
}

describe('generateVideo — MiniMax 海螺路由', () => {
  it('t2v(MiniMax-Hailuo-02)：submit→query→retrieve 取 download_url，body 带 model+prompt', { timeout: 30000 }, async () => {
    const calls = installMinimaxFetchMock();
    const res = await generateVideo({ model: 'MiniMax-Hailuo-02', mode: 't2v', prompt: '海边日落' });
    expect(res.url).toBe('https://minimax.example.com/out.mp4');
    expect(res.actualModel).toBe('MiniMax-Hailuo-02');
    const submit = calls[0];
    expect(submit.url).toContain('/video_generation');
    expect(submit.url).not.toContain('/query/'); // 提交不是查询端点
    expect(submit.headers?.Authorization).toMatch(/^Bearer /);
    expect(submit.body).toMatchObject({ model: 'MiniMax-Hailuo-02', prompt: '海边日落' });
    expect(calls.some((c) => c.url.includes('/query/video_generation?task_id=mm-task-1'))).toBe(true);
    expect(calls.some((c) => c.url.includes('/files/retrieve?file_id=file-123'))).toBe(true);
  });

  it('i2v(I2V-01)：底图走 first_frame_image（非 img_url）', { timeout: 30000 }, async () => {
    const calls = installMinimaxFetchMock();
    await generateVideo({ model: 'I2V-01', mode: 'i2v', imageDataUrl: 'data:image/png;base64,AAAA' });
    expect(calls[0].body).toMatchObject({ model: 'I2V-01', first_frame_image: 'data:image/png;base64,AAAA' });
    expect((calls[0].body as Record<string, unknown>).img_url).toBeUndefined();
  });

  it('提交 base_resp.status_code!=0：抛 status_msg，不进入轮询', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (input: unknown) => {
      calls.push(String(input));
      return jsonResponse({ task_id: '', base_resp: { status_code: 2013, status_msg: 'invalid params' } });
    }) as unknown as typeof fetch;
    await expect(generateVideo({ model: 'MiniMax-Hailuo-02', mode: 't2v', prompt: 'x' })).rejects.toThrow(/2013|invalid params/);
    expect(calls.some((u) => u.includes('/query/'))).toBe(false);
  });

  it('查询 Fail：抛错', { timeout: 30000 }, async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/query/video_generation')) return jsonResponse({ status: 'Fail', base_resp: { status_code: 1000, status_msg: 'gen failed' } });
      return jsonResponse({ task_id: 'mm-1', base_resp: { status_code: 0 } });
    }) as unknown as typeof fetch;
    await expect(generateVideo({ model: 'MiniMax-Hailuo-02', mode: 't2v', prompt: 'x' })).rejects.toThrow(/gen failed|失败/);
  });
});
