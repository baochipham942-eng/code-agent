# 标注重绘（非 wanx 整图编辑）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给非 wanx 模型（首刀 gpt-image-2）开一条「标注→截图整图→模型重绘」的图像编辑路径，注册表能力驱动、产物挂 variant spine。

**Architecture:** 注册表加 `annotEdit` cap（单一真源）；服务层 `editImageByAnnotation` 按 engine 路由到模型的整图编辑端点（gptimage → OpenAI 兼容 `/v1/images/edits` multipart）；新 IPC `editImageByAnnotation`（cap 守门 + 路径守卫 + 成本回传）；renderer 标注工具栏（笔/箭头/矩形/文字）把 `[原图+标注]` konva 合成导出喂模型，结果非破坏挂 spine。

**Tech Stack:** TypeScript / React / Zustand / Konva / esbuild(main)+Vite(renderer) / vitest。Node 22（全局 `FormData`/`Blob`/`fetch`）。

**前置**：spec `docs/designs/design-mode-annotation-redraw.md`（A1–A7）。基于 P1（`feat/design-model-switcher`）：注册表 `visualModels.ts`、gptimage engine、T2 成本、T1 spine 已就位。worktree `code-agent-annotedit`，分支 `feat/design-annotation-redraw`。

**纪律**：TDD / i18n(zh+en，en 类型源) / 禁硬编码（模型/端点/价进 constants）/ 新 renderer IPC 必须登记 `src/main/shellCapabilities.ts` WORKSPACE 数组 / 每任务 `npm run typecheck` + 受影响测试 / 频繁提交 / 不推远程。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/shared/constants/visualModels.ts` | `ImageCap` 加 `annotEdit` + `imageModelsWithCap` 查询 | 改 |
| `src/main/services/media/imageGenerationService.ts` | `editImageByAnnotation`（gptimage `/v1/images/edits` multipart） | 改 |
| `src/main/ipc/workspace.ipc.ts` | `handleEditImageByAnnotation` + dispatch case | 改 |
| `src/main/shellCapabilities.ts` | 登记 `editImageByAnnotation` | 改 |
| `src/renderer/components/design/designStore.ts` | 标注模式 + 指令 state | 改 |
| `src/renderer/components/design/AnnotationLayer.tsx` | konva 标注层（笔/箭头/矩形/文字）+ 合成导出 | 新增 |
| `src/renderer/components/design/DesignWorkspace.tsx` | composer 接标注模式/指令框/模型下拉/成本 confirm/spine 接线 | 改 |
| `src/renderer/components/design/useDesignCanvasGeneration.ts` | invoke editImageByAnnotation + 回灌 spine | 改 |
| `src/renderer/i18n/{zh,en}.ts` | 文案 | 改 |
| 对应 `tests/**` | 单测 | 新增/改 |

---

# Phase A — 后端（先做，含硬门验证）

> Phase A 收尾跑一次真编辑 dogfood 验证 relay 支持 `/v1/images/edits`。**关门则停，不进 Phase B。**

## Task A1: 注册表 annotEdit cap + cap 查询

**Files:**
- Modify: `src/shared/constants/visualModels.ts`
- Test: `tests/shared/constants/visualModels.test.ts`（追加）

- [ ] **Step 1: 写失败测试**（追加到现有 describe 之后）

```ts
import { imageModelsWithCap } from '../../../src/shared/constants/visualModels';

describe('annotEdit 能力（标注重绘）', () => {
  it('gpt-image-2 带 annotEdit，wanx/cogview/flux 不带', () => {
    expect(imageModelById('gpt-image-2')?.caps).toContain('annotEdit');
    expect(imageModelById('wanx-t2i')?.caps).not.toContain('annotEdit');
    expect(imageModelById('cogview-4')?.caps).not.toContain('annotEdit');
    expect(imageModelById('flux-2')?.caps).not.toContain('annotEdit');
  });
  it('imageModelsWithCap("annotEdit") 只返回 gpt-image-2', () => {
    const ids = imageModelsWithCap('annotEdit').map((m) => m.id);
    expect(ids).toEqual(['gpt-image-2']);
  });
  it('imageModelsWithCap("t2i") 返回全部四模型', () => {
    expect(imageModelsWithCap('t2i').length).toBe(4);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/constants/visualModels.test.ts`
Expected: FAIL（`imageModelsWithCap` 不存在 + gpt-image-2 无 annotEdit cap）

- [ ] **Step 3: 写实现**

在 `visualModels.ts`：
```ts
// ImageCap 加 annotEdit：
export type ImageCap = 't2i' | 'maskEdit' | 'expand' | 'annotEdit';

// gpt-image-2 那行 caps 改为：
{ id: 'gpt-image-2', label: 'GPT-image-2', provider: 'gptimage', engine: 'gptimage', caps: ['t2i', 'annotEdit'] },

// 文件末尾加纯查询函数：
/** 返回声明了指定能力的全部视觉图像模型（驱动 cap 过滤的切换器/工具）。 */
export function imageModelsWithCap(cap: ImageCap): VisualImageModel[] {
  return IMAGE_MODELS.filter((m) => m.caps.includes(cap));
}
```

- [ ] **Step 4: 跑测试确认通过 + typecheck**

Run: `npx vitest run tests/shared/constants/visualModels.test.ts` → PASS
Run: `npm run typecheck` → 0

- [ ] **Step 5: 提交**

```bash
git add src/shared/constants/visualModels.ts tests/shared/constants/visualModels.test.ts
git commit -m "feat(annot): 注册表 annotEdit cap + imageModelsWithCap 查询"
```

---

## Task A2: editImageByAnnotation 服务（gptimage `/v1/images/edits`）

**Files:**
- Modify: `src/main/services/media/imageGenerationService.ts`
- Test: `tests/unit/services/media/imageGenerationService.test.ts`（追加）

**背景**：OpenAI 兼容 `/v1/images/edits` 走 `multipart/form-data`（不是 JSON）：字段 `image`（图片文件）、`prompt`、`model`、`size`、`n`。Node 22 有全局 `FormData`/`Blob`，把 dataURL 还原成 Blob 塞进 FormData。返回 `{ data: [{ b64_json }] }`。base+key 复用 `getGptImageConfig`。

- [ ] **Step 1: 写失败测试**（追加；mock fetch 校验 multipart 字段 + b64 回 + 缺 key + 错误体）

```ts
it('editImageByAnnotation(gptimage) 走 /v1/images/edits multipart 取 b64', async () => {
  process.env.GPTIMAGE_PROXY_BASE = 'https://example.test';
  process.env.GPTIMAGE_PROXY_KEY = 'sk-test';
  let capturedUrl = ''; let capturedBody: any = null;
  const fetchMock = vi.fn().mockImplementation(async (url: string, init: any) => {
    capturedUrl = url; capturedBody = init.body;
    return { ok: true, json: async () => ({ data: [{ b64_json: 'QUJD' }] }) };
  });
  vi.stubGlobal('fetch', fetchMock);
  const { editImageByAnnotation } = await import('../../../../src/main/services/media/imageGenerationService');
  const r = await editImageByAnnotation({
    engine: 'gptimage',
    annotatedImageDataUrl: 'data:image/png;base64,QUJD',
    instruction: '把红圈处 logo 改成猫头',
  });
  expect(r.actualModel).toBe('gpt-image-2');
  expect(r.imageData.startsWith('data:image/png;base64,')).toBe(true);
  expect(capturedUrl).toBe('https://example.test/v1/images/edits');
  // multipart：body 是 FormData，含 image/prompt/model 字段
  expect(capturedBody).toBeInstanceOf(FormData);
  expect(capturedBody.get('model')).toBe('gpt-image-2');
  expect(capturedBody.get('prompt')).toBe('把红圈处 logo 改成猫头');
  expect(capturedBody.get('image')).toBeInstanceOf(Blob);
});
it('editImageByAnnotation 缺 key 报配置', async () => {
  delete process.env.GPTIMAGE_PROXY_BASE; delete process.env.GPTIMAGE_PROXY_KEY;
  getApiKeyMock.mockReturnValue(undefined); // 复用文件顶部 configService mock（同 Task 9 范式）
  const { editImageByAnnotation } = await import('../../../../src/main/services/media/imageGenerationService');
  await expect(editImageByAnnotation({ engine: 'gptimage', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: 'x' }))
    .rejects.toThrow(/配置/);
});
it('editImageByAnnotation 非 ok 透出错误体', async () => {
  process.env.GPTIMAGE_PROXY_BASE = 'https://example.test'; process.env.GPTIMAGE_PROXY_KEY = 'sk-test';
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => 'quota exceeded' }));
  const { editImageByAnnotation } = await import('../../../../src/main/services/media/imageGenerationService');
  await expect(editImageByAnnotation({ engine: 'gptimage', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: 'x' }))
    .rejects.toThrow(/429.*quota exceeded/);
});
it('editImageByAnnotation 非 gptimage engine 抛不支持', async () => {
  const { editImageByAnnotation } = await import('../../../../src/main/services/media/imageGenerationService');
  await expect(editImageByAnnotation({ engine: 'wanx', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: 'x' }))
    .rejects.toThrow(/不支持|标注重绘/);
});
```
（沿用文件顶部既有的 `vi.mock('.../configService')` + `getApiKeyMock` + `afterEach` 清理；`fetchWithAbort` 内部用全局 `fetch`，`vi.stubGlobal('fetch', ...)` 生效。）

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run tests/unit/services/media/imageGenerationService.test.ts` → FAIL

- [ ] **Step 3: 写实现**

在 `imageGenerationService.ts` 加常量 + 函数：
```ts
const GPTIMAGE_EDITS_PATH = '/v1/images/edits';

/** dataURL → Blob（multipart 用）。 */
function dataUrlToBlob(dataUrl: string): Blob {
  const m = dataUrl.match(/^data:([^;]+);base64,(.*)$/);
  if (!m) throw new Error('annotatedImageDataUrl 不是合法 base64 dataURL');
  const buf = Buffer.from(m[2], 'base64');
  // Buffer 是 Uint8Array 子类；拷贝成独立 Uint8Array 避免内存池别名（同 T4 sharp 坑）。
  return new Blob([new Uint8Array(buf)], { type: m[1] });
}

/**
 * 标注重绘：把 renderer 拍扁的 [原图+标注] 整图喂模型编辑端点（A2/A4）。
 * gptimage → OpenAI 兼容 /v1/images/edits（multipart：image+prompt+model）；取 b64。
 * 非 gptimage engine 暂不支持（cap 守门兜底，本期只实装 gpt-image-2）。
 */
export async function editImageByAnnotation(input: {
  engine: ImageEngineId;
  annotatedImageDataUrl: string;
  instruction: string;
  outerSignal?: AbortSignal;
}): Promise<{ imageData: string; actualModel: string }> {
  if (input.engine !== 'gptimage') {
    throw new Error(`engine ${input.engine} 暂不支持标注重绘`);
  }
  const cfg = getGptImageConfig();
  if (!cfg) throw new Error('gpt-image-2 需要在设置配置自定义端点 base 与 API Key。');
  const form = new FormData();
  form.append('model', GPTIMAGE_MODEL);
  form.append('prompt', input.instruction);
  form.append('n', '1');
  form.append('size', GPTIMAGE_DEFAULT_SIZE);
  form.append('image', dataUrlToBlob(input.annotatedImageDataUrl), 'annotated.png');
  const resp = await fetchWithAbort(
    `${cfg.base}${GPTIMAGE_EDITS_PATH}`,
    { method: 'POST', headers: { Authorization: `Bearer ${cfg.key}` }, body: form }, // 不设 Content-Type，让 fetch 自带 boundary
    TIMEOUT_MS.GPTIMAGE_GENERATION,
    input.outerSignal ?? new AbortController().signal,
  );
  if (!resp.ok) {
    const errBody = await resp.text().catch(() => '');
    throw new Error(`gpt-image-2 标注重绘失败: ${resp.status}${errBody ? ` - ${errBody}` : ''}`);
  }
  const json = await resp.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('gpt-image-2 标注重绘返回无 b64_json');
  return { imageData: `data:image/png;base64,${b64}`, actualModel: GPTIMAGE_MODEL };
}
```

- [ ] **Step 4: 跑测试通过 + typecheck** → PASS / 0

- [ ] **Step 5: 提交**

```bash
git add src/main/services/media/imageGenerationService.ts tests/unit/services/media/imageGenerationService.test.ts
git commit -m "feat(annot): editImageByAnnotation 服务(gptimage /v1/images/edits multipart)"
```

---

## Task A3: editImageByAnnotation IPC + cap 守门 + 路径守卫 + 登记能力

**Files:**
- Modify: `src/main/ipc/workspace.ipc.ts`（新 handler + dispatch case）
- Modify: `src/main/shellCapabilities.ts`（登记 action）
- Test: `tests/unit/ipc/workspaceDesignImage.test.ts`（追加）

- [ ] **Step 1: 写失败测试**（追加；复用文件既有 mock，给 service 加 editImageByAnnotation mock）

在文件顶部 `vi.mock('.../imageGenerationService')` 返回对象里加：
```ts
editImageByAnnotation: vi.fn(async () => ({ imageData: 'data:image/png;base64,QUJD', actualModel: 'gpt-image-2' })),
```
追加测试：
```ts
describe('handleEditImageByAnnotation', () => {
  it('cap 守门：非 annotEdit 模型抛错且不触发付费调用', async () => {
    const svc = await import(SVC);
    await expect(
      handleEditImageByAnnotation({ model: 'wanx-t2i', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: 'x', outputPath }),
    ).rejects.toThrow(/标注重绘|不支持/);
    expect((svc.editImageByAnnotation as any).mock.calls.length).toBe(0);
  });
  it('annotEdit 模型(gpt-image-2)走通：调 service 并落盘 + 回 costCny', async () => {
    const res = await handleEditImageByAnnotation({ model: 'gpt-image-2', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: '把 logo 改成猫头', outputPath });
    expect(res).toMatchObject({ path: outputPath, actualModel: 'gpt-image-2', costCny: 0.25 });
    const written = await readFile(outputPath);
    expect(written.toString()).toBe('ABC');
  });
  it('空白 instruction 抛错且不触发付费调用（防 paid no-op）', async () => {
    const svc = await import(SVC);
    await expect(
      handleEditImageByAnnotation({ model: 'gpt-image-2', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: '   ', outputPath }),
    ).rejects.toThrow(/instruction|指令/);
    expect((svc.editImageByAnnotation as any).mock.calls.length).toBe(0);
  });
  it('outputPath 越界抛错且不触发付费调用', async () => {
    const svc = await import(SVC);
    await expect(
      handleEditImageByAnnotation({ model: 'gpt-image-2', annotatedImageDataUrl: 'data:image/png;base64,QUJD', instruction: 'x', outputPath: '/tmp/evil.png' }),
    ).rejects.toThrow(/越界/);
    expect((svc.editImageByAnnotation as any).mock.calls.length).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL（handler 不存在）

- [ ] **Step 3: 写 handler + 登记**

`workspace.ipc.ts`：
```ts
import { imageEngineForModel, defaultImageModelId, IMAGE_MODELS, imageModelById } from '../../shared/constants/visualModels';
// （imageModelById 若未在现有 import 里则补上）

export async function handleEditImageByAnnotation(
  payload: { model: string; annotatedImageDataUrl: string; instruction: string; outputPath: string },
): Promise<{ path: string; actualModel: string; costCny: number }> {
  if (!payload?.annotatedImageDataUrl || !payload?.outputPath) {
    throw new Error('editImageByAnnotation 需要 annotatedImageDataUrl 与 outputPath');
  }
  if (!payload?.instruction?.trim()) {
    throw new Error('editImageByAnnotation 需要非空 instruction 指令');
  }
  assertWithinDesignDir(payload.outputPath, 'outputPath');
  // cap 守门：模型必须声明 annotEdit，否则不发起付费调用。
  const model = imageModelById(payload.model);
  if (!model?.caps.includes('annotEdit')) {
    throw new Error(`模型 ${payload.model} 不支持标注重绘`);
  }
  const engine = imageEngineForModel(payload.model);
  const { editImageByAnnotation } = await import('../services/media/imageGenerationService');
  const { imageData, actualModel } = await editImageByAnnotation({
    engine, annotatedImageDataUrl: payload.annotatedImageDataUrl, instruction: payload.instruction,
  });
  const base64 = imageData.replace(/^data:image\/\w+;base64,/, '');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, Buffer.from(base64, 'base64'));
  return { path: payload.outputPath, actualModel, costCny: estimateImageCostCny(actualModel) };
}
```
dispatch 加：
```ts
case 'editImageByAnnotation':
  data = await handleEditImageByAnnotation(
    payload as { model: string; annotatedImageDataUrl: string; instruction: string; outputPath: string },
  );
  break;
```
`shellCapabilities.ts` 的 WORKSPACE 数组按字母序插入 `'editImageByAnnotation'`（在 `'editDesignImage'` 之后、`'expandDesignImage'` 之前）。

- [ ] **Step 4: 跑测试 + capability 自检 + typecheck**

Run: `npx vitest run tests/unit/ipc/workspaceDesignImage.test.ts` → PASS
Run: `npx vitest run tests/unit/main/shellCapabilities.test.ts` → PASS
Run: `npm run typecheck` → 0

- [ ] **Step 5: 提交**

```bash
git add src/main/ipc/workspace.ipc.ts src/main/shellCapabilities.ts tests/unit/ipc/workspaceDesignImage.test.ts
git commit -m "feat(annot): editImageByAnnotation IPC(cap守门+路径守卫+成本)+登记shell能力"
```

---

## Task A4: 硬门 dogfood（真编辑，验 relay 支持 /v1/images/edits）

> ⚠️ **真实付费**（约 ¥0.25，gpt-image-2 编辑慢 ~60-90s，timeout≥120s）。**跑前停下来跟林晨确认成本。**

- [ ] **Step 1: 确定性门** — `npm run typecheck` → 0；`npx vitest run tests/shared/constants/visualModels.test.ts tests/unit/services/media/imageGenerationService.test.ts tests/unit/ipc/workspaceDesignImage.test.ts` → 全绿；`npm run build && npm run build:web` → 双 EXIT 0。

- [ ] **Step 2: 起 web 后端** — `WEB_PORT=8180 node dist/web/webServer.cjs`（自动读 `~/.code-agent/.env` 的 GPTIMAGE key），读 `.dev-token`。

- [ ] **Step 3: 真编辑调用** — 先 `POST /api/domain/workspace/generateDesignImage{model:'gpt-image-2', prompt, outputPath}` 出一张基图（落 `~/.code-agent/design/dogfood/annot-base.png`）；把它读成 dataURL（或直接复用 P1 dogfood 的 gptimage.png），`POST /api/domain/workspace/editImageByAnnotation{model:'gpt-image-2', annotatedImageDataUrl:<dataURL>, instruction:'把登录按钮改成绿色，去掉所有标注', outputPath:'~/.code-agent/design/dogfood/annot-edit.png'}`。
  - **验硬门**：`success:true` + `actualModel='gpt-image-2'` + `costCny=0.25` + 落盘 PNG 真的按指令改了。
  - **关门信号**：若 relay 返回 404/不支持 edits 端点 / multipart 报错 → **停，回报林晨**：gpt-image-2 标注重绘整条路阻塞，需换 relay 或换模型，**不进 Phase B**。

- [ ] **Step 4: 关服务 + 清 `.dev-token`，回报硬门结论（无代码改动不提交）。**

> **对抗审计**：A2/A3 涉计费 + 外部 multipart 请求 + 能力闸，Phase A 收尾补一次对抗审计（codex-audit 或独立子 agent 反方），重点 multipart body 正确性 / cap 守门对称 / 错误体不泄漏 key / 路径守卫。

---

# Phase B — 前端（仅当 A4 硬门通过后开始）

> Phase B 各 Task 沿用既有 `DesignCanvas.tsx` 的 konva 模式、T1 `buildVariantNode` 挂 spine、T2 成本 confirm、designStore persist 范式。konva 绘制细节以现有画布代码为准。

## Task B1: designStore 标注模式 + 指令 state

**Files:** Modify `src/renderer/components/design/designStore.ts`；Test `tests/renderer/design/designStore.test.ts`（追加）

- [ ] **Step 1: 写失败测试**
```ts
it('designStore 标注模式默认关、指令默认空，可 set', () => {
  const s = useDesignStore.getState();
  expect(s.annotMode).toBe(false);
  expect(s.annotInstruction).toBe('');
  s.setAnnotMode(true); s.setAnnotInstruction('改成绿色');
  expect(useDesignStore.getState().annotMode).toBe(true);
  expect(useDesignStore.getState().annotInstruction).toBe('改成绿色');
  s.setAnnotMode(false); s.setAnnotInstruction(''); // 复位
});
```
- [ ] **Step 2: 跑测试失败** → FAIL
- [ ] **Step 3: 实现** — 同 `imageModel` 范式加 `annotMode: boolean`（初值 false）+ `annotInstruction: string`（初值 ''）+ 两 setter。**注意：标注模式是瞬时 UI 态，不进 persist partialize**（与 imageModel 不同——只把 imageModel 持久化，annotMode/annotInstruction 不持久化）。
- [ ] **Step 4: 跑测试通过 + typecheck** → PASS / 0
- [ ] **Step 5: 提交** — `git commit -m "feat(annot): designStore 标注模式+指令瞬时态"`

## Task B2: AnnotationLayer（konva 笔/箭头/矩形/文字）

**Files:** Create `src/renderer/components/design/AnnotationLayer.tsx`；Test `tests/renderer/design/annotationLayer.test.tsx`

- [ ] **Step 1: 设计接口（拆纯函数 + 组件）**
```ts
export type AnnotShape =
  | { kind: 'pen'; points: number[]; color: string }
  | { kind: 'arrow'; points: [number, number, number, number]; color: string }
  | { kind: 'rect'; x: number; y: number; w: number; h: number; color: string }
  | { kind: 'text'; x: number; y: number; text: string; color: string };
export const ANNOT_COLOR = '#ef4444'; // 红
// 纯归约器（可单测，不依赖 konva）：把指针事件序列归约成 shapes。
export function reduceAnnot(shapes: AnnotShape[], evt: AnnotEvent): AnnotShape[];
```
- [ ] **Step 2: 写失败测试**（测纯归约器，不测 konva 渲染）
```ts
it('reduceAnnot：开始画笔→追加点→结束，得到一条 pen', () => {
  let s: AnnotShape[] = [];
  s = reduceAnnot(s, { type: 'down', tool: 'pen', x: 1, y: 1 });
  s = reduceAnnot(s, { type: 'move', x: 2, y: 2 });
  s = reduceAnnot(s, { type: 'up' });
  expect(s).toHaveLength(1);
  expect(s[0].kind).toBe('pen');
  expect((s[0] as any).points).toEqual([1, 1, 2, 2]);
});
it('reduceAnnot：矩形拖拽 down→move→up 得到一个 rect', () => {
  let s: AnnotShape[] = [];
  s = reduceAnnot(s, { type: 'down', tool: 'rect', x: 0, y: 0 });
  s = reduceAnnot(s, { type: 'move', x: 10, y: 20 });
  s = reduceAnnot(s, { type: 'up' });
  expect(s[0]).toMatchObject({ kind: 'rect', x: 0, y: 0, w: 10, h: 20 });
});
```
- [ ] **Step 3: 跑测试失败 → 实现 reduceAnnot + AnnotationLayer 组件**（konva `Layer` 渲染 shapes：pen→`Line`、arrow→`Arrow`、rect→`Rect` 描边、text→`Text`；工具/颜色固定红；文字工具 down 时弹输入。组件渲染部分参照 `DesignCanvas.tsx` 既有 konva 用法）。
- [ ] **Step 4: 跑测试通过 + typecheck**
- [ ] **Step 5: 提交** — `git commit -m "feat(annot): AnnotationLayer konva 笔/箭头/矩形/文字 + 纯归约器"`

## Task B3: 合成导出（[原图+标注] → PNG dataURL）

**Files:** Modify `AnnotationLayer.tsx`（或新 `annotComposite.ts`）；Test `tests/renderer/design/annotComposite.test.ts`

- [ ] **Step 1: 写失败测试**（纯函数：给定原图 dataURL 尺寸 + shapes，产出合成 canvas 的命令序列 / 或验证导出尺寸=原图尺寸）。用离屏 `OffscreenCanvas`/node-canvas 若不可用则测「合成参数计算」纯函数（shapes 坐标按原图分辨率缩放）。
```ts
it('合成按原图分辨率缩放标注坐标（画布显示 512、原图 1024 → ×2）', () => {
  const ops = composeAnnotOps({ naturalW: 1024, naturalH: 1024, displayW: 512, displayH: 512,
    shapes: [{ kind: 'rect', x: 10, y: 10, w: 20, h: 20, color: '#ef4444' }] });
  expect(ops[0]).toMatchObject({ kind: 'rect', x: 20, y: 20, w: 40, h: 40 });
});
```
- [ ] **Step 2-4: 失败→实现 `composeAnnotOps`（纯坐标变换）+ `exportAnnotatedPng`（konva stage.toDataURL，按 `pixelRatio = natural/display`）→ 通过 + typecheck**
- [ ] **Step 5: 提交** — `git commit -m "feat(annot): 标注合成导出(按原图分辨率拍扁 PNG)"`

## Task B4: composer 接线（模式/指令/模型下拉/成本/spine）

**Files:** Modify `DesignWorkspace.tsx` + `useDesignCanvasGeneration.ts`；Test：typecheck + `tests/renderer/design` 回归（无脆 DesignWorkspace 渲染测，沿用 P1 Task 7 判断）

- [ ] **Step 1: useDesignCanvasGeneration 加 `editByAnnotation()`**：取选中图节点 → `exportAnnotatedPng` 得 dataURL → 估算 ¥ confirm → `window.domainAPI.invoke(IPC_DOMAINS.WORKSPACE, 'editImageByAnnotation', { model: form.imageModel, annotatedImageDataUrl, instruction: form.annotInstruction, outputPath })` → `res.success && res.data` 解包 → `buildVariantNode({ parentId: 源图 groupKey, ... })` → `addNode` + `saveCanvasDoc`。
- [ ] **Step 2: DesignWorkspace 接 UI**：`imageMode` 下加「标注重绘」模式开关（`annotMode`）；开启时挂 `<AnnotationLayer/>` + 指令输入框（`annotInstruction`）+ 模型下拉（`imageModelsWithCap('annotEdit')` ∩ `listVisualImageModels` 可用性）+「重绘」按钮（调 `editByAnnotation`）+ 成本徽标（gpt-image-2 ¥0.25）。
- [ ] **Step 3: typecheck + `npx vitest run tests/renderer/design`** → 0 / 全绿
- [ ] **Step 4: 提交** — `git commit -m "feat(annot): composer 接标注重绘(模式/指令/cap下拉/成本/spine)"`

## Task B5: i18n

**Files:** Modify `src/renderer/i18n/{en,zh}.ts`（en 先，类型源）

- [ ] **Step 1: 加 design 段 key**（en 先 zh 后，typecheck 验类型平价）
```ts
// en: annotMode:'Annotate & redraw' / annotInstruction:'Redraw instruction' /
//     annotInstructionPlaceholder:'e.g. change the circled logo to a cat head, remove annotations' /
//     annotRedraw:'Redraw' / annotToolPen/Arrow/Rect/Text:'Pen'/'Arrow'/'Rect'/'Text'
// zh: 标注重绘 / 重绘指令 / 例：把红圈处 logo 改成猫头，去掉标注线 / 重绘 / 笔/箭头/矩形/文字
```
组件里所有文案走 i18n hook，不硬编码。
- [ ] **Step 2: typecheck** → 0（zh 缺键会编译失败）
- [ ] **Step 3: 提交** — `git commit -m "feat(annot): i18n 标注重绘文案(zh/en)"`

## Task B6: 全量验证 + 付费 dogfood

- [ ] **Step 1: 确定性门** — typecheck 0；`npx vitest run tests/renderer/design tests/shared/constants/visualModels.test.ts tests/unit/services/media/imageGenerationService.test.ts tests/unit/ipc/workspaceDesignImage.test.ts` 全绿；capability 测绿；`npm run build && npm run build:web` 双 0。
- [ ] **Step 2: 付费 dogfood（提示成本）** — web 后端 recipe，跑一次端到端真标注重绘（约 ¥0.25），验落盘 + 按指令改 + 挂 spine（parentId=源图）。**跑前停下来确认成本。**
- [ ] **Step 3: 对抗审计** — 前端合成保真 + 后端再扫一遍（codex-audit 或独立子 agent）。

---

## Self-Review（写完已核）

- **Spec 覆盖**：A1 cap→A1；A2 标注烘截图→B2/B3；A3 工具栏→B2；A4 edits 端点→A2；A5 spine→B4；A6 成本→B4；A7 SSRF/路径→A3（edits 走 b64 不触发下载，路径守卫在 A3）。硬门→A4。✅
- **Placeholder**：无 TBD/TODO；konva 渲染细节显式指向「参照 DesignCanvas 既有用法」并把可单测的逻辑（reduceAnnot/composeAnnotOps）拆成纯函数给了完整测试。✅
- **类型一致**：`editImageByAnnotation` 入参 `{engine,annotatedImageDataUrl,instruction}` 在 A2 服务与 A3 IPC 一致；IPC payload `{model,annotatedImageDataUrl,instruction,outputPath}` 与 B4 invoke 一致；`imageModelsWithCap`/`annotEdit` 跨 A1/A3/B4 一致；`AnnotShape`/`reduceAnnot`/`composeAnnotOps` 跨 B2/B3 一致。✅

---

## 执行交接

实现走 **subagent-driven-development**：每 Task 派新 subagent + 两段审查。**Phase A 必须先于 Phase B**；A4 硬门 dogfood 关门则停。高风险 A2/A3（计费/multipart/能力闸）+ B3（合成保真）补对抗审计。付费 dogfood（A4/B6）前提示成本。
