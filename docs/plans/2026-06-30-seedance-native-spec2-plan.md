# Seedance 原生（火山 Ark）视频生成 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Agent Neo 用户经火山方舟 Ark 原生 API 用 Seedance 出视频（t2v/i2v），作为内置视频 provider 第四套范式 `provider: 'ark'`。

**Architecture:** 复用 origin/main 已有视频引擎地基（`generateVideo` 路由 / `VIDEO_MODELS` / `downloadVideoAsBuffer` / 价表）。新增 `submitAndPollArkVideo`（POST `/contents/generations/tasks` → 轮询 `succeeded` → 取 `content.video_url`），在 `generateVideo` 按 `model.provider === 'ark'` 路由。鉴权复用现有 `volcengine`(豆包) provider 的 Ark API Key（账号级，聊天+视频共用），无新配置面。不走桥接/不走 compat flavor。

**Tech Stack:** TypeScript / Node fetch（经 `fetchWithAbort`）/ vitest（`vi.stubGlobal('fetch')`）。

---

## 前置

- 分支：从 `origin/main` 开 `feat/seedance-native`（独立于 Spec 1）。工作树可能有别会话 WIP，**逐文件 `git add`，绝不 `git add -A`**。
- 跑测：`npx vitest run tests/unit/host/<file> -t '<name>'`（本机开 app 可能撞端口，加 `--no-file-parallelism` 若 flaky）。
- 契约/取片字段/状态值见 spec `docs/plans/2026-06-30-seedance-native-spec2.md` §1。

---

### Task 1: VisualProviderId 'ark' + Seedance 内置模型条目

**Files:**
- Modify: `src/shared/constants/visualModels.ts`（`VisualProviderId` 约 line 10；`VIDEO_MODELS` 约 line 70）
- Test: `tests/shared/constants/visualModels.video.test.ts`

- [ ] **Step 1: 写失败测试**

在 `tests/shared/constants/visualModels.video.test.ts` 追加：

```ts
import { describe, it, expect } from 'vitest';
import { videoModelById, videoModelsWithCap, VIDEO_MODELS } from '../../../src/shared/constants/visualModels';

describe('Seedance（ark）内置视频模型', () => {
  it('注册 pro/fast 两条，provider=ark，t2v+i2v 双 cap', () => {
    const pro = videoModelById('doubao-seedance-2-0-260128');
    const fast = videoModelById('doubao-seedance-2-0-fast-260128');
    expect(pro?.provider).toBe('ark');
    expect(fast?.provider).toBe('ark');
    expect(pro?.caps).toEqual(expect.arrayContaining(['t2v', 'i2v']));
    expect(fast?.caps).toEqual(expect.arrayContaining(['t2v', 'i2v']));
  });
  it('Seedance 同时出现在 t2v 和 i2v 列表', () => {
    expect(videoModelsWithCap('t2v').some((m) => m.provider === 'ark')).toBe(true);
    expect(videoModelsWithCap('i2v').some((m) => m.provider === 'ark')).toBe(true);
  });
  it('duration clamp 配置合法（min ≤ default ≤ max）', () => {
    for (const m of VIDEO_MODELS.filter((x) => x.provider === 'ark')) {
      expect(m.minDurationSec).toBeLessThanOrEqual(m.defaultDurationSec);
      expect(m.defaultDurationSec).toBeLessThanOrEqual(m.maxDurationSec);
    }
  });
});
```

- [ ] **Step 2: 跑测看失败**

Run: `npx vitest run tests/shared/constants/visualModels.video.test.ts -t 'Seedance'`
Expected: FAIL（`videoModelById('doubao-seedance-2-0-260128')` 为 undefined / `'ark'` 不在 `VisualProviderId`）

- [ ] **Step 3: 实现**

在 `VisualProviderId` 联合类型追加 `'ark'`：

```ts
export type VisualProviderId = 'dashscope' | 'zhipu' | 'openrouter' | 'gptimage' | 'minimax' | 'custom' | 'ark';
```

在 `VIDEO_MODELS` 数组末尾（`I2V-01` 条目后）追加：

```ts
  // Spec 2：Seedance 原生（火山方舟 Ark）。统一模型，t2v+i2v 同 id；duration 2~12s（dogfood 校准合法档）。
  // ⚠️ model id 带日期戳会轮换，以控制台实际可用 id 为准，轮换时改此常量。
  {
    id: 'doubao-seedance-2-0-260128',
    label: 'Seedance 2.0',
    provider: 'ark',
    caps: ['t2v', 'i2v'],
    minDurationSec: 3,
    maxDurationSec: 12,
    defaultDurationSec: 5,
  },
  {
    id: 'doubao-seedance-2-0-fast-260128',
    label: 'Seedance 2.0 Fast',
    provider: 'ark',
    caps: ['t2v', 'i2v'],
    minDurationSec: 3,
    maxDurationSec: 12,
    defaultDurationSec: 5,
  },
```

- [ ] **Step 4: 跑测看通过**

Run: `npx vitest run tests/shared/constants/visualModels.video.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/constants/visualModels.ts tests/shared/constants/visualModels.video.test.ts
git commit -m "feat(video): 注册 Seedance（ark）内置视频模型 + VisualProviderId 加 ark"
```

---

### Task 2: getArkApiKey（复用 volcengine 槽）

**Files:**
- Modify: `src/host/services/media/imageGenerationService.ts`（紧邻 `getMinimaxApiKey` 约 line 149）
- Test: `tests/unit/services/media/imageGenerationService.test.ts`

- [ ] **Step 1: 写失败测试**

追加：

```ts
import { getArkApiKey } from '../../../../src/host/services/media/imageGenerationService';

describe('getArkApiKey', () => {
  const orig = process.env.ARK_API_KEY;
  afterEach(() => { if (orig === undefined) delete process.env.ARK_API_KEY; else process.env.ARK_API_KEY = orig; });
  it('env ARK_API_KEY 优先', () => {
    process.env.ARK_API_KEY = 'env-ark-key';
    expect(getArkApiKey()).toBe('env-ark-key');
  });
});
```

> 注：`afterEach` 需从 vitest import；若该测试文件已 import 则复用。

- [ ] **Step 2: 跑测看失败**

Run: `npx vitest run tests/unit/services/media/imageGenerationService.test.ts -t 'getArkApiKey'`
Expected: FAIL（`getArkApiKey` 未导出）

- [ ] **Step 3: 实现**

在 `getMinimaxApiKey` 之后追加（对齐 gptimage 的 env-优先范式；复用现有 `getConfigService`）：

```ts
/**
 * 火山方舟 Ark API Key（Seedance 视频用）。Ark Key 账号级、聊天+视频共用，
 * 复用现有 volcengine(豆包) provider 的 key 槽，无需二次配置。env 优先回落。
 * 注意：这是 Ark API Key（Bearer），不是 AK/SK 签名凭据。
 */
export function getArkApiKey(): string | undefined {
  return process.env.ARK_API_KEY || getConfigService().getApiKey('volcengine') || undefined;
}
```

- [ ] **Step 4: 跑测看通过**

Run: `npx vitest run tests/unit/services/media/imageGenerationService.test.ts -t 'getArkApiKey'`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/host/services/media/imageGenerationService.ts tests/unit/services/media/imageGenerationService.test.ts
git commit -m "feat(video): getArkApiKey 复用 volcengine 槽（Ark Key 聊天+视频共用）"
```

---

### Task 3: Ark 视频引擎 parseArkVideoTask + submitAndPollArkVideo

**Files:**
- Modify: `src/host/services/media/videoGenerationService.ts`（新增两个函数 + 常量；放在 MiniMax 段之后、`generateVideo` 之前）
- Test: `tests/unit/host/arkVideo.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

新建 `tests/unit/host/arkVideo.test.ts`：

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { submitAndPollArkVideo, parseArkVideoTask } from '../../../src/host/services/media/videoGenerationService';

function stubFetch(responses: any[], calls: { url: string; body?: string }[]) {
  vi.stubGlobal('fetch', vi.fn((url: string, init?: any) => {
    calls.push({ url: String(url), body: init?.body });
    return Promise.resolve(responses.shift());
  }));
}

describe('parseArkVideoTask', () => {
  it('抽 id/status/content.video_url', () => {
    const r = parseArkVideoTask({ id: 't1', status: 'succeeded', content: { video_url: 'https://v/u.mp4' } });
    expect(r).toEqual({ id: 't1', status: 'succeeded', url: 'https://v/u.mp4', message: undefined });
  });
  it('非对象返回空', () => {
    expect(parseArkVideoTask(null)).toEqual({});
  });
});

describe('submitAndPollArkVideo', () => {
  const sig = new AbortController().signal;
  afterEach(() => vi.unstubAllGlobals());

  it('t2v：建任务→poll→取 content.video_url；body 为结构化字段 + 仅 text 项', async () => {
    const calls: { url: string; body?: string }[] = [];
    stubFetch([
      { ok: true, json: async () => ({ id: 'task1' }) },
      { ok: true, json: async () => ({ id: 'task1', status: 'succeeded', content: { video_url: 'https://v/u.mp4' } }) },
    ], calls);
    const r = await submitAndPollArkVideo('ark-key',
      { model: 'doubao-seedance-2-0-260128', mode: 't2v', prompt: 'a cat', durationSec: 5 },
      sig, { pollIntervalMs: 1 });
    expect(r.url).toBe('https://v/u.mp4');
    const body = JSON.parse(calls[0].body!);
    expect(calls[0].url).toContain('/contents/generations/tasks');
    expect(body.model).toBe('doubao-seedance-2-0-260128');
    expect(body.content).toEqual([{ type: 'text', text: 'a cat' }]);
    expect(body.duration).toBe(5);
    expect(body.watermark).toBe(false);
    expect(typeof body.resolution).toBe('string');
  });

  it('i2v：content 带 image_url 项', async () => {
    const calls: { url: string; body?: string }[] = [];
    stubFetch([
      { ok: true, json: async () => ({ id: 'task2' }) },
      { ok: true, json: async () => ({ id: 'task2', status: 'succeeded', content: { video_url: 'https://v/i.mp4' } }) },
    ], calls);
    await submitAndPollArkVideo('ark-key',
      { model: 'doubao-seedance-2-0-260128', mode: 'i2v', prompt: 'move', imageDataUrl: 'data:image/png;base64,AAA', durationSec: 5 },
      sig, { pollIntervalMs: 1 });
    const body = JSON.parse(calls[0].body!);
    expect(body.content).toContainEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } });
  });

  it('status=failed → 抛错', async () => {
    stubFetch([
      { ok: true, json: async () => ({ id: 't' }) },
      { ok: true, json: async () => ({ id: 't', status: 'failed', error: { message: 'nsfw' } }) },
    ], []);
    await expect(submitAndPollArkVideo('k', { model: 'm', mode: 't2v', prompt: 'x', durationSec: 5 }, sig, { pollIntervalMs: 1 }))
      .rejects.toThrow();
  });

  it('status=expired → 抛错', async () => {
    stubFetch([
      { ok: true, json: async () => ({ id: 't' }) },
      { ok: true, json: async () => ({ id: 't', status: 'expired' }) },
    ], []);
    await expect(submitAndPollArkVideo('k', { model: 'm', mode: 't2v', prompt: 'x', durationSec: 5 }, sig, { pollIntervalMs: 1 }))
      .rejects.toThrow();
  });

  it('succeeded 但缺 video_url → 抛错', async () => {
    stubFetch([
      { ok: true, json: async () => ({ id: 't' }) },
      { ok: true, json: async () => ({ id: 't', status: 'succeeded', content: {} }) },
    ], []);
    await expect(submitAndPollArkVideo('k', { model: 'm', mode: 't2v', prompt: 'x', durationSec: 5 }, sig, { pollIntervalMs: 1 }))
      .rejects.toThrow();
  });

  it('建任务未返回 id → 抛错', async () => {
    stubFetch([{ ok: true, json: async () => ({}) }], []);
    await expect(submitAndPollArkVideo('k', { model: 'm', mode: 't2v', prompt: 'x', durationSec: 5 }, sig, { pollIntervalMs: 1 }))
      .rejects.toThrow();
  });

  it('建任务 HTTP 非 2xx → 抛错', async () => {
    stubFetch([{ ok: false, status: 401, text: async () => 'unauthorized' }], []);
    await expect(submitAndPollArkVideo('bad', { model: 'm', mode: 't2v', prompt: 'x', durationSec: 5 }, sig, { pollIntervalMs: 1 }))
      .rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测看失败**

Run: `npx vitest run tests/unit/host/arkVideo.test.ts`
Expected: FAIL（`submitAndPollArkVideo` / `parseArkVideoTask` 未导出）

- [ ] **Step 3: 实现**

在 `src/host/services/media/videoGenerationService.ts` 的 MiniMax 段之后、`generateVideo` 之前插入：

```ts
// ── Spec 2 Seedance 原生（火山方舟 Ark · 异步任务 contents/generations/tasks） ──
const ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
const ARK_TASKS_PATH = '/contents/generations/tasks';
const ARK_CREATE_TIMEOUT_MS = 120000; // 异步建任务可能慢，仿 compat 放宽（不动共享 SUBMIT 30s）
const ARK_DEFAULT_RESOLUTION = '720p';
const ARK_DEFAULT_RATIO = '16:9';

export interface ArkVideoArgs {
  model: string;
  mode: 't2v' | 'i2v';
  prompt?: string;
  imageDataUrl?: string;
  durationSec: number;
  resolution?: string;
  ratio?: string;
}

/** 解析 Ark 任务返回：建任务态有 id；轮询态有 status + content.video_url。 */
export function parseArkVideoTask(value: unknown): { id?: string; status?: string; url?: string; message?: string } {
  if (!isRecord(value)) return {};
  const id = typeof value.id === 'string' ? value.id : undefined;
  const status = typeof value.status === 'string' ? value.status : undefined;
  const content = isRecord(value.content) ? value.content : {};
  const url = typeof content.video_url === 'string' ? content.video_url : undefined;
  const err = isRecord(value.error) && typeof value.error.message === 'string' ? value.error.message : undefined;
  const message = err ?? (typeof value.message === 'string' ? value.message : undefined);
  return { id, status, url, message };
}

/**
 * Seedance 原生出片：POST 建任务 → 轮询 status=succeeded → 取 content.video_url。
 * 守门（t2v 需 prompt / i2v 需底图）由上游 generateVideo 统一做；此处只负责编排请求。
 * 火山返回 URL 24h 过期，调用方须立刻 downloadVideoAsBuffer 落 artifact。
 */
export async function submitAndPollArkVideo(
  apiKey: string,
  args: ArkVideoArgs,
  outerSignal: AbortSignal,
  opts?: { pollIntervalMs?: number },
): Promise<{ url: string }> {
  const content: Array<Record<string, unknown>> = [{ type: 'text', text: args.prompt ?? '' }];
  if (args.mode === 'i2v' && args.imageDataUrl) {
    content.push({ type: 'image_url', image_url: { url: args.imageDataUrl } });
  }
  const body = {
    model: args.model,
    content,
    resolution: args.resolution ?? ARK_DEFAULT_RESOLUTION,
    ratio: args.ratio ?? ARK_DEFAULT_RATIO,
    duration: args.durationSec,
    watermark: false,
  };

  const createRes = await fetchWithAbort(
    `${ARK_BASE}${ARK_TASKS_PATH}`,
    {
      method: 'POST',
      redirect: 'manual',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    ARK_CREATE_TIMEOUT_MS,
    outerSignal,
  );
  if (!createRes.ok) throw new Error(`Seedance 视频建任务失败: ${createRes.status} - ${await createRes.text()}`);
  const created = parseArkVideoTask(await createRes.json());
  if (!created.id) throw new Error('Seedance 视频: 未返回 task id');

  const interval = opts?.pollIntervalMs ?? VIDEO_TIMEOUT_MS.POLL_INTERVAL;
  const deadline = Date.now() + VIDEO_TIMEOUT_MS.TOTAL;
  while (Date.now() < deadline) {
    if (outerSignal.aborted) throw new Error('aborted');
    await new Promise((r) => setTimeout(r, interval));
    const pollRes = await fetchWithAbort(
      `${ARK_BASE}${ARK_TASKS_PATH}/${encodeURIComponent(created.id)}`,
      { redirect: 'manual', headers: { Authorization: `Bearer ${apiKey}` } },
      VIDEO_TIMEOUT_MS.POLL,
      outerSignal,
    );
    if (!pollRes.ok) continue; // 瞬时失败继续轮询
    const task = parseArkVideoTask(await pollRes.json());
    if (task.status === 'succeeded') {
      if (!task.url) throw new Error('Seedance 视频: 任务成功但无 content.video_url');
      return { url: task.url };
    }
    if (task.status === 'failed' || task.status === 'expired' || task.status === 'cancelled') {
      throw new Error(`Seedance 视频任务失败: ${task.status}${task.message ? ` - ${task.message}` : ''}`);
    }
    // queued / running → 继续轮询
  }
  throw new Error('Seedance 视频任务超时');
}
```

> `isRecord`、`fetchWithAbort`、`VIDEO_TIMEOUT_MS` 均为本文件已有，直接复用。

- [ ] **Step 4: 跑测看通过**

Run: `npx vitest run tests/unit/host/arkVideo.test.ts`
Expected: PASS（全部用例）

- [ ] **Step 5: 提交**

```bash
git add src/host/services/media/videoGenerationService.ts tests/unit/host/arkVideo.test.ts
git commit -m "feat(video): Seedance 原生引擎 submitAndPollArkVideo + parseArkVideoTask（TDD）"
```

---

### Task 4: generateVideo 'ark' 路由分支

**Files:**
- Modify: `src/host/services/media/videoGenerationService.ts`（`generateVideo`，`provider === 'minimax'` 分支后）+ import 顶部加 `getArkApiKey`
- Test: `tests/unit/host/arkVideo.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

在 `tests/unit/host/arkVideo.test.ts` 追加：

```ts
import { generateVideo } from '../../../src/host/services/media/videoGenerationService';

describe('generateVideo → ark 路由', () => {
  const orig = process.env.ARK_API_KEY;
  beforeEach(() => { process.env.ARK_API_KEY = 'ark-key'; });
  afterEach(() => { vi.unstubAllGlobals(); if (orig === undefined) delete process.env.ARK_API_KEY; else process.env.ARK_API_KEY = orig; });

  it('provider=ark 走 Ark 引擎并回 url + actualModel', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: true, json: async () => ({ id: 'x', status: 'succeeded', content: { video_url: 'https://v/a.mp4' } }) })));
    const r = await generateVideo({ model: 'doubao-seedance-2-0-260128', mode: 't2v', prompt: 'a cat', durationSec: 5 });
    expect(r.url).toBe('https://v/a.mp4');
    expect(r.actualModel).toBe('doubao-seedance-2-0-260128');
  });

  it('缺 key（清空 env + 无配置）抛错且不发请求', async () => {
    delete process.env.ARK_API_KEY;
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await expect(generateVideo({ model: 'doubao-seedance-2-0-260128', mode: 't2v', prompt: 'a cat', durationSec: 5 }))
      .rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
```

> 注：第二个用例假设测试环境无 volcengine 配置（CI/本机默认）。若本机配了 volcengine key，跳过或 mock `getConfigService`。

- [ ] **Step 2: 跑测看失败**

Run: `npx vitest run tests/unit/host/arkVideo.test.ts -t 'ark 路由'`
Expected: FAIL（`generateVideo` 未知 provider 'ark' / 走不到 Ark 引擎）

- [ ] **Step 3: 实现**

文件顶部 import 加 `getArkApiKey`：

```ts
import { getDashscopeApiKey, getMinimaxApiKey, getMinimaxGroupId, getArkApiKey, isSafeImageUrl, fetchWithAbort, WANX_TASKS_PATH } from './imageGenerationService';
```

在 `generateVideo` 里 `if (model.provider === 'minimax') { ... }` 分支之后插入：

```ts
  // Spec 2：Seedance 原生（火山方舟 Ark）。守门已在上方统一做（cap / prompt / 底图）。
  if (model.provider === 'ark') {
    const apiKey = getArkApiKey();
    if (!apiKey) throw new Error('Seedance 视频需要火山方舟 Ark API Key（在 火山引擎/豆包 provider 配置）。');
    const { url } = await submitAndPollArkVideo(
      apiKey,
      { model: model.id, mode: args.mode, prompt: args.prompt, imageDataUrl: args.imageDataUrl, durationSec },
      signal,
    );
    return { url, actualModel: model.id, durationSec };
  }
```

> `durationSec`、`signal`、统一守门（`model.caps.includes` / t2v-prompt / i2v-底图）均为 `generateVideo` 现有逻辑，ark 分支复用。

- [ ] **Step 4: 跑测看通过**

Run: `npx vitest run tests/unit/host/arkVideo.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/host/services/media/videoGenerationService.ts tests/unit/host/arkVideo.test.ts
git commit -m "feat(video): generateVideo 加 ark 路由分支（守门复用 + key 缺失前置拦截）"
```

---

### Task 5: downloadVideoAsBuffer 补 redirect:manual SSRF 加固

**Files:**
- Modify: `src/host/services/media/videoGenerationService.ts`（`downloadVideoAsBuffer` 约 line 213）
- Test: `tests/unit/host/arkVideo.test.ts`（追加）

> 背景：origin/main 的 `downloadVideoAsBuffer` 只校验初始 `isSafeImageUrl`，未拦 3xx 跳转（Spec 1 才补的 H1）。Seedance 从火山对象存储下载，须同样加固。

- [ ] **Step 1: 写失败测试**

追加：

```ts
import { downloadVideoAsBuffer } from '../../../src/host/services/media/videoGenerationService';

describe('downloadVideoAsBuffer SSRF-via-redirect', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('遇 3xx 重定向抛错，不返回 buffer', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ status: 302, ok: false, arrayBuffer: async () => new ArrayBuffer(0) })));
    await expect(downloadVideoAsBuffer('https://cdn.example.com/clip.mp4')).rejects.toThrow(/重定向/);
  });
});
```

- [ ] **Step 2: 跑测看失败**

Run: `npx vitest run tests/unit/host/arkVideo.test.ts -t 'redirect'`
Expected: FAIL（main 版本无 redirect:manual，302 被透明跟随 / 不抛「重定向」）

- [ ] **Step 3: 实现**

把 `downloadVideoAsBuffer` 的 fetch 调用替换为带 `redirect:'manual'` + 3xx 拦截（对齐姊妹 `downloadImageAsBase64`）：

```ts
export async function downloadVideoAsBuffer(url: string, outerSignal: AbortSignal = new AbortController().signal): Promise<Buffer> {
  if (!isSafeImageUrl(url)) throw new Error('拒绝下载不安全的视频 URL（仅允许 https 公网地址）');
  // SSRF-via-redirect 防护：isSafeImageUrl 只校验初始 url；redirect:'manual' 截停 3xx，防跳私网/元数据。
  const resp = await fetchWithAbort(url, { redirect: 'manual' }, VIDEO_TIMEOUT_MS.DOWNLOAD, outerSignal);
  if (resp.status >= 300 && resp.status < 400) throw new Error(`拒绝跟随视频下载重定向（${resp.status}）`);
  if (!resp.ok) throw new Error(`视频下载失败: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}
```

- [ ] **Step 4: 跑测看通过**

Run: `npx vitest run tests/unit/host/arkVideo.test.ts -t 'redirect'`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/host/services/media/videoGenerationService.ts tests/unit/host/arkVideo.test.ts
git commit -m "fix(video): downloadVideoAsBuffer 补 redirect:manual SSRF 加固（对齐 Spec 1 H1）"
```

---

### Task 6: Seedance 定价入价表

**Files:**
- Modify: `src/shared/constants/pricing.ts`（`VIDEO_PRICING_CNY_PER_SEC` 约 line 78）
- Test: `tests/shared/media/videoCost.test.ts`

- [ ] **Step 1: 写失败测试**

追加：

```ts
import { estimateVideoCostCny } from '../../../src/shared/media/videoCost';

describe('Seedance 成本估算', () => {
  it('按秒查表 × 时长', () => {
    const c = estimateVideoCostCny('doubao-seedance-2-0-260128', 5);
    expect(c).toBeGreaterThan(0);
  });
  it('fast 档单价 ≤ 标准档', () => {
    expect(estimateVideoCostCny('doubao-seedance-2-0-fast-260128', 5))
      .toBeLessThanOrEqual(estimateVideoCostCny('doubao-seedance-2-0-260128', 5));
  });
});
```

- [ ] **Step 2: 跑测看失败**

Run: `npx vitest run tests/shared/media/videoCost.test.ts -t 'Seedance'`
Expected: FAIL（未知 model 回退 default，fast=标准，断言 `>0` 可能过但 `≤` 边界随 default 相等——若 default>0 第一个会过、第二个相等也过；故先确认失败点：实现前两 model 都走 default 相等，第二断言 PASS 但语义错。改为强断言见下）

> 修正：把第二断言改为 `toBeLessThan`（严格小于），实现前两者都=default 必失败：
> ```ts
> expect(estimateVideoCostCny('doubao-seedance-2-0-fast-260128', 5))
>   .toBeLessThan(estimateVideoCostCny('doubao-seedance-2-0-260128', 5));
> ```

- [ ] **Step 3: 实现**

在 `VIDEO_PRICING_CNY_PER_SEC` 的 `default` 前追加（**占位值，dogfood 后按火山定价文档 `82379/1544106` 校准**）：

```ts
  // Spec 2 Seedance（火山 Ark）：占位单价，dogfood 后按官方定价校准。fast 档更便宜。
  'doubao-seedance-2-0-260128': 0.15,
  'doubao-seedance-2-0-fast-260128': 0.08,
```

- [ ] **Step 4: 跑测看通过**

Run: `npx vitest run tests/shared/media/videoCost.test.ts -t 'Seedance'`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/constants/pricing.ts tests/shared/media/videoCost.test.ts
git commit -m "feat(video): Seedance 定价入价表（占位，dogfood 校准）"
```

---

### Task 7: providerKeyConfigured 'ark' 就绪判断

**Files:**
- Modify: `src/host/ipc/workspace.ipc.ts`（`providerKeyConfigured` 约 line 687；import 顶部加 `getArkApiKey`）

- [ ] **Step 1: 实现（轻量，无独立单测；随 typecheck + 既有 ipc 测覆盖）**

import 顶部补 `getArkApiKey`（与 `getDashscopeApiKey` 同 import 行）。在 `providerKeyConfigured` 的 `minimax` 判断后加：

```ts
  if (provider === 'ark') return !!getArkApiKey();
```

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`（或 `npx tsc --noEmit`）
Expected: PASS（无类型错误）

- [ ] **Step 3: 提交**

```bash
git add src/host/ipc/workspace.ipc.ts
git commit -m "feat(video): 视觉 provider 就绪判断加 ark（!!getArkApiKey）"
```

---

### Task 8: 全量验证 + 对抗审计 + dogfood

- [ ] **Step 1: typecheck 全绿**

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 2: 跑本功能全部测试**

Run: `npx vitest run tests/unit/host/arkVideo.test.ts tests/shared/constants/visualModels.video.test.ts tests/shared/media/videoCost.test.ts tests/unit/services/media/imageGenerationService.test.ts`
Expected: PASS（基线已知 10 个预存在失败在别处，非本功能）

- [ ] **Step 3: 对抗审计**

Run: `/codex-audit --feature seedance-native`
聚焦：付费前置守门完整性（cap/prompt/底图/key 全在 POST 前）、SSRF（download redirect + image_url 不被当 URL 拼接绕过）、key 不进日志/不进响应/不进 spec、model id 校验、status 解析健壮性、`encodeURIComponent(task_id)` 注入防护。
按结果 TDD 修 HIGH/MED 直至收敛。

- [ ] **Step 4: dogfood（真出片，需 Ark API Key）**

前置：确认拿到的是 **Ark API Key**（方舟控制台→API Key 管理），不是 AK/SK。先核 spec §1「待 dogfood 校验点」（model id 日期戳 / resolution 枚举 / duration 区间 / data URL 是否被 i2v 接受）。

按 `feedback_paid_dogfood_cost_safety`：**默认只跑一次**，成功判断匹配 Ark 原始响应 `"status":"succeeded"`（别 grep pretty-print）。
- t2v 优先：用真 key 跑一条 5s 720p 出片，验证 `content.video_url` 取到 + 下载落 artifact。
- i2v 顺带：验 data URL 是否被接受；不接受则记入 spec，后续按公网 URL fallback 另议。

- [ ] **Step 5: 收口汇报**

汇报：分支 commit 数、测试/typecheck 证据、审计收敛轮次、dogfood 真出片证据（文件大小 + 成本 ¥）、spec §1 待校验点的实测结论。**不擅自 push/合并**，交林晨拍板。

---

## Self-Review 结论（写计划时自检）

- **Spec 覆盖**：§2.2 改动清单 5 文件 → Task 1(visualModels) / Task 2(getArkApiKey) / Task 3+4+5(videoGenerationService) / Task 6(pricing) / Task 7(workspace.ipc) 全覆盖；§5 产物 24h 过期 → Task 8 dogfood 验下载落地；§6 守门 → Task 4 复用 generateVideo 现有守门 + 测试验证；§3 鉴权复用 volcengine 槽 → Task 2。
- **类型一致**：`submitAndPollArkVideo` / `parseArkVideoTask` / `getArkApiKey` / `ArkVideoArgs` 跨 Task 命名一致；`generateVideo` 签名沿用既有（model/mode/prompt/imageDataUrl/durationSec）。
- **占位扫描**：定价为「占位值 dogfood 校准」（标注真实，非 TODO）；model id 日期戳、resolution/duration 枚举为「dogfood 待校验」（真实未知项，已在 spec §1 列明）—— 非计划缺陷。
- **非目标**：HappyHorse / Veo / 首尾帧多参考 / AK-SK 签名 / 桥接接入，均不在本计划。
