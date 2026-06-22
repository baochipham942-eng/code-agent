# 设计模式 P2「视频生成 MVP」实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给设计画布加上「通义万相视频生成」单 provider 能力——文生视频(t2v) + 图生视频(i2v)，产物挂 variant spine，生成前显式提示预估成本。

**Architecture:** 复刻 P1 生图切换器的全套范式——`VIDEO_MODELS` 注册表（D1 单一真源）驱动切换器选项 + 服务层路由 + cap 过滤；新建 `videoGenerationService`（复用 `submitAndPollWanx` 的异步「提交+轮询 /tasks」骨架，但解析 `output.video_url`）；新 IPC `generateDesignVideo`（登记 shellCapabilities + `assertWithinDesignDir` 守路径 + 付费前拦空参/缺 key + 成本闸）；画布节点扩成判别联合 `CanvasNode = CanvasImageNode | CanvasVideoNode`，konva 渲染缩略图+播放，序列化容错；composer 加视频产物类型 + 视频模型下拉 + t2v/i2v 模式 + 时长 + 成本预估。

**Tech Stack:** TypeScript / React 18 / Zustand / Konva / Vitest / DashScope（百炼）通义万相视频异步 API。

---

## 核实结论（DashScope 通义万相视频，2026-06-22 经 WebFetch 核实）

实施 Task 1/3 时**先重新 WebFetch 复核一遍模型 id**（百炼模型上下架频繁），以下为今日核实值，写进 constants（**禁硬编码进业务代码**）：

- **提交端点**（t2v 与 i2v 共用）：`POST {dashscope}/services/aigc/video-generation/video-synthesis`
  - `{dashscope}` = `MODEL_API_ENDPOINTS.dashscope` = `https://dashscope.aliyuncs.com/api/v1`（已含 `/api/v1`）。
- **查询端点**：`GET {dashscope}/tasks/{task_id}`（与 wanx 图像 `WANX_TASKS_PATH` 完全一致）。
- **必需请求头**：`Content-Type: application/json` + `Authorization: Bearer <key>` + `X-DashScope-Async: enable`（与 `submitAndPollWanx` 一致）。
- **t2v 请求体**：`{ model, input:{ prompt }, parameters:{ resolution:'720P', duration:<int 2-15> } }`，可用模型 `wan2.7-t2v`。
- **i2v 请求体**：`{ model, input:{ img_url:<URL|base64 dataURL>, prompt?:<可选> }, parameters:{ resolution, duration? } }`，底图字段名是 **`img_url`**（不是 image_url / first_frame_url），可用模型含 `wanx2.1-i2v-turbo`（480P/720P，时长固定 5s）。img_url 接受 base64 dataURL（同 `editImageWithMask` 传 `base_image_url: dataUrl`）。
- **提交返回**：`{ output:{ task_id, task_status:'PENDING' } }`。
- **查询返回**：`{ output:{ task_id, task_status:'PENDING|RUNNING|SUCCEEDED|FAILED|CANCELED|UNKNOWN', video_url } }`，成功时视频 URL 在 **`output.video_url`**（有效期 24h），**不是** `output.results[0].url`——这是与图像 `parseWanxTask` 的唯一关键差异，必须新写 `parseWanxVideoTask`。
- **计费**：官方文档未直接披露单价，按 `duration`（秒）计费。Task 2 用**保守上界估值**写进 `pricing.ts`（带「待真实账单校正」注释，方向偏高→成本提示偏保守，安全），dogfood 时与真实账单核对后回填。

---

## 文件结构（决策锁定）

**新建：**
- `src/main/services/media/videoGenerationService.ts` — 视频生成原语（`generateVideo` + `submitAndPollWanxVideo` + `parseWanxVideoTask` + `downloadVideoAsBuffer`）。
- `src/shared/media/videoCost.ts` — `estimateVideoCostCny(model, durationSec)` 纯函数（镜像 `imageCost.ts`）。
- `src/renderer/components/design/VideoModelPicker.tsx` — 视频模型下拉（View + 容器，镜像 `ImageModelPicker.tsx`）。
- 测试：`tests/shared/constants/visualModels.video.test.ts`、`tests/shared/media/videoCost.test.ts`、`tests/unit/services/media/videoGenerationService.test.ts`、`tests/unit/ipc/workspace.video.ipc.test.ts`、`tests/renderer/design/designCanvasTypes.video.test.ts`。

**修改：**
- `src/shared/constants/visualModels.ts` — 加 `VideoCap` / `VisualVideoModel` / `VIDEO_MODELS` + 查询函数。
- `src/shared/constants/pricing.ts` — 加 `VIDEO_PRICING_CNY_PER_SEC` + `DESIGN_VIDEO_MODELS`。
- `src/main/ipc/workspace.ipc.ts` — 加 `handleGenerateDesignVideo` + `handleListVisualVideoModels` + dispatch 两个 case。
- `src/main/shellCapabilities.ts` — WORKSPACE 数组加 `generateDesignVideo`、`listVisualVideoModels`。
- `src/renderer/components/design/designCanvasTypes.ts` — 抽 `CanvasNodeBase`，加 `CanvasVideoNode` + `CanvasNode` 联合 + `isVideoNode`/`isImageNode` 守卫 + normalize 分派。
- `src/renderer/components/design/DesignCanvas.tsx` — 视频节点 konva 渲染（缩略图 + 播放徽标 + 点击播放 overlay）+ 选中图节点的「生成视频」入口。
- `src/renderer/components/design/useDesignCanvasGeneration.ts` — 加 `generateVideo({ baseNode? })`。
- `src/renderer/components/design/designStore.ts` — 加 `videoModel`/`videoMode`/`videoDurationSec` + setters + persist。
- `src/renderer/components/design/DesignWorkspace.tsx` — composer 加 video 产物类型 + 视频模型下拉 + 模式 + 时长 + 成本预估 + onGenerate 路由。
- `src/renderer/i18n/zh.ts` + `src/renderer/i18n/en.ts` — design.* 视频文案（zh/en 对齐）。

**纪律提醒（每 Task 适用）：** TDD / 每 Task 末 `npm run typecheck` + 受影响测试 / 频繁提交 / 不推远程。**不改 `prompts/` 下任何 prompt 文件**（视频 prompt 直接用 `requirement` 文本，不进版本化 prompt 文件）→ 无需 bump PROMPT_VERSION。key 一律走 `getDashscopeApiKey()`（env 仅 dogfood 覆盖），绝不进代码。**Task 8 末尾的付费 dogfood 跑前必须停下来与用户确认成本。**

---

### Task 1: VIDEO_MODELS 注册表

**Files:**
- Modify: `src/shared/constants/visualModels.ts`
- Test: `tests/shared/constants/visualModels.video.test.ts`

> ⚠️ 写前先 WebFetch 复核 `https://help.aliyun.com/zh/model-studio/text-to-video-api-reference` 与 `.../image-to-video-api-reference` 的可用模型 id，与下方默认值不符则以线上为准（结构不变，只换 id 字符串）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/constants/visualModels.video.test.ts
import { describe, it, expect } from 'vitest';
import {
  VIDEO_MODELS,
  videoModelById,
  defaultVideoModelId,
  videoModelsWithCap,
} from '../../../src/shared/constants/visualModels';

describe('VIDEO_MODELS 注册表', () => {
  it('全部 provider 为 dashscope（P2 单 provider）', () => {
    expect(VIDEO_MODELS.length).toBeGreaterThan(0);
    expect(VIDEO_MODELS.every((m) => m.provider === 'dashscope')).toBe(true);
  });

  it('每个模型至少声明一个 cap，且时长区间合法（min<=default<=max 且 >0）', () => {
    for (const m of VIDEO_MODELS) {
      expect(m.caps.length).toBeGreaterThan(0);
      expect(m.minDurationSec).toBeGreaterThan(0);
      expect(m.minDurationSec).toBeLessThanOrEqual(m.defaultDurationSec);
      expect(m.defaultDurationSec).toBeLessThanOrEqual(m.maxDurationSec);
    }
  });

  it('videoModelsWithCap 按能力过滤：t2v 与 i2v 各至少一个', () => {
    expect(videoModelsWithCap('t2v').length).toBeGreaterThan(0);
    expect(videoModelsWithCap('i2v').length).toBeGreaterThan(0);
  });

  it('defaultVideoModelId 命中一个真实注册项', () => {
    expect(videoModelById(defaultVideoModelId())).toBeDefined();
  });

  it('videoModelById 未知 id 返回 undefined', () => {
    expect(videoModelById('no-such-model')).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/constants/visualModels.video.test.ts`
Expected: FAIL（`VIDEO_MODELS` 等未导出）

- [ ] **Step 3: 实现（追加到 visualModels.ts 末尾，不动 image 部分）**

```ts
// ── 视频生成模型注册表（P2，单 provider dashscope）。能力标签 t2v/i2v 驱动模式过滤。 ──
export type VideoCap = 't2v' | 'i2v';

export interface VisualVideoModel {
  id: string;
  label: string;
  provider: VisualProviderId; // P2 仅 'dashscope'
  caps: VideoCap[];
  /** 时长区间（秒）。固定时长模型令 min=default=max（如 i2v turbo 固定 5s）。 */
  minDurationSec: number;
  maxDurationSec: number;
  defaultDurationSec: number;
}

export const VIDEO_MODELS: readonly VisualVideoModel[] = [
  {
    id: 'wan2.7-t2v',
    label: '通义万相 文生视频',
    provider: 'dashscope',
    caps: ['t2v'],
    minDurationSec: 2,
    maxDurationSec: 15,
    defaultDurationSec: 5,
  },
  {
    id: 'wanx2.1-i2v-turbo',
    label: '通义万相 图生视频',
    provider: 'dashscope',
    caps: ['i2v'],
    minDurationSec: 5,
    maxDurationSec: 5, // turbo 档固定 5s
    defaultDurationSec: 5,
  },
];

export function videoModelById(id: string): VisualVideoModel | undefined {
  return VIDEO_MODELS.find((m) => m.id === id);
}

/** 默认走 t2v 文生视频（最常用入口）。 */
export function defaultVideoModelId(): string {
  return 'wan2.7-t2v';
}

export function videoModelsWithCap(cap: VideoCap): VisualVideoModel[] {
  return VIDEO_MODELS.filter((m) => m.caps.includes(cap));
}

/** 把请求时长按模型区间 clamp（非有限/越界 → 回退默认/边界），杜绝付费空/越界调用。 */
export function clampVideoDuration(model: VisualVideoModel, durationSec?: number): number {
  if (typeof durationSec !== 'number' || !Number.isFinite(durationSec)) return model.defaultDurationSec;
  return Math.min(model.maxDurationSec, Math.max(model.minDurationSec, Math.round(durationSec)));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/constants/visualModels.video.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/shared/constants/visualModels.ts tests/shared/constants/visualModels.video.test.ts
git commit -m "feat(design-video): VIDEO_MODELS 注册表 + cap/时长查询函数（P2 Task 1）"
```

---

### Task 2: 视频成本估算

**Files:**
- Modify: `src/shared/constants/pricing.ts`
- Create: `src/shared/media/videoCost.ts`
- Test: `tests/shared/media/videoCost.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/media/videoCost.test.ts
import { describe, it, expect } from 'vitest';
import { estimateVideoCostCny } from '../../../src/shared/media/videoCost';
import { VIDEO_MODELS } from '../../../src/shared/constants/visualModels';

describe('estimateVideoCostCny — 视频按秒计费估算', () => {
  it('命中价表：成本 = 单价/秒 × 时长', () => {
    const cost5 = estimateVideoCostCny('wan2.7-t2v', 5);
    const cost10 = estimateVideoCostCny('wan2.7-t2v', 10);
    expect(cost5).toBeGreaterThan(0);
    // 线性：10s 约为 5s 两倍（容浮点误差）
    expect(cost10).toBeCloseTo(cost5 * 2, 5);
  });

  it('未知模型回退 default 单价', () => {
    expect(estimateVideoCostCny('no-such', 5)).toBeGreaterThan(0);
  });

  it('非法/非正时长按 0 计（不产生负成本）', () => {
    expect(estimateVideoCostCny('wan2.7-t2v', 0)).toBe(0);
    expect(estimateVideoCostCny('wan2.7-t2v', Number.NaN)).toBe(0);
    expect(estimateVideoCostCny('wan2.7-t2v', -3)).toBe(0);
  });

  it('每个注册视频模型都在价表里有条目（无遗漏，避免静默走 default）', () => {
    for (const m of VIDEO_MODELS) {
      expect(estimateVideoCostCny(m.id, 1)).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/media/videoCost.test.ts`
Expected: FAIL（模块/导出不存在）

- [ ] **Step 3a: pricing.ts 追加价表（保守上界估值，带校正注释）**

```ts
/**
 * 视频生成定价（每秒，人民币元）。单一真源——禁在业务代码散落视频价格字面量。
 * key 为视频模型 id，与 VIDEO_MODELS / generateVideo 返回的 actualModel 对齐。
 * ⚠️ DashScope 官方文档未直接披露单价，以下为保守上界估值（方向偏高→成本提示偏保守，
 *    安全侧），dogfood 与真实账单核对后回填校正。
 */
export const VIDEO_PRICING_CNY_PER_SEC: Record<string, number> = {
  'wan2.7-t2v': 0.7,        // 文生视频，保守上界
  'wanx2.1-i2v-turbo': 0.3, // 图生视频 turbo 档，保守上界
  default: 0.7,
};

/** 设计画布视频产物默认模型 id（供 composer 预估成本查表）。 */
export const DESIGN_VIDEO_MODELS = {
  t2v: 'wan2.7-t2v',
  i2v: 'wanx2.1-i2v-turbo',
} as const;
```

- [ ] **Step 3b: 新建 videoCost.ts**

```ts
// src/shared/media/videoCost.ts
// 视频调用成本估算（纯函数，main/renderer 共用）。价表唯一真源在 pricing.ts，
// 本模块只查表 × 时长，不持有任何价格字面量（遵守「禁止硬编码价格」规范）。
import { VIDEO_PRICING_CNY_PER_SEC } from '../constants/pricing';

/** 估算单次视频生成成本（人民币元）= 单价/秒 × 时长；非正时长记 0；未知模型回退 default。 */
export function estimateVideoCostCny(model: string | null | undefined, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const perSec =
    model && Object.prototype.hasOwnProperty.call(VIDEO_PRICING_CNY_PER_SEC, model)
      ? VIDEO_PRICING_CNY_PER_SEC[model]
      : VIDEO_PRICING_CNY_PER_SEC.default;
  return perSec * durationSec;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/media/videoCost.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/shared/constants/pricing.ts src/shared/media/videoCost.ts tests/shared/media/videoCost.test.ts
git commit -m "feat(design-video): 视频按秒计费价表 + estimateVideoCostCny（P2 Task 2）"
```

---

### Task 3: videoGenerationService（高风险：异步轮询 / 协议 → 末尾 /codex-audit）

**Files:**
- Create: `src/main/services/media/videoGenerationService.ts`
- Test: `tests/unit/services/media/videoGenerationService.test.ts`

- [ ] **Step 1: 写失败测试（mock fetch，断言提交 body 形状 + 解析 video_url + 错误路径）**

```ts
// tests/unit/services/media/videoGenerationService.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { getApiKeyMock } = vi.hoisted(() => ({ getApiKeyMock: vi.fn() }));
vi.mock('../../../../src/main/services/core/configService', () => ({
  getConfigService: () => ({ getApiKey: getApiKeyMock }),
}));

import { generateVideo } from '../../../../src/main/services/media/videoGenerationService';

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
  getApiKeyMock.mockReturnValue('sk-dashscope-test'); // dashscope/qwen 槽位
  delete process.env.DASHSCOPE_API_KEY;
});

describe('generateVideo — t2v', () => {
  it('提交到视频端点，body 形如 {model,input:{prompt},parameters:{resolution,duration}}，解析 output.video_url', async () => {
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
    // 轮询命中 /tasks/{id}
    expect(calls.some((c) => c.url.includes('/tasks/task-vid-1'))).toBe(true);
  });
});

describe('generateVideo — i2v', () => {
  it('底图走 input.img_url，prompt 可选，时长按固定模型 clamp 到 5s', async () => {
    const calls = installFetchMock();
    const res = await generateVideo({
      model: 'wanx2.1-i2v-turbo',
      mode: 'i2v',
      imageDataUrl: 'data:image/png;base64,AAAA',
      durationSec: 12, // 越界，应 clamp 到 5
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

  it('任务 FAILED 抛错', async () => {
    globalThis.fetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes('/tasks/')) return jsonResponse({ output: { task_status: 'FAILED', message: 'boom' } });
      return jsonResponse({ output: { task_id: 't1', task_status: 'PENDING' } });
    }) as unknown as typeof fetch;
    await expect(generateVideo({ model: 'wan2.7-t2v', mode: 't2v', prompt: 'x' })).rejects.toThrow(/FAILED|boom/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/services/media/videoGenerationService.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 videoGenerationService.ts**

> 复用 `imageGenerationService` 的 `getDashscopeApiKey` 与 `isSafeImageUrl`（import，单一真源，不复制 SSRF 逻辑）。视频耗时长（分钟级），故用独立更长的轮询超时常量（本地 const 对象，非散落魔法数字，与 image service 的 `TIMEOUT_MS` 同范式）。

```ts
// src/main/services/media/videoGenerationService.ts
// 通义万相视频生成原语（host 可直接调用，剥离 ToolContext/Permission）。
// 复用 wanx「提交异步任务 → 轮询 /tasks 直到 SUCCEEDED/FAILED」骨架，但解析 output.video_url
// （与图像的 output.results[0].url 不同）。t2v / i2v 共用同一提交端点，仅 input/参数不同。
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';
import { getDashscopeApiKey, isSafeImageUrl } from './imageGenerationService';
import { videoModelById, clampVideoDuration, type VideoCap } from '../../../shared/constants/visualModels';

const VIDEO_SYNTHESIS_PATH = '/services/aigc/video-generation/video-synthesis';
const VIDEO_TASKS_PATH = '/tasks';
const DEFAULT_RESOLUTION = '720P';

const VIDEO_TIMEOUT_MS = {
  SUBMIT: 30000,
  POLL: 15000,
  POLL_INTERVAL: 5000,
  TOTAL: 600000, // 视频分钟级，给 10min 总超时
  DOWNLOAD: 120000,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 解析视频任务返回：成功时 url 在 output.video_url（与图像 results[0].url 不同）。 */
export function parseWanxVideoTask(value: unknown): { taskId?: string; status?: string; url?: string; message?: string } {
  if (!isRecord(value)) return {};
  const output = isRecord(value.output) ? value.output : {};
  const taskId = typeof output.task_id === 'string' ? output.task_id : undefined;
  const status = typeof output.task_status === 'string' ? output.task_status : undefined;
  const url = typeof output.video_url === 'string' ? output.video_url : undefined;
  const message =
    typeof output.message === 'string' ? output.message : typeof value.message === 'string' ? value.message : undefined;
  return { taskId, status, url, message };
}

async function fetchWithAbort(url: string, options: RequestInit, timeoutMs: number, outerSignal: AbortSignal): Promise<Response> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (outerSignal.aborted) controller.abort();
  else outerSignal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
    outerSignal.removeEventListener('abort', onAbort);
  }
}

async function submitAndPollWanxVideo(apiKey: string, body: unknown, outerSignal: AbortSignal): Promise<{ url: string }> {
  const submitResp = await fetchWithAbort(
    `${MODEL_API_ENDPOINTS.dashscope}${VIDEO_SYNTHESIS_PATH}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}`, 'X-DashScope-Async': 'enable' },
      body: JSON.stringify(body),
    },
    VIDEO_TIMEOUT_MS.SUBMIT,
    outerSignal,
  );
  if (!submitResp.ok) throw new Error(`通义万相视频提交失败: ${submitResp.status} - ${await submitResp.text()}`);
  const submitted = parseWanxVideoTask(await submitResp.json());
  if (!submitted.taskId) throw new Error('通义万相视频: 未返回 task_id');

  const deadline = Date.now() + VIDEO_TIMEOUT_MS.TOTAL;
  while (Date.now() < deadline) {
    if (outerSignal.aborted) throw new Error('aborted');
    await new Promise((r) => setTimeout(r, VIDEO_TIMEOUT_MS.POLL_INTERVAL));
    const pollResp = await fetchWithAbort(
      `${MODEL_API_ENDPOINTS.dashscope}${VIDEO_TASKS_PATH}/${submitted.taskId}`,
      { headers: { Authorization: `Bearer ${apiKey}` } },
      VIDEO_TIMEOUT_MS.POLL,
      outerSignal,
    );
    if (!pollResp.ok) continue; // 瞬时失败继续轮询
    const task = parseWanxVideoTask(await pollResp.json());
    if (task.status === 'SUCCEEDED') {
      if (!task.url) throw new Error('通义万相视频: 任务成功但无 video_url');
      return { url: task.url };
    }
    if (task.status === 'FAILED' || task.status === 'CANCELED' || task.status === 'UNKNOWN') {
      throw new Error(`通义万相视频任务失败: ${task.status}${task.message ? ` - ${task.message}` : ''}`);
    }
  }
  throw new Error('通义万相视频任务超时');
}

export interface GenerateVideoArgs {
  model: string;
  mode: VideoCap; // 't2v' | 'i2v'
  prompt?: string;
  imageDataUrl?: string; // i2v 底图（base64 dataURL）
  durationSec?: number;
  outerSignal?: AbortSignal;
}

export interface GenerateVideoResult {
  url: string;
  actualModel: string;
  durationSec: number;
}

/**
 * 通义万相视频生成：按 model 注册表校验 cap，构造 t2v/i2v body，异步提交+轮询，返回视频 url。
 * 守门顺序（全在付费请求之前）：模型存在 → cap 命中 mode → t2v 需 prompt / i2v 需底图 → key 存在。
 */
export async function generateVideo(args: GenerateVideoArgs): Promise<GenerateVideoResult> {
  const model = videoModelById(args.model);
  if (!model) throw new Error(`未知视频模型 id: ${args.model}`);
  if (!model.caps.includes(args.mode)) throw new Error(`模型 ${args.model} 不支持 ${args.mode}`);
  if (args.mode === 't2v' && !args.prompt?.trim()) throw new Error('文生视频需要非空 prompt');
  if (args.mode === 'i2v' && !args.imageDataUrl) throw new Error('图生视频需要底图');

  const apiKey = getDashscopeApiKey();
  if (!apiKey) throw new Error('通义万相视频需要百炼（DashScope）API Key。');

  const durationSec = clampVideoDuration(model, args.durationSec);
  const input: Record<string, unknown> =
    args.mode === 't2v'
      ? { prompt: args.prompt }
      : { img_url: args.imageDataUrl, ...(args.prompt?.trim() ? { prompt: args.prompt } : {}) };

  const { url } = await submitAndPollWanxVideo(
    apiKey,
    { model: model.id, input, parameters: { resolution: DEFAULT_RESOLUTION, duration: durationSec } },
    args.outerSignal ?? new AbortController().signal,
  );
  return { url, actualModel: model.id, durationSec };
}

/** 下载视频到 Buffer（SSRF 守卫复用 image service 的 isSafeImageUrl：仅 https 公网）。 */
export async function downloadVideoAsBuffer(url: string, outerSignal: AbortSignal = new AbortController().signal): Promise<Buffer> {
  if (!isSafeImageUrl(url)) throw new Error('拒绝下载不安全的视频 URL（仅允许 https 公网地址）');
  const resp = await fetchWithAbort(url, {}, VIDEO_TIMEOUT_MS.DOWNLOAD, outerSignal);
  if (!resp.ok) throw new Error(`视频下载失败: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/services/media/videoGenerationService.test.ts`
Expected: PASS（注意：测试里 `setTimeout` 真实等待 5s 轮询间隔——若想加速可在测试 `vi.useFakeTimers()`，但本服务用真 timer，保持测试用真实短轮询即可，单测耗时数秒可接受。若超时，给该测试文件加 `{ timeout: 30000 }`。）

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/main/services/media/videoGenerationService.ts tests/unit/services/media/videoGenerationService.test.ts
git commit -m "feat(design-video): videoGenerationService（t2v/i2v 提交轮询 + video_url 解析 + SSRF 守卫下载）（P2 Task 3）"
```

- [ ] **Step 6: 高风险对抗审计**

Run: `/codex-audit --feature design-video-service`（聚焦：异步轮询超时/中止正确性、t2v/i2v body 协议、付费前守门是否对称、SSRF 守卫覆盖视频 url）。HIGH/MED 当轮 TDD 修复后再提交。

---

### Task 4: generateDesignVideo + listVisualVideoModels IPC（高风险：计费/IPC → 末尾 /codex-audit）

**Files:**
- Modify: `src/main/ipc/workspace.ipc.ts`（加 2 个 handler + 2 个 dispatch case + import）
- Modify: `src/main/shellCapabilities.ts`（WORKSPACE 加 2 项）
- Test: `tests/unit/ipc/workspace.video.ipc.test.ts`

- [ ] **Step 1: 写失败测试（直接测两个导出的 handler 纯函数，mock service）**

```ts
// tests/unit/ipc/workspace.video.ipc.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import path from 'path';
import os from 'os';
import { promises as fsp } from 'fs';

// mock 视频 service：生成返回假 url + 时长；下载返回假 buffer。
const { generateVideoMock, downloadVideoMock } = vi.hoisted(() => ({
  generateVideoMock: vi.fn(),
  downloadVideoMock: vi.fn(),
}));
vi.mock('../../../src/main/services/media/videoGenerationService', () => ({
  generateVideo: generateVideoMock,
  downloadVideoAsBuffer: downloadVideoMock,
}));

import { handleGenerateDesignVideo, handleListVisualVideoModels } from '../../../src/main/ipc/workspace.ipc';
import { getUserConfigDir } from '../../../src/main/config/configPaths';

const DESIGN_DIR = path.resolve(getUserConfigDir(), 'design');

beforeEach(() => {
  generateVideoMock.mockReset();
  downloadVideoMock.mockReset();
  generateVideoMock.mockResolvedValue({ url: 'https://oss.example.com/out.mp4', actualModel: 'wan2.7-t2v', durationSec: 5 });
  downloadVideoMock.mockResolvedValue(Buffer.from('FAKEMP4'));
});

describe('handleGenerateDesignVideo', () => {
  it('t2v 正常路径：写 mp4 + 返回 path/actualModel/costCny/durationSec', async () => {
    const out = path.join(DESIGN_DIR, `run-test/assets/vid-${Date.now()}.mp4`);
    const res = await handleGenerateDesignVideo({ mode: 't2v', prompt: '一只猫', model: 'wan2.7-t2v', outputPath: out, durationSec: 5 });
    expect(res.path).toBe(out);
    expect(res.actualModel).toBe('wan2.7-t2v');
    expect(res.durationSec).toBe(5);
    expect(res.costCny).toBeGreaterThan(0);
    expect(await fsp.readFile(out, 'utf8')).toBe('FAKEMP4');
    await fsp.rm(path.dirname(path.dirname(out)), { recursive: true, force: true });
  });

  it('t2v 缺 prompt：抛错，不调 service（防付费空调用）', async () => {
    const out = path.join(DESIGN_DIR, 'run-x/assets/v.mp4');
    await expect(handleGenerateDesignVideo({ mode: 't2v', prompt: '   ', model: 'wan2.7-t2v', outputPath: out })).rejects.toThrow();
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it('i2v 缺 baseImagePath：抛错，不调 service', async () => {
    const out = path.join(DESIGN_DIR, 'run-x/assets/v.mp4');
    await expect(handleGenerateDesignVideo({ mode: 'i2v', model: 'wanx2.1-i2v-turbo', outputPath: out })).rejects.toThrow();
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it('outputPath 越界设计目录：抛「路径越界」，不调 service', async () => {
    const evil = path.join(os.tmpdir(), 'evil.mp4');
    await expect(handleGenerateDesignVideo({ mode: 't2v', prompt: 'x', model: 'wan2.7-t2v', outputPath: evil })).rejects.toThrow(/越界/);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it('i2v baseImagePath 越界设计目录：抛「路径越界」', async () => {
    const out = path.join(DESIGN_DIR, 'run-x/assets/v.mp4');
    const evilBase = path.join(os.tmpdir(), 'evil.png');
    await expect(
      handleGenerateDesignVideo({ mode: 'i2v', model: 'wanx2.1-i2v-turbo', baseImagePath: evilBase, outputPath: out }),
    ).rejects.toThrow(/越界/);
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it('未知模型：抛错，不调 service', async () => {
    const out = path.join(DESIGN_DIR, 'run-x/assets/v.mp4');
    await expect(handleGenerateDesignVideo({ mode: 't2v', prompt: 'x', model: 'no-such', outputPath: out })).rejects.toThrow();
    expect(generateVideoMock).not.toHaveBeenCalled();
  });

  it('i2v 正常路径：读底图→base64 传 service→写 mp4，costCny 用真实回传时长计', async () => {
    const base = path.join(DESIGN_DIR, `run-i2v/assets/base-${Date.now()}.png`);
    await fsp.mkdir(path.dirname(base), { recursive: true });
    await fsp.writeFile(base, Buffer.from('PNGDATA'));
    const out = path.join(DESIGN_DIR, 'run-i2v/assets/v.mp4');
    generateVideoMock.mockResolvedValue({ url: 'https://oss.example.com/o.mp4', actualModel: 'wanx2.1-i2v-turbo', durationSec: 5 });
    const res = await handleGenerateDesignVideo({ mode: 'i2v', model: 'wanx2.1-i2v-turbo', baseImagePath: base, outputPath: out });
    const callArg = generateVideoMock.mock.calls[0][0];
    expect(callArg.mode).toBe('i2v');
    expect(typeof callArg.imageDataUrl).toBe('string');
    expect(callArg.imageDataUrl.startsWith('data:image')).toBe(true);
    expect(res.actualModel).toBe('wanx2.1-i2v-turbo');
    await fsp.rm(path.dirname(path.dirname(base)), { recursive: true, force: true });
  });
});

describe('handleListVisualVideoModels', () => {
  it('返回全部视频模型 + available 标志 + caps/时长区间', async () => {
    const res = await handleListVisualVideoModels();
    expect(res.models.length).toBeGreaterThan(0);
    for (const m of res.models) {
      expect(typeof m.id).toBe('string');
      expect(typeof m.available).toBe('boolean');
      expect(Array.isArray(m.caps)).toBe(true);
      expect(m.maxDurationSec).toBeGreaterThanOrEqual(m.minDurationSec);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/ipc/workspace.video.ipc.test.ts`
Expected: FAIL（handler 未导出）

- [ ] **Step 3a: workspace.ipc.ts 顶部加 import**

```ts
import { estimateVideoCostCny } from '../../shared/media/videoCost';
import { videoModelById, VIDEO_MODELS, clampVideoDuration } from '../../shared/constants/visualModels';
```

- [ ] **Step 3b: 在 handleEditImageByAnnotation 之后插入两个 handler**

```ts
// 设计画布视频生成（P2）：t2v 直连 / i2v 用画布图节点作底图。通义万相视频异步任务。
// 守门顺序（全在付费 service 调用之前，杜绝 paid no-op 与越界）：
// 必填校验（t2v 需 prompt / i2v 需 baseImagePath）→ 路径守卫 → 模型存在 → cap 命中 mode。
// 成本权威源在 main：按真实回传时长 × 模型单价查表（T2 成本可见）。
export async function handleGenerateDesignVideo(payload: {
  mode: 't2v' | 'i2v';
  prompt?: string;
  baseImagePath?: string;
  outputPath: string;
  model: string;
  durationSec?: number;
}): Promise<{ path: string; actualModel: string; costCny: number; durationSec: number }> {
  if (!payload?.outputPath) throw new Error('generateDesignVideo 需要 outputPath');
  if (payload.mode === 't2v' && !payload.prompt?.trim()) throw new Error('文生视频需要非空 prompt');
  if (payload.mode === 'i2v' && !payload.baseImagePath) throw new Error('图生视频需要 baseImagePath');
  assertWithinDesignDir(payload.outputPath, 'outputPath');
  if (payload.baseImagePath) assertWithinDesignDir(payload.baseImagePath, 'baseImagePath');

  const model = videoModelById(payload.model);
  if (!model) throw new Error(`未知视频模型 id: ${payload.model}`);
  if (!model.caps.includes(payload.mode)) throw new Error(`模型 ${payload.model} 不支持 ${payload.mode}`);

  const { generateVideo, downloadVideoAsBuffer } = await import('../services/media/videoGenerationService');

  let imageDataUrl: string | undefined;
  if (payload.mode === 'i2v' && payload.baseImagePath) {
    const baseBuf = await fsp.readFile(payload.baseImagePath);
    imageDataUrl = `data:image/png;base64,${baseBuf.toString('base64')}`;
  }

  const { url, actualModel, durationSec } = await generateVideo({
    model: payload.model,
    mode: payload.mode,
    prompt: payload.prompt,
    imageDataUrl,
    durationSec: payload.durationSec,
  });

  const buf = await downloadVideoAsBuffer(url);
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, buf);
  return { path: payload.outputPath, actualModel, costCny: estimateVideoCostCny(actualModel, durationSec), durationSec };
}

// 列出视频模型 + 可用性（D6/D7：复用 providerKeyConfigured；P2 全 dashscope）。
export async function handleListVisualVideoModels(): Promise<{
  models: Array<{ id: string; label: string; provider: string; available: boolean; caps: string[]; minDurationSec: number; maxDurationSec: number; defaultDurationSec: number }>;
}> {
  return {
    models: VIDEO_MODELS.map((m) => ({
      id: m.id,
      label: m.label,
      provider: m.provider,
      available: providerKeyConfigured(m.provider),
      caps: [...m.caps],
      minDurationSec: m.minDurationSec,
      maxDurationSec: m.maxDurationSec,
      defaultDurationSec: m.defaultDurationSec,
    })),
  };
}
```

- [ ] **Step 3c: dispatch switch 加两个 case（在 `removeWatermarkDesignImage` case 之后）**

```ts
        case 'generateDesignVideo':
          data = await handleGenerateDesignVideo(
            payload as { mode: 't2v' | 'i2v'; prompt?: string; baseImagePath?: string; outputPath: string; model: string; durationSec?: number },
          );
          break;
        case 'listVisualVideoModels':
          data = await handleListVisualVideoModels();
          break;
```

- [ ] **Step 3d: shellCapabilities.ts WORKSPACE 数组加两项（保持字母序）**

```ts
    'generateDesignVideo',
    // ... 已有 ...
    'listVisualVideoModels',
```
（插到 `generateDesignImage` 之后、`getConfigScope` 之前加 `generateDesignVideo`；在 `listVisualImageModels` 之后加 `listVisualVideoModels`。）

- [ ] **Step 4: 跑测试 + capability-diff 闸**

Run: `npx vitest run tests/unit/ipc/workspace.video.ipc.test.ts`
Expected: PASS
Run（确认 capability-diff 不红）: `npx vitest run tests/unit/ipc/workspace.ipc.test.ts`
Expected: PASS（若有 capability-diff/shellCapabilities 断言测试，必须随新 action 同步绿）

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/main/ipc/workspace.ipc.ts src/main/shellCapabilities.ts tests/unit/ipc/workspace.video.ipc.test.ts
git commit -m "feat(design-video): generateDesignVideo + listVisualVideoModels IPC（路径守卫/成本闸/能力登记）（P2 Task 4）"
```

- [ ] **Step 6: 高风险对抗审计**

Run: `/codex-audit --feature design-video-ipc`（聚焦：付费前守门对称性、i2v 路径越界覆盖、成本计算用真实回传时长而非请求时长、capability 登记完整）。当轮 TDD 修 HIGH/MED 再提交。

---

### Task 5: CanvasVideoNode 类型 + 序列化容错

**Files:**
- Modify: `src/renderer/components/design/designCanvasTypes.ts`
- Test: `tests/renderer/design/designCanvasTypes.video.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/renderer/design/designCanvasTypes.video.test.ts
import { describe, it, expect } from 'vitest';
import {
  serializeCanvasDoc,
  deserializeCanvasDoc,
  isVideoNode,
  isImageNode,
  type CanvasVideoNode,
  type CanvasImageNode,
  type DesignCanvasDoc,
} from '../../../src/renderer/components/design/designCanvasTypes';

const imageNode: CanvasImageNode = { id: 'i1', src: 'assets/a.png', x: 0, y: 0, width: 100, height: 100, createdAt: 1 };
const videoNode: CanvasVideoNode = {
  id: 'v1', kind: 'video', src: 'assets/v.mp4', x: 10, y: 0, width: 320, height: 180,
  durationSec: 5, prompt: '猫', parentId: 'i1', costCny: 3.5, createdAt: 2,
};

describe('CanvasVideoNode 序列化', () => {
  it('图+视频混合文档 round-trip 保真', () => {
    const doc: DesignCanvasDoc = { version: 1, nodes: [imageNode, videoNode], camera: { x: 0, y: 0, scale: 1 } };
    const back = deserializeCanvasDoc(serializeCanvasDoc(doc));
    expect(back.nodes).toHaveLength(2);
    const v = back.nodes.find((n) => n.id === 'v1');
    expect(v && isVideoNode(v)).toBe(true);
    expect((v as CanvasVideoNode).durationSec).toBe(5);
    expect((v as CanvasVideoNode).src).toBe('assets/v.mp4');
    expect((v as CanvasVideoNode).costCny).toBe(3.5);
  });

  it('视频节点缺 durationSec/坏字段安全降级（不崩、durationSec 回退正数）', () => {
    const text = JSON.stringify({ version: 1, nodes: [{ id: 'v2', kind: 'video', src: 'assets/x.mp4', x: 0, y: 0, width: 10, height: 10 }], camera: {} });
    const back = deserializeCanvasDoc(text);
    const v = back.nodes[0] as CanvasVideoNode;
    expect(isVideoNode(v)).toBe(true);
    expect(v.durationSec).toBeGreaterThan(0);
  });

  it('kind 缺失但 src 是 .mp4 → 识别为视频（兼容老/手写数据）', () => {
    const text = JSON.stringify({ version: 1, nodes: [{ id: 'v3', src: 'assets/y.mp4', x: 0, y: 0, width: 10, height: 10, durationSec: 8 }], camera: {} });
    const back = deserializeCanvasDoc(text);
    expect(isVideoNode(back.nodes[0])).toBe(true);
  });

  it('普通图节点仍被 isImageNode 识别（向后兼容）', () => {
    const back = deserializeCanvasDoc(JSON.stringify({ version: 1, nodes: [imageNode], camera: {} }));
    expect(isImageNode(back.nodes[0])).toBe(true);
    expect(isVideoNode(back.nodes[0])).toBe(false);
  });

  it('视频节点负 costCny 被丢弃（防注入压低累计成本）', () => {
    const text = JSON.stringify({ version: 1, nodes: [{ id: 'v4', kind: 'video', src: 'assets/z.mp4', x: 0, y: 0, width: 10, height: 10, durationSec: 5, costCny: -9 }], camera: {} });
    const v = deserializeCanvasDoc(text).nodes[0] as CanvasVideoNode;
    expect(v.costCny).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/renderer/design/designCanvasTypes.video.test.ts`
Expected: FAIL

- [ ] **Step 3: 改 designCanvasTypes.ts**

> 抽公共 base，把 `CanvasImageNode` 改成 extends base（保留全部现有字段不变，行为不变），新增 video 类型 + 联合 + 守卫；`DesignCanvasDoc.nodes` 改成 `CanvasNode[]`；`normalizeNode` 拆 base 解析 + 按 kind/扩展名分派。`DEFAULT_VIDEO_DURATION_SEC` 作为缺失时长的兜底常量。

3a. 顶部加常量 + base 接口，并把 `CanvasImageNode` 改为 extends：

```ts
/** 视频节点缺失/损坏时长时的兜底（正数，避免 0 时长导致成本/UI 异常）。 */
export const DEFAULT_VIDEO_DURATION_SEC = 5;

/** 图/视频节点共有的几何 + variant 字段。 */
export interface CanvasNodeBase {
  id: string;
  /** 相对 run 目录的资源路径（图 .png / 视频 .mp4），不内嵌 base64。 */
  src: string;
  x: number;
  y: number;
  width: number;
  height: number;
  prompt?: string;
  parentId?: string;
  chosen?: boolean;
  discarded?: boolean;
  label?: string;
  costCny?: number;
  createdAt: number;
}

/** 画布上的一张图节点。 */
export interface CanvasImageNode extends CanvasNodeBase {
  kind?: 'image'; // 缺省即图（向后兼容老 canvas.json）
  consistency?: RegionLockReport;
}

/** 画布上的一段视频节点（P2）。src 为相对 run 目录的 mp4 路径。 */
export interface CanvasVideoNode extends CanvasNodeBase {
  kind: 'video';
  /** 缩略图/首帧相对路径（可选，MVP 可空，渲染回退占位）。 */
  poster?: string;
  durationSec: number;
}

export type CanvasNode = CanvasImageNode | CanvasVideoNode;

export function isVideoNode(n: CanvasNode): n is CanvasVideoNode {
  return n.kind === 'video' || (n.kind === undefined && /\.mp4$/i.test(n.src));
}
export function isImageNode(n: CanvasNode): n is CanvasImageNode {
  return !isVideoNode(n);
}
```

3b. `DesignCanvasDoc.nodes` 改类型：

```ts
export interface DesignCanvasDoc {
  version: 1;
  nodes: CanvasNode[];
  camera: CanvasCamera;
}
```

3c. `normalizeNode` 重构为先解析 base，再按 kind 分派（替换原函数）：

```ts
function normalizeBase(r: Record<string, unknown>): CanvasNodeBase | null {
  if (typeof r.id !== 'string' || r.id.length === 0) return null;
  if (typeof r.src !== 'string' || r.src.length === 0) return null;
  if (![r.x, r.y, r.width, r.height].every(isFiniteNumber)) return null;
  const base: CanvasNodeBase = {
    id: r.id, src: r.src,
    x: r.x as number, y: r.y as number, width: r.width as number, height: r.height as number,
    createdAt: isFiniteNumber(r.createdAt) ? (r.createdAt as number) : 0,
  };
  if (typeof r.prompt === 'string') base.prompt = r.prompt;
  if (typeof r.parentId === 'string') base.parentId = r.parentId;
  if (r.chosen === true) base.chosen = true;
  if (r.discarded === true) base.discarded = true;
  if (typeof r.label === 'string') base.label = r.label;
  // 成本必须非负：防手改/损坏 canvas.json 注入负成本压低累计花费。
  if (isFiniteNumber(r.costCny) && (r.costCny as number) >= 0) base.costCny = r.costCny as number;
  return base;
}

function normalizeNode(raw: unknown): CanvasNode | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const base = normalizeBase(r);
  if (!base) return null;
  const isVideo = r.kind === 'video' || (r.kind === undefined && /\.mp4$/i.test(base.src));
  if (isVideo) {
    const node: CanvasVideoNode = {
      ...base,
      kind: 'video',
      durationSec: isFiniteNumber(r.durationSec) && (r.durationSec as number) > 0 ? (r.durationSec as number) : DEFAULT_VIDEO_DURATION_SEC,
    };
    if (typeof r.poster === 'string' && r.poster.length > 0) node.poster = r.poster;
    return node;
  }
  const node: CanvasImageNode = { ...base };
  const consistency = normalizeConsistency(r.consistency);
  if (consistency) node.consistency = consistency;
  return node;
}
```

3d. `deserializeCanvasDoc` 内的 `filter` 类型谓词改成 `CanvasNode`：

```ts
    ? p.nodes.map(normalizeNode).filter((n): n is CanvasNode => n !== null)
```

3e. `nextNodePlacement` 入参类型 `readonly CanvasImageNode[]` → `readonly CanvasNode[]`（只读 x/y/width/height，两类共有，行为不变）。

- [ ] **Step 4: 跑测试 + 旧测试回归**

Run: `npx vitest run tests/renderer/design/designCanvasTypes.test.ts tests/renderer/design/designCanvasTypes.video.test.ts`
Expected: PASS（新旧全绿，确认图节点行为零回归）

- [ ] **Step 5: typecheck + commit**

```bash
npm run typecheck
git add src/renderer/components/design/designCanvasTypes.ts tests/renderer/design/designCanvasTypes.video.test.ts
git commit -m "feat(design-video): CanvasNode 判别联合 + CanvasVideoNode 序列化容错（P2 Task 5）"
```

> ⚠️ 本 Task 改了共享类型，typecheck 可能在 `variantSpine.ts`/`variantAdapters.ts`/`DesignCanvas.tsx`/`useDesignCanvasGeneration.ts` 等引用 `CanvasImageNode` 处报错。**凡是「只读几何/variant 字段、对图视频通用」的函数签名改成 `CanvasNode`**；**图特有逻辑（如 consistency、mask 编辑）保持 `CanvasImageNode` 并在调用点用 `isImageNode` 收窄**。逐个修到 typecheck 净，作为本 Task Step 5 的一部分（不另起 commit 也可，但务必绿）。

---

### Task 6: 视频节点 konva 渲染 + i2v 入口

**Files:**
- Modify: `src/renderer/components/design/DesignCanvas.tsx`
- Test: 见下（轻量——纯展示，主要靠 Task 8 headless dogfood 验证）

- [ ] **Step 1: 渲染分派（在节点 map 渲染处，按 `isVideoNode` 分流）**

视频节点 MVP 渲染：深色矩形占位 + 居中播放徽标 ▶ + 底部时长文案（如 `5s`）。若 `poster` 存在则渲染 poster 图（经 `readBinary` 懒加载，同图片节点路径）。点击视频节点 → 打开 DOM `<video>` overlay 播放（mp4 经 `readBinary`/workspace 读成 blob URL，参照 `DesignCompareOverlay` 的浮层范式）。

```tsx
// 伪代码骨架（按 DesignCanvas 现有节点渲染结构落位）：
{nodes.map((node) =>
  isVideoNode(node) ? (
    <KonvaVideoNode
      key={node.id}
      node={node}
      runDir={runDir}
      selected={selectedId === node.id}
      onSelect={() => setSelectedId(node.id)}
      onPlay={() => setPlayingVideo(node)} // 打开 overlay
    />
  ) : (
    /* 现有图片节点渲染保持不变 */
  )
)}
```

`KonvaVideoNode`（同文件内或相邻小组件）：`<Group>` 含 `<Rect fill="#18181b">` + 中心 `<Text text="▶" />` + 左下 `<Text text={`${node.durationSec}s`} />`；选中描边沿用图节点的高亮样式。播放 overlay 用绝对定位 `<video controls autoPlay src={blobUrl}>`，关闭按钮回收 blob URL。

- [ ] **Step 2: i2v 入口（选中图节点的动作条加「生成视频」）**

在选中**图节点**时的浮动动作条（与现有「圈选重绘 / 扩图 / 去水印」同处），加一个「生成视频」按钮，点击调用 `generateVideo({ baseNode: selectedNode })`（Task 7 提供）。视频节点选中时不显示该按钮（视频不可再作 i2v 底图，MVP 范围）。

- [ ] **Step 3: 轻量测试（纯函数/可提取的展示逻辑）**

若 KonvaVideoNode 有可纯函数化的部分（如时长格式 `formatDurationLabel(sec) => '5s'`），抽到 `designCanvasTypes.ts` 或就近模块并单测：

```ts
// 加进 tests/renderer/design/designCanvasTypes.video.test.ts
import { formatDurationLabel } from '../../../src/renderer/components/design/designCanvasTypes';
it('formatDurationLabel: 秒数加 s 后缀', () => {
  expect(formatDurationLabel(5)).toBe('5s');
  expect(formatDurationLabel(0)).toBe('0s');
});
```

对应实现（designCanvasTypes.ts）：
```ts
export function formatDurationLabel(sec: number): string {
  return `${Number.isFinite(sec) && sec > 0 ? Math.round(sec) : 0}s`;
}
```

- [ ] **Step 4: typecheck + 受影响测试**

Run: `npm run typecheck && npx vitest run tests/renderer/design/`
Expected: PASS

- [ ] **Step 5: commit**

```bash
git add src/renderer/components/design/DesignCanvas.tsx src/renderer/components/design/designCanvasTypes.ts tests/renderer/design/designCanvasTypes.video.test.ts
git commit -m "feat(design-video): konva 视频节点渲染（缩略图+播放）+ 选中图节点生成视频入口（P2 Task 6）"
```

---

### Task 7: useDesignCanvasGeneration.generateVideo（t2v + i2v）

**Files:**
- Modify: `src/renderer/components/design/useDesignCanvasGeneration.ts`

> 此 hook 重逻辑、轻可单测（依赖 window.domainAPI / store）。核心正确性靠：① 节点构造形状与 Task 5 类型一致 ② i2v 血缘 parentId=源图 groupKey ③ 付费前 `window.confirm` 成本闸（缺 key/参数空在主进程已拦，前端再加成本确认）。验证以 typecheck + Task 8 headless dogfood 为主。

- [ ] **Step 1: 在 `generate` 之后新增 `generateVideo`，并加入返回对象**

```ts
import { isVideoNode, type CanvasNode, type CanvasVideoNode } from './designCanvasTypes';
import { videoModelById, clampVideoDuration } from '../../../shared/constants/visualModels';
import { estimateVideoCostCny } from '../../../shared/media/videoCost';
import { formatCny } from '../../../shared/media/imageCost';

// ... 在 hook 内：
const generateVideo = useCallback(async (args?: { baseNode?: CanvasNode }) => {
  const form = useDesignStore.getState();
  const mode = form.videoMode; // 't2v' | 'i2v'
  const modelId = form.videoModel;
  const model = videoModelById(modelId);
  if (!model) {
    useDesignCanvasStore.getState().setError(t.design.errDispatch);
    return;
  }

  // i2v 需要底图（来自选中的画布图节点）。
  const baseNode = args?.baseNode;
  if (mode === 'i2v' && (!baseNode || isVideoNode(baseNode))) {
    useDesignCanvasStore.getState().setError(t.design.errNoBaseImageForI2v);
    return;
  }
  if (mode === 't2v' && !form.requirement.trim()) {
    useDesignCanvasStore.getState().setError(t.design.errNoRequirement);
    return;
  }

  // 复用/新建画布 run。
  let runDir = useDesignCanvasStore.getState().runDir;
  if (!runDir) {
    const baseDir = await resolveDesignDir();
    if (!baseDir) {
      useDesignCanvasStore.getState().setError(t.design.errResolveDir);
      return;
    }
    runDir = `${baseDir.replace(/\/+$/, '')}/run-${Date.now()}`;
    await ensureDir(runDir);
    useDesignCanvasStore.getState().loadDoc(runDir, emptyCanvasDoc());
  }

  // 成本闸（T2）：视频按秒计费贵，付费前 confirm 显示预估 ¥ + 时长。
  const durationSec = clampVideoDuration(model, form.videoDurationSec);
  const estCny = estimateVideoCostCny(model.id, durationSec);
  const ok = window.confirm(t.design.videoCostConfirm(formatCny(estCny), durationSec));
  if (!ok) return;

  const assetRel = `${DESIGN_WORKSPACE.CANVAS_ASSETS_DIR}/vid-${Date.now()}.mp4`;
  const assetAbs = `${runDir}/${assetRel}`;

  useDesignCanvasStore.getState().setError(null);
  useDesignCanvasStore.getState().setGenerating(true);
  try {
    const res = await window.domainAPI?.invoke<{ path: string; actualModel: string; costCny: number; durationSec: number }>(
      IPC_DOMAINS.WORKSPACE,
      'generateDesignVideo',
      {
        mode,
        model: model.id,
        prompt: form.requirement.trim() || undefined,
        baseImagePath: mode === 'i2v' && baseNode ? `${runDir}/${baseNode.src}` : undefined,
        outputPath: assetAbs,
        durationSec,
      },
    );
    if (!res?.success) throw new Error(res?.error?.message || t.design.errDispatch);
    if (useDesignCanvasStore.getState().runDir !== runDir) {
      useDesignCanvasStore.getState().setGenerating(false);
      return;
    }
    const { x, y } = nextNodePlacement(useDesignCanvasStore.getState().nodes, DESIGN_WORKSPACE.CANVAS_NODE_GAP);
    const costCny = res.data?.costCny;
    const node: CanvasVideoNode = {
      id: nextVariantNodeId(),
      kind: 'video',
      src: assetRel,
      x,
      y,
      // 视频尺寸 MVP 取固定缩略宽高（16:9 占位），后续可读真实分辨率。
      width: 320,
      height: 180,
      durationSec: res.data?.durationSec ?? durationSec,
      prompt: form.requirement || undefined,
      parentId: mode === 'i2v' && baseNode ? groupKey(baseNode) : undefined,
      createdAt: Date.now(),
      ...(typeof costCny === 'number' && costCny >= 0 ? { costCny } : {}),
    };
    useDesignCanvasStore.getState().addNode(node);
    await saveCanvasDoc(runDir, useDesignCanvasStore.getState().toDoc());
    useDesignCanvasStore.getState().setGenerating(false);
  } catch (e) {
    useDesignCanvasStore.getState().setGenerating(false);
    useDesignCanvasStore.getState().setError(e instanceof Error ? e.message : t.design.errDispatch);
  }
}, [t]);

// 在 return 对象加：generateVideo,
```

> `groupKey` 已在本文件用于 variant 血缘（见 `buildVariantNode`）。`addNode` 入参类型须接受 `CanvasNode`（Task 5 已把 store/doc 节点放宽到联合，确认 `useDesignCanvasStore.addNode` 签名兼容；不兼容则把其入参类型从 `CanvasImageNode` 放宽到 `CanvasNode`）。

- [ ] **Step 2: 更新 hook 返回类型签名**

```ts
export function useDesignCanvasGeneration(): {
  generate: () => Promise<void>;
  generateVideo: (args?: { baseNode?: CanvasNode }) => Promise<void>;
  editRegion: (args: EditRegionArgs) => Promise<void>;
  expand: (args: ExpandArgs) => Promise<void>;
  removeWatermark: (args: RemoveWatermarkArgs) => Promise<void>;
  editByAnnotation: (args: EditByAnnotationArgs) => Promise<void>;
} { /* ... */ }
```

- [ ] **Step 3: typecheck + 受影响测试**

Run: `npm run typecheck && npx vitest run tests/renderer/design/`
Expected: PASS

- [ ] **Step 4: commit**

```bash
git add src/renderer/components/design/useDesignCanvasGeneration.ts src/renderer/components/design/designCanvasStore.ts
git commit -m "feat(design-video): generateVideo(t2v/i2v) 派发 + 成本 confirm 闸 + i2v 血缘（P2 Task 7）"
```

---

### Task 8: composer UI（视频产物类型 + 模型/模式/时长 + 成本预估）+ i18n + 付费 dogfood

**Files:**
- Create: `src/renderer/components/design/VideoModelPicker.tsx`
- Modify: `src/renderer/components/design/designStore.ts`、`DesignWorkspace.tsx`、`designTypes.ts`、`src/renderer/i18n/zh.ts`、`src/renderer/i18n/en.ts`

- [ ] **Step 1: designTypes.ts 扩 DesignOutputType + 视频模式类型**

```ts
/** 产物类型：交互原型(HTML) / 设计稿(图) / 信息图(图) / 视频。 */
export type DesignOutputType = 'prototype' | 'mockup' | 'infographic' | 'video';

/** 视频生成模式。 */
export type DesignVideoMode = 't2v' | 'i2v';
```

- [ ] **Step 2: designStore.ts 加视频表单状态**

state 字段：
```ts
import { defaultImageModelId, defaultVideoModelId } from '../../../shared/constants/visualModels';
import type { DesignVideoMode } from './designTypes';
// ...
  videoModel: string;
  videoMode: DesignVideoMode;
  videoDurationSec: number;
  setVideoModel: (id: string) => void;
  setVideoMode: (m: DesignVideoMode) => void;
  setVideoDurationSec: (n: number) => void;
```
初值 + setters：
```ts
  videoModel: defaultVideoModelId(),
  videoMode: 't2v',
  videoDurationSec: 5,
  setVideoModel: (videoModel) => set({ videoModel }),
  setVideoMode: (videoMode) => set({ videoMode }),
  setVideoDurationSec: (videoDurationSec) => set({ videoDurationSec }),
```
partialize 加：`videoModel: s.videoModel, videoMode: s.videoMode, videoDurationSec: s.videoDurationSec,`（持久化版本号 `version: 1` → 加了新字段且都有默认值，旧持久数据 merge 时缺字段由初值补齐，无需 bump version；若担心可 bump 到 2 并写 migrate 直接返回 persisted）。

- [ ] **Step 3: VideoModelPicker.tsx（镜像 ImageModelPicker，按当前 mode 过滤 cap）**

```tsx
// src/renderer/components/design/VideoModelPicker.tsx
// 设计模式「视频模型」下拉。按当前 videoMode(t2v/i2v) 过滤 cap，未配 key 的灰显。
// 拆 View（纯渲染，可 SSR dogfood）+ 容器（IPC 拉可用性 + designStore 读写）。
import React, { useEffect, useState } from 'react';
import { IPC_DOMAINS } from '@shared/ipc';
import { useI18n } from '../../hooks/useI18n';
import { useDesignStore } from './designStore';

export interface VideoModelOption { id: string; label: string; available: boolean; caps: string[]; }

export interface VideoModelPickerViewProps {
  models: VideoModelOption[];
  value: string;
  onChange: (id: string) => void;
  unconfiguredLabel: string;
  ariaLabel?: string;
}

export const VideoModelPickerView: React.FC<VideoModelPickerViewProps> = ({ models, value, onChange, unconfiguredLabel, ariaLabel }) => (
  <select
    data-testid="design-video-model"
    aria-label={ariaLabel}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    className="rounded-md border border-white/[0.10] bg-white/[0.04] px-2 py-1 text-xs text-zinc-200 focus:border-white/[0.3] focus:outline-none"
  >
    {models.map((m) => (
      <option key={m.id} value={m.id} disabled={!m.available} className={m.available ? '' : 'text-zinc-500'}>
        {m.available ? m.label : `${m.label}（${unconfiguredLabel}）`}
      </option>
    ))}
  </select>
);

/** 容器：拉视频模型可用性，按 videoMode 过滤 cap，接 designStore。 */
export const VideoModelPicker: React.FC = () => {
  const { t } = useI18n();
  const videoModel = useDesignStore((s) => s.videoModel);
  const videoMode = useDesignStore((s) => s.videoMode);
  const setVideoModel = useDesignStore((s) => s.setVideoModel);
  const [models, setModels] = useState<VideoModelOption[]>([]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const res = await window.domainAPI?.invoke<{ models: VideoModelOption[] }>(IPC_DOMAINS.WORKSPACE, 'listVisualVideoModels');
      if (!cancelled && res?.success && res.data?.models) setModels(res.data.models);
    })();
    return () => { cancelled = true; };
  }, []);

  const filtered = models.filter((m) => m.caps.includes(videoMode));
  // 切换 mode 后若当前选中模型不支持该 cap，自动落到第一个可选项。
  useEffect(() => {
    if (filtered.length > 0 && !filtered.some((m) => m.id === videoModel)) setVideoModel(filtered[0].id);
  }, [videoMode, models]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <VideoModelPickerView
      models={filtered}
      value={videoModel}
      onChange={setVideoModel}
      unconfiguredLabel={t.design.videoModelUnconfigured}
      ariaLabel={t.design.videoModel}
    />
  );
};
```

- [ ] **Step 4: DesignWorkspace.tsx 接线**

4a. `isImageOutput` 旁加 `isVideoOutput` + 把 video 纳入「画布产物」（走 canvas run）：
```ts
function isImageOutput(t: DesignOutputType): boolean { return t === 'mockup' || t === 'infographic'; }
function isVideoOutput(t: DesignOutputType): boolean { return t === 'video'; }
```

4b. Composer 内：
```tsx
import { VideoModelPicker } from './VideoModelPicker';
import { estimateVideoCostCny } from '../../../shared/media/videoCost';
import { videoModelById, clampVideoDuration } from '../../../shared/constants/visualModels';
// ...
const { generate: generateCanvas, generateVideo } = useDesignCanvasGeneration();
const videoMode = isVideoOutput(s.outputType);
const generating = (imageMode || videoMode) ? canvasGenerating : s.status === 'generating';
const error = (imageMode || videoMode) ? canvasError : s.error;
const onGenerate = videoMode ? () => generateVideo() : imageMode ? generateCanvas : generatePrototype;
```

4c. outputTypes 加 video：
```tsx
const outputTypes: Array<{ type: DesignOutputType; label: string }> = [
  { type: 'prototype', label: t.design.outputPrototype },
  { type: 'mockup', label: t.design.outputMockup },
  { type: 'infographic', label: t.design.outputInfographic },
  { type: 'video', label: t.design.outputVideo },
];
```

4d. 视频专属表单区（仅 `videoMode` 时显示，放在生成按钮上方）：模式切换(t2v/i2v) + 视频模型下拉 + 时长选择(仅模型 min<max 时可调) + i2v 提示 + 成本预估：
```tsx
{videoMode && (
  <div className="flex flex-col gap-3">
    {/* 模式 */}
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-zinc-400">{t.design.videoModeLabel}</span>
      <div className="flex gap-1.5">
        {(['t2v', 'i2v'] as const).map((m) => (
          <button key={m} type="button" onClick={() => s.setVideoMode(m)}
            className={`flex-1 rounded-md px-2 py-1.5 text-xs transition-colors ${s.videoMode === m ? 'bg-white/[0.10] text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'}`}>
            {m === 't2v' ? t.design.videoModeT2v : t.design.videoModeI2v}
          </button>
        ))}
      </div>
      {s.videoMode === 'i2v' && <span className="text-[11px] text-zinc-500">{t.design.videoI2vHint}</span>}
    </div>
    {/* 模型 */}
    <div className="flex flex-col gap-1.5">
      <span className="text-xs text-zinc-400">{t.design.videoModel}</span>
      <VideoModelPicker />
    </div>
    {/* 时长（固定时长模型禁用调节） */}
    {(() => {
      const vm = videoModelById(s.videoModel);
      const adjustable = vm ? vm.minDurationSec < vm.maxDurationSec : false;
      const dur = vm ? clampVideoDuration(vm, s.videoDurationSec) : s.videoDurationSec;
      return (
        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-zinc-400">{t.design.videoDurationLabel}</span>
          {adjustable ? (
            <input type="range" min={vm!.minDurationSec} max={vm!.maxDurationSec} step={1} value={dur}
              onChange={(e) => s.setVideoDurationSec(Number(e.target.value))} />
          ) : (
            <span className="text-xs text-zinc-300">{dur}s</span>
          )}
        </div>
      );
    })()}
    {/* 成本预估（视频按秒，比图贵一量级，显著提示） */}
    {(() => {
      const vm = videoModelById(s.videoModel);
      const dur = vm ? clampVideoDuration(vm, s.videoDurationSec) : s.videoDurationSec;
      return (
        <div className="-mb-2 flex items-center justify-between rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-3 py-1.5 text-[11px]">
          <span className="text-zinc-300">
            {t.design.costEstimateLabel}{' '}
            <span className="font-mono text-amber-300">{formatCny(estimateVideoCostCny(s.videoModel, dur))}</span>
          </span>
          <span className="text-zinc-500">{t.design.videoCostHint}</span>
        </div>
      );
    })()}
  </div>
)}
```

> 视频产物隐藏图像专属的 aspectRatio / 生图模型 / 图像成本预估区（这些 `imageMode &&` 已天然隐藏，无需改）。requirement 输入框对 t2v 必填、i2v 选填——文案可在 i2v 时把占位提示改为「可选：补充运动/镜头描述」。

- [ ] **Step 5: i18n 文案（zh.ts + en.ts，design 命名空间，键名对齐）**

zh.ts `design` 内追加：
```ts
outputVideo: '视频',
videoModel: '视频模型',
videoModelUnconfigured: '未配置',
videoModeLabel: '生成模式',
videoModeT2v: '文生视频',
videoModeI2v: '图生视频',
videoI2vHint: '先在画布选中一张图片，再点生成视频',
videoDurationLabel: '时长（秒）',
videoCostHint: '按秒计费，比图像贵',
videoCostConfirm: (cost: string, sec: number) => `本次视频生成预计花费 ${cost}（约 ${sec} 秒）。确认生成？`,
errNoBaseImageForI2v: '图生视频需先在画布选中一张图片',
```
en.ts `design` 内对齐（同键）：
```ts
outputVideo: 'Video',
videoModel: 'Video model',
videoModelUnconfigured: 'not configured',
videoModeLabel: 'Mode',
videoModeT2v: 'Text→Video',
videoModeI2v: 'Image→Video',
videoI2vHint: 'Select an image on the canvas first, then generate video',
videoDurationLabel: 'Duration (s)',
videoCostHint: 'Billed per second, pricier than images',
videoCostConfirm: (cost: string, sec: number) => `This video will cost about ${cost} (~${sec}s). Generate?`,
errNoBaseImageForI2v: 'Image-to-video needs an image selected on the canvas',
```

> `Translations` 是从 en.ts 推导的类型——en.ts 加键后 zh.ts 必须同步，否则 typecheck 报缺键。`videoCostConfirm` 是函数型文案，确认 i18n 类型支持函数值（项目已有函数型文案则照搬；若不支持，改为模板：UI 侧 `t.design.videoCostConfirmPrefix + cost + ...` 拼接）。

- [ ] **Step 6: typecheck + 全设计测试 + 构建**

Run: `npm run typecheck && npx vitest run tests/renderer/design/ tests/shared/ tests/unit/ipc/workspace.video.ipc.test.ts tests/unit/services/media/videoGenerationService.test.ts`
Expected: ALL PASS

- [ ] **Step 7: headless dogfood（无付费，截图验证 composer 视频 UI）**

用项目既有 headless 截图范式（参照记忆：`renderToStaticMarkup` 真组件 → /tmp html → chrome-headless-shell 截图；mock appStore 须给 language）验证：视频产物类型出现、t2v/i2v 切换、视频模型下拉、时长、成本预估（amber 色块）渲染正常，无控制台报错。

- [ ] **Step 8: commit（功能完整，未付费）**

```bash
npm run typecheck
git add -A
git commit -m "feat(design-video): composer 视频产物类型 + 模型/模式/时长/成本预估 + i18n（P2 Task 8）"
```

- [ ] **Step 9: ⚠️ 付费 dogfood —— 跑前必停下来与用户确认成本**

> **硬规矩（feedback_paid_dogfood_cost_safety）**：真出视频按秒计费，t2v 5s 估 ~¥3.5、i2v 5s 估 ~¥1.5（保守上界，真实可能更低）。**先停下，把预估成本告诉用户，等用户明确说"跑"再执行。每个 mode 只跑一次，绝不重试烧钱。**

确认后，dogfood 步骤（默认只跑 t2v 一段；用户要 i2v 再单独确认）：
1. key：dogfood 用 `DASHSCOPE_API_KEY` env 覆盖（裸 vitest 不加载 `~/.code-agent/.env`，须内联或 export）。
2. 直接调真 service（绕 UI）跑 t2v：写一次性脚本调用 `generateVideo({model:'wan2.7-t2v', mode:'t2v', prompt:'...', durationSec:5})` → 拿到 video_url → `downloadVideoAsBuffer` 落 mp4，确认文件非空可播放、`durationSec`/`costCny` 回传正确。
3. i2v（如用户确认）：用一张已生成的设计图做底图跑 `wanx2.1-i2v-turbo`，确认 img_url base64 链路通、产物落盘。
4. 验收要点：异步轮询真实收敛（非 mock）、video_url SSRF 守卫放行真实 OSS https、mp4 字节非空、成本按真实时长计算。把真实耗时与（如可得）真实账单回填 `pricing.ts` 注释。

- [ ] **Step 10: dogfood 后 commit（若校正了价表/修了真实链路问题）**

```bash
git add -A
git commit -m "chore(design-video): 付费 dogfood 验收 + 价表按真实账单校正（P2 Task 8）"
```

---

## 完成后

- [ ] 全量受影响测试 + `npm run typecheck` 全绿。
- [ ] `git log --oneline` 确认每 Task 独立 commit；**不推远程，待用户拍板合并**（参照 P1/T 系列：隔离 worktree 提交，未推未合）。
- [ ] 用 superpowers:finishing-a-development-branch 汇报：测试通过数、覆盖维度、codex-audit 收敛结论、dogfood 证据，交用户决定合并。
- [ ] 更新 `docs/architecture/design-mode.md`（§6 增 P2 as-built），spec 顶部状态行标 P2 已实现。

---

## Self-Review（写计划后自查）

- **Spec 覆盖（§6 P2 六条）**：① VIDEO_MODELS+价 → Task 1/2 ✅；② videoGenerationService(submitAndPollWanx 范式) → Task 3 ✅；③ generateDesignVideo IPC + shellCapabilities + assertWithinDesignDir + 付费前拦 → Task 4 ✅；④ CanvasVideoNode 判别联合 + konva 渲染 + 序列化容错 + variant spine → Task 5/6/7 ✅；⑤ composer 视频产物类型 + 模型下拉 + 模式 + i2v 入口(选图节点→生成视频, parentId=源图) → Task 6/7/8 ✅；⑥ 成本(D3)生成前显著提示+走 T2 → Task 7(confirm 闸)/8(inline 预估) ✅。决策 D1(注册表单源)/D3(成本)/D4(复用 dashscope key)/D5(挂 spine) 均落实。
- **类型一致性**：`generateVideo` 入参 `{model,mode,prompt?,imageDataUrl?,durationSec?}` 在 Task 3 定义、Task 4 IPC 调用一致；IPC 返回 `{path,actualModel,costCny,durationSec}` 在 Task 4/7 一致；`CanvasVideoNode`/`isVideoNode`/`clampVideoDuration`/`videoModelById`/`estimateVideoCostCny` 跨 Task 命名统一。
- **无占位符**：每个代码步给出完整可粘贴代码，无 TODO/“类似上文”。
- **风险点已标**：Task 3/4 末尾 /codex-audit；Task 5 共享类型 ripple 显式提示用 isImageNode/isVideoNode 收窄；Task 8 付费 dogfood 前硬停确认成本。
