# 设计模式 P1 生图模型切换器 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让设计模式的文生图能在 wanx / CogView / FLUX 间切换，只列用户已配 key 的视觉模型；mask 类 op（局部重绘/扩图/去水印）保持 wanx 不变。

**Architecture:** 新增能力标签化「视觉模型注册表」（shared 纯数据）作单一真源；`generateDesignImage` IPC 加 `model` 参数按注册表的 engine 路由到现有 `generateImage(engine,...)`；新增 `listVisualImageModels` IPC 在主进程按已配 key 标注可用性（key 逻辑不出主进程）；composer 加生图模型下拉，选择持久化进 designStore。

**Tech Stack:** TypeScript / React / Zustand / esbuild(main)+Vite(renderer) / vitest。

**前置**：spec `docs/designs/design-mode-model-switcher.md`（D1–D7）。worktree `code-agent-modelswitch`，分支 `feat/design-model-switcher`（基于 v0.18.0 后的 main）。

**纪律**：TDD / i18n(zh+en 同步) / 禁硬编码（模型/价进 constants）/ 新 renderer IPC 必须登记 `src/main/shellCapabilities.ts` WORKSPACE 数组 / 每任务跑 `npm run typecheck` + 受影响测试 / 频繁提交。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `src/shared/constants/visualModels.ts` | 视觉模型注册表（image 部分）+ 纯查询函数 | 新增 |
| `src/shared/constants/pricing.ts` | 补 cogview/flux 实际模型价 | 改 |
| `src/main/ipc/workspace.ipc.ts` | `generateDesignImage` 加 model 路由 + 新 `listVisualImageModels` | 改 |
| `src/main/shellCapabilities.ts` | 登记 `listVisualImageModels` | 改 |
| `src/renderer/components/design/designStore.ts` | 表单加 `imageModel` 字段 + setter（持久化） | 改 |
| `src/renderer/components/design/useDesignCanvasGeneration.ts` | generate payload 带 `model` | 改 |
| `src/renderer/components/design/ImageModelPicker.tsx` | 生图模型下拉（含可用性灰显） | 新增 |
| `src/renderer/components/design/DesignWorkspace.tsx` | composer 挂 ImageModelPicker（仅图像产物） | 改 |
| `src/renderer/i18n/{zh,en}.ts` | 文案 | 改 |
| 对应 `tests/**` | 单测 | 新增/改 |

---

## Task 1: 视觉模型注册表（image）

**Files:**
- Create: `src/shared/constants/visualModels.ts`
- Test: `tests/shared/constants/visualModels.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// tests/shared/constants/visualModels.test.ts
import { describe, it, expect } from 'vitest';
import {
  IMAGE_MODELS, imageModelById, imageEngineForModel, defaultImageModelId,
} from '../../../src/shared/constants/visualModels';

describe('visualModels registry (image)', () => {
  it('含 wanx/cogview/flux 三模型且都带 t2i 能力', () => {
    const ids = IMAGE_MODELS.map((m) => m.id);
    expect(ids).toContain('wanx-t2i');
    expect(ids).toContain('gpt-image-2');
    expect(ids).toContain('cogview-4');
    expect(ids).toContain('flux-2');
    expect(IMAGE_MODELS.every((m) => m.caps.includes('t2i'))).toBe(true);
    // gpt-image-2 只 t2i（mask 类 op 仍 wanx，D2）
    expect(imageModelById('gpt-image-2')?.caps).toEqual(['t2i']);
    expect(imageEngineForModel('gpt-image-2')).toBe('gptimage');
  });
  it('只有 wanx 带 maskEdit/expand 能力（D2）', () => {
    expect(imageModelById('wanx-t2i')?.caps).toEqual(expect.arrayContaining(['maskEdit', 'expand']));
    expect(imageModelById('cogview-4')?.caps).not.toContain('maskEdit');
    expect(imageModelById('flux-2')?.caps).not.toContain('expand');
  });
  it('imageEngineForModel 映射到 generateImage 的 engine', () => {
    expect(imageEngineForModel('wanx-t2i')).toBe('wanx');
    expect(imageEngineForModel('cogview-4')).toBe('cogview');
    expect(imageEngineForModel('flux-2')).toBe('flux');
  });
  it('默认模型是 wanx（设计模式钦定底座）', () => {
    expect(defaultImageModelId()).toBe('wanx-t2i');
  });
  it('未知 id 返回 undefined / 抛错', () => {
    expect(imageModelById('nope')).toBeUndefined();
    expect(() => imageEngineForModel('nope')).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/shared/constants/visualModels.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写实现**

```ts
// src/shared/constants/visualModels.ts
// 视觉生成模型注册表（D1 单一真源）。只含「出图/出视频」模型，绝不含聊天模型（D7）。
// P1 仅 image 部分；video 部分在 P2 追加。

export type ImageCap = 't2i' | 'maskEdit' | 'expand';
export type ImageEngineId = 'wanx' | 'cogview' | 'flux' | 'gptimage';
export type VisualProviderId = 'dashscope' | 'zhipu' | 'openrouter' | 'gptimage';

export interface VisualImageModel {
  /** 切换器/持久化用的稳定选择键。 */
  id: string;
  /** UI 显示名（i18n 在 label 之外另给，本字段是中性名）。 */
  label: string;
  provider: VisualProviderId;
  /** 路由到 imageGenerationService.generateImage 的 engine。 */
  engine: ImageEngineId;
  caps: ImageCap[];
}

export const IMAGE_MODELS: readonly VisualImageModel[] = [
  { id: 'wanx-t2i', label: '通义万相', provider: 'dashscope', engine: 'wanx', caps: ['t2i', 'maskEdit', 'expand'] },
  { id: 'gpt-image-2', label: 'GPT-image-2', provider: 'gptimage', engine: 'gptimage', caps: ['t2i'] },
  { id: 'cogview-4', label: 'CogView-4', provider: 'zhipu', engine: 'cogview', caps: ['t2i'] },
  { id: 'flux-2', label: 'FLUX.2', provider: 'openrouter', engine: 'flux', caps: ['t2i'] },
];

export function imageModelById(id: string): VisualImageModel | undefined {
  return IMAGE_MODELS.find((m) => m.id === id);
}

export function imageEngineForModel(id: string): ImageEngineId {
  const m = imageModelById(id);
  if (!m) throw new Error(`未知生图模型 id: ${id}`);
  return m.engine;
}

/** 默认走 wanx——设计模式底座（mask/扩图都依赖它）。 */
export function defaultImageModelId(): string {
  return 'wanx-t2i';
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/shared/constants/visualModels.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/shared/constants/visualModels.ts tests/shared/constants/visualModels.test.ts
git commit -m "feat(design): 视觉模型注册表(image) — 能力标签化单一真源"
```

---

## Task 2: 补 CogView/FLUX 实际模型价

**Files:**
- Modify: `src/shared/constants/pricing.ts`
- Test: `tests/shared/media/imageCost.test.ts`（已存在，追加用例）

**背景**：`handleGenerateDesignImage` 用 `estimateImageCostCny(actualModel)` 算价，`actualModel` 是 `generateImage` 返回的真实模型串（wanx→`wanx2.1-t2i-turbo`、cogview→`ZHIPU_IMAGE_MODELS.standard`、flux→其 flux 模型串）。切到非 wanx 后这些串必须在价表里有项，否则成本显示 0/未知。

- [ ] **Step 1: 先确认实际模型串**

Run: `grep -nE "ZHIPU_IMAGE_MODELS|WANX_T2I_MODEL|actualModel: '|return \{ imageData.*actualModel" src/main/services/media/imageGenerationService.ts`
记下 cogview / flux 分支返回的 `actualModel` 常量值（如 `ZHIPU_IMAGE_MODELS.standard` 的字面值、flux 模型串）。

- [ ] **Step 2: 写失败测试**

```ts
// 追加到 tests/shared/media/imageCost.test.ts
import { IMAGE_PRICING_CNY } from '../../../src/shared/constants/pricing';
it('cogview/flux 实际模型在价表里有非负价', () => {
  // 用 Step 1 查到的真实模型串替换下面两个常量
  const cogviewModel = '<ZHIPU standard 模型串>';
  const fluxModel = '<flux 模型串>';
  expect(IMAGE_PRICING_CNY[cogviewModel]).toBeGreaterThanOrEqual(0);
  expect(IMAGE_PRICING_CNY[fluxModel]).toBeGreaterThanOrEqual(0);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/shared/media/imageCost.test.ts`
Expected: FAIL（缺价表项 → undefined）

- [ ] **Step 4: 加价表项**

在 `pricing.ts` 的 `IMAGE_PRICING_CNY`（或等价价表对象）补上两个模型串的价（按各 provider 官网定价填实际值；查不到先填保守估值并加注释 `// TODO 待核实` —— 注：本计划禁 placeholder，故此处必须填一个具体数字，例如 cogview 0.06、flux 0.10，并在 PR 描述里标注来源）。

- [ ] **Step 5: 跑测试确认通过 + 提交**

Run: `npx vitest run tests/shared/media/imageCost.test.ts` → PASS
```bash
git add src/shared/constants/pricing.ts tests/shared/media/imageCost.test.ts
git commit -m "feat(design): 价表补 cogview/flux 模型价(切模后成本可见)"
```

---

## Task 3: `generateDesignImage` 加 model 路由

**Files:**
- Modify: `src/main/ipc/workspace.ipc.ts`（`handleGenerateDesignImage` + dispatch case）
- Test: `tests/unit/ipc/workspaceDesignImage.test.ts`（已存在，追加）

- [ ] **Step 1: 写失败测试**

```ts
// 追加到 tests/unit/ipc/workspaceDesignImage.test.ts
// mock imageGenerationService.generateImage，断言 model='cogview-4' 时以 engine='cogview' 调用
it('generateDesignImage 按 model 路由到对应 engine', async () => {
  const generateImage = vi.fn().mockResolvedValue({ imageData: 'data:image/png;base64,AAA', actualModel: '<cogview模型串>' });
  vi.doMock('../../../src/main/services/media/imageGenerationService', () => ({
    generateImage, isImageUrl: () => false, downloadImageAsBase64: async (x: string) => x,
  }));
  // 调 handler（按本测试文件已有的调用范式），payload 带 model: 'cogview-4'
  // 断言 generateImage 第一个实参 === 'cogview'
  expect(generateImage).toHaveBeenCalledWith('cogview', expect.anything(), expect.any(String), expect.any(String));
});
it('缺 model 时回退默认 wanx engine', async () => {
  // 不传 model → engine 应为 'wanx'
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/ipc/workspaceDesignImage.test.ts`
Expected: FAIL（当前硬编码 'wanx'，cogview 用例不通过）

- [ ] **Step 3: 改 handler**

```ts
// workspace.ipc.ts 顶部 import 加：
import { imageEngineForModel, defaultImageModelId } from '../../shared/constants/visualModels';

// handleGenerateDesignImage 签名加 model?:
async function handleGenerateDesignImage(
  payload: { prompt: string; aspectRatio?: string; outputPath: string; model?: string },
): Promise<{ path: string; actualModel: string; costCny: number }> {
  if (!payload?.prompt || !payload?.outputPath) {
    throw new Error('generateDesignImage 需要 prompt 与 outputPath');
  }
  assertWithinDesignDir(payload.outputPath, 'outputPath');
  const engine = imageEngineForModel(payload.model || defaultImageModelId());
  const { generateImage, downloadImageAsBase64, isImageUrl } = await import(
    '../services/media/imageGenerationService'
  );
  const { imageData, actualModel } = await generateImage(engine, '', payload.prompt, payload.aspectRatio || '1:1');
  const dataUrl = isImageUrl(imageData) ? await downloadImageAsBase64(imageData) : imageData;
  const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
  const buf = Buffer.from(base64, 'base64');
  await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
  await fsp.writeFile(payload.outputPath, buf);
  return { path: payload.outputPath, actualModel, costCny: estimateImageCostCny(actualModel) };
}
```
并在 dispatch 的 `case 'generateDesignImage':` 的 payload 类型断言上加 `model?: string`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/ipc/workspaceDesignImage.test.ts` → PASS
Run: `npm run typecheck` → 0

- [ ] **Step 5: 提交**

```bash
git add src/main/ipc/workspace.ipc.ts tests/unit/ipc/workspaceDesignImage.test.ts
git commit -m "feat(design): generateDesignImage 按 model 路由 engine(默认 wanx)"
```

---

## Task 4: `listVisualImageModels` IPC（按已配 key 标可用性）

**Files:**
- Modify: `src/main/ipc/workspace.ipc.ts`（新 handler + dispatch case）
- Modify: `src/main/shellCapabilities.ts`（登记 action）
- Test: `tests/unit/ipc/workspaceDesignImage.test.ts`（追加）

- [ ] **Step 1: 写失败测试**

```ts
it('listVisualImageModels 返回全模型并按 key 标 available', async () => {
  // mock：getDashscopeApiKey 真、getZhipuOfficialApiKey 假、openrouter 假
  // 期望 wanx-t2i.available=true，cogview-4/flux-2.available=false，且每项带 label/provider
  const res = await callDispatch('listVisualImageModels', {});
  const byId = Object.fromEntries(res.data.models.map((m: any) => [m.id, m]));
  expect(byId['wanx-t2i'].available).toBe(true);
  expect(byId['cogview-4'].available).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/ipc/workspaceDesignImage.test.ts`
Expected: FAIL（action 未知）

- [ ] **Step 3: 写 handler + 登记**

```ts
// workspace.ipc.ts
import { IMAGE_MODELS } from '../../shared/constants/visualModels';

function providerKeyConfigured(provider: string): boolean {
  // key 逻辑只在主进程；复用现有 getter，不向 renderer 暴露 key。
  const { getDashscopeApiKey, getZhipuOfficialApiKey } = require('../services/media/imageGenerationService');
  const configService = getConfigService();
  if (provider === 'dashscope') return !!getDashscopeApiKey();
  if (provider === 'zhipu') return !!getZhipuOfficialApiKey();
  if (provider === 'openrouter') return !!configService.getApiKey('openrouter');
  return false;
}

async function handleListVisualImageModels(): Promise<{ models: Array<{ id: string; label: string; provider: string; available: boolean }> }> {
  return {
    models: IMAGE_MODELS.map((m) => ({ id: m.id, label: m.label, provider: m.provider, available: providerKeyConfigured(m.provider) })),
  };
}
```
dispatch 加：
```ts
case 'listVisualImageModels':
  data = await handleListVisualImageModels();
  break;
```
`shellCapabilities.ts` 的 `[IPC_DOMAINS.WORKSPACE]` 数组按字母序插入 `'listVisualImageModels'`（在 `'listRecent'` 之后、`'openPath'` 之前）。

> ⚠️ 若 `getZhipuOfficialApiKey`/`getDashscopeApiKey` 未 export，先在 `imageGenerationService.ts` 给它们加 `export`（`getZhipuOfficialApiKey` 当前是模块私有，`getDashscopeApiKey` 已 export）。

- [ ] **Step 4: 跑测试 + capability-diff 自检 + 提交**

Run: `npx vitest run tests/unit/ipc/workspaceDesignImage.test.ts` → PASS
Run: `npm run typecheck` → 0
```bash
git add src/main/ipc/workspace.ipc.ts src/main/shellCapabilities.ts src/main/services/media/imageGenerationService.ts tests/unit/ipc/workspaceDesignImage.test.ts
git commit -m "feat(design): listVisualImageModels IPC(按已配key标可用)+登记shell能力"
```

---

## Task 5: designStore 加 `imageModel` 字段

**Files:**
- Modify: `src/renderer/components/design/designStore.ts`
- Test: `tests/renderer/design/designStore.test.ts`（若无则新建）

- [ ] **Step 1: 写失败测试**

```ts
it('designStore 默认 imageModel = wanx-t2i 且可 set', () => {
  const s = useDesignStore.getState();
  expect(s.imageModel).toBe('wanx-t2i');
  s.setImageModel('cogview-4');
  expect(useDesignStore.getState().imageModel).toBe('cogview-4');
});
```

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run tests/renderer/design/designStore.test.ts` → FAIL

- [ ] **Step 3: 加字段**

在 store 接口、初值、setter 三处加（与 `aspectRatio` 同构）：
```ts
import { defaultImageModelId } from '../../../shared/constants/visualModels';
// interface: imageModel: string; setImageModel: (id: string) => void;
// 初值: imageModel: defaultImageModelId(),
// setter: setImageModel: (imageModel) => set({ imageModel }),
```
（designStore 已 persist，新字段自动持久化。）

- [ ] **Step 4: 跑测试通过 + typecheck + 提交**

```bash
git add src/renderer/components/design/designStore.ts tests/renderer/design/designStore.test.ts
git commit -m "feat(design): designStore 持久化 imageModel 选择"
```

---

## Task 6: ImageModelPicker 下拉组件

**Files:**
- Create: `src/renderer/components/design/ImageModelPicker.tsx`
- Modify: `src/renderer/i18n/{zh,en}.ts`
- Test: `tests/renderer/design/imageModelPicker.test.tsx`

- [ ] **Step 1: 加 i18n key**（zh + en 同步，en 是类型源）

```ts
// design 段加：
imageModel: '生图模型',            // en: 'Image model'
imageModelUnconfigured: '未配置 Key', // en: 'No API key'
imageModelConfigHint: '去设置配置', // en: 'Configure in Settings'
```

- [ ] **Step 2: 写失败测试**（renderToStaticMarkup 真组件，吃 props，绕 SSR zustand 坑 —— 参照 T2 DesignCostHistory 拆 View 的范式）

```tsx
// 组件设计为受控展示：props = { models: {id,label,available}[], value, onChange }
import { renderToStaticMarkup } from 'react-dom/server';
import { ImageModelPickerView } from '../../../src/renderer/components/design/ImageModelPicker';
it('渲染全部模型，未配 key 的标灰+提示', () => {
  const html = renderToStaticMarkup(
    <ImageModelPickerView
      models={[{ id: 'wanx-t2i', label: '通义万相', available: true }, { id: 'cogview-4', label: 'CogView-4', available: false }]}
      value="wanx-t2i" onChange={() => {}}
    />,
  );
  expect(html).toContain('通义万相');
  expect(html).toContain('CogView-4');
  expect(html).toMatch(/disabled|opacity|未配置 Key/);
});
```

- [ ] **Step 3: 跑测试失败** → FAIL（组件不存在）

- [ ] **Step 4: 写组件**（拆 `ImageModelPickerView`(纯展示, 吃 props) + `ImageModelPicker`(容器: 进 design 模式时 invoke `listVisualImageModels`, 接 designStore value/onChange)）

```tsx
// ImageModelPicker.tsx
import { useEffect, useState } from 'react';
import { useTranslation } from '../../i18n';            // 按现有 i18n hook 实际路径
import { useDesignStore } from './designStore';
import { IPC_DOMAINS } from '../../../shared/ipc/domains';

export interface ModelOption { id: string; label: string; available: boolean; }
export function ImageModelPickerView({ models, value, onChange }: {
  models: ModelOption[]; value: string; onChange: (id: string) => void;
}) {
  // 一个原生 <select>：available=false 的 <option disabled> + 灰显；够用、零依赖。
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} data-testid="design-image-model">
      {models.map((m) => (
        <option key={m.id} value={m.id} disabled={!m.available}
          style={!m.available ? { opacity: 0.5 } : undefined}>
          {m.label}{m.available ? '' : ' · 未配置 Key'}
        </option>
      ))}
    </select>
  );
}
export function ImageModelPicker() {
  const { imageModel, setImageModel } = useDesignStore();
  const [models, setModels] = useState<ModelOption[]>([]);
  useEffect(() => {
    window.domainAPI?.invoke<{ models: ModelOption[] }>(IPC_DOMAINS.WORKSPACE, 'listVisualImageModels', {})
      .then((r) => { if (r?.success && r.data) setModels(r.data.models); });
  }, []);
  return <ImageModelPickerView models={models} value={imageModel} onChange={setImageModel} />;
}
```
（文案用 i18n hook 替换字面量；上面字面量仅示意。）

- [ ] **Step 5: 跑测试通过 + typecheck + 提交**

```bash
git add src/renderer/components/design/ImageModelPicker.tsx src/renderer/i18n/zh.ts src/renderer/i18n/en.ts tests/renderer/design/imageModelPicker.test.tsx
git commit -m "feat(design): ImageModelPicker 下拉(只列已配key模型,灰显未配)"
```

---

## Task 7: composer 挂 picker（仅图像产物）+ generate 带 model

**Files:**
- Modify: `src/renderer/components/design/DesignWorkspace.tsx`（composer 区，`isImageOutput(outputType)` 时渲染 `<ImageModelPicker/>`，挨着 aspectRatio 选择器）
- Modify: `src/renderer/components/design/useDesignCanvasGeneration.ts`（generate 的 IPC payload 加 `model: useDesignStore.getState().imageModel`）

- [ ] **Step 1: 改 generate payload**

```ts
// useDesignCanvasGeneration.ts generate() 里那处 generateDesignImage 调用：
{ prompt, aspectRatio: form.aspectRatio, outputPath: assetAbs, model: form.imageModel },
```
（`form` 已从 designStore 取；确认 `imageModel` 在该 form 快照里，否则 `useDesignStore.getState().imageModel`。）

- [ ] **Step 2: composer 挂 picker**

在 DesignWorkspace composer 中，`isImageOutput(outputType)` 分支里、aspect ratio 选择器旁加：
```tsx
<ImageModelPicker />
```
import `ImageModelPicker`。

- [ ] **Step 3: typecheck + 受影响测试**

Run: `npm run typecheck` → 0
Run: `npx vitest run tests/renderer/design` → 全绿

- [ ] **Step 4: 提交**

```bash
git add src/renderer/components/design/DesignWorkspace.tsx src/renderer/components/design/useDesignCanvasGeneration.ts
git commit -m "feat(design): composer 接生图模型下拉 + generate 带 model"
```

---

## Task 8: 全量验证 + dogfood

- [ ] **Step 1: 确定性门**

Run: `npm run typecheck` → 0
Run: `npx vitest run tests/renderer/design tests/shared/constants/visualModels.test.ts tests/shared/media/imageCost.test.ts tests/unit/ipc/workspaceDesignImage.test.ts` → 全绿
Run: capability-diff（base=origin/main，head=.，`--fail-on-unsupported`）→ `listVisualImageModels` 已登记，PASS

- [ ] **Step 2: 构建**

Run: `npm run build && npm run build:web` → 双 EXIT 0

- [ ] **Step 3: 付费 dogfood（提示成本）**

> ⚠️ 真实付费：切 **gpt-image-2** 出 1 张（约 ¥0.1–0.3，端点 `jiuuij.de5.net` 的 key 已存 `~/.code-agent/.env` 的 `GPTIMAGE_PROXY_BASE/_KEY`）+ 切 CogView/FLUX 各 1 张（各约 ¥0.06–0.10，需用户在设置配 zhipu / openrouter key）。
> 走 v0.18.0 验证过的 recipe：web 后端 `node dist/web/webServer.cjs`(8180) + `POST /api/domain/workspace/listVisualImageModels`（验可用性标注，gpt-image-2 应为 available=true）+ `generateDesignImage{...,model:'gpt-image-2'}`（验真出图 + actualModel='gpt-image-2' + costCny>0 + 落盘 PNG 文字清晰）。
> gpt-image-2 出图慢（~30–60s）且中转偶尔超时，dogfood 设 timeout ≥120s，失败重试一次。

- [ ] **Step 4: 提交 dogfood 证据说明（无代码改动则跳过提交）**

---

## Task 9: gptimage engine（gpt-image-2，自定义 OpenAI 兼容端点）

**Files:**
- Modify: `src/main/services/media/imageGenerationService.ts`（`ImageEngine` 加 `gptimage` + 分支 + `getGptImageConfig`）
- Test: `tests/unit/services/media/imageGenerationService.test.ts`（追加）

**背景**：gpt-image-2 经第三方中转 `jiuuij.de5.net`（OpenAI 兼容 `/v1/images/generations`，返回 **b64_json**）。base+key 从 env `GPTIMAGE_PROXY_BASE/_KEY` 优先、再回落 config（同 `getDashscopeApiKey` 范式），**不进代码**。设计场景**不加 NO_TEXT**（gpt-image 强在出文字/UI）。

- [ ] **Step 1: 写失败测试**（mock fetch 返回 `{data:[{b64_json:'AAA'}]}`）

```ts
it('gptimage engine 调 /v1/images/generations 取 b64，不加 NO_TEXT', async () => {
  process.env.GPTIMAGE_PROXY_BASE = 'https://example.test';
  process.env.GPTIMAGE_PROXY_KEY = 'sk-test';
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ b64_json: 'AAA' }] }) });
  vi.stubGlobal('fetch', fetchMock);
  const { generateImage } = await import('../../../../src/main/services/media/imageGenerationService');
  const r = await generateImage('gptimage', '', '深色仪表盘', '1:1');
  expect(r.actualModel).toBe('gpt-image-2');
  expect(r.imageData.startsWith('data:image/png;base64,')).toBe(true);
  const body = JSON.parse(fetchMock.mock.calls[0][1].body);
  expect(body.model).toBe('gpt-image-2');
  expect(body.prompt).not.toMatch(/不要出现任何文字/); // 设计场景保留文字
});
it('gptimage 缺 key 报去设置配置', async () => {
  delete process.env.GPTIMAGE_PROXY_KEY;
  // 且 config 无 gptimage key → 抛含「配置」字样错误
});
```

- [ ] **Step 2: 跑测试确认失败** → `npx vitest run tests/unit/services/media/imageGenerationService.test.ts` → FAIL

- [ ] **Step 3: 写实现**

```ts
// imageGenerationService.ts
// ImageEngine 类型加 'gptimage'：
export type ImageEngine = 'cogview' | 'flux' | 'wanx' | 'gptimage';

export function getGptImageConfig(): { base: string; key: string } | undefined {
  const base = process.env.GPTIMAGE_PROXY_BASE || getConfigService().getApiKey('gptimage-base');
  const key = process.env.GPTIMAGE_PROXY_KEY || getConfigService().getApiKey('gptimage');
  if (!base || !key) return undefined;
  return { base: base.replace(/\/+$/, ''), key };
}

// generateImage 里加分支（在 wanx 分支同级，用 raw prompt 不加 NO_TEXT）：
if (engine === 'gptimage') {
  const cfg = getGptImageConfig();
  if (!cfg) throw new Error('gpt-image-2 需要在设置配置自定义端点 base 与 API Key。');
  const resp = await fetchWithAbort(`${cfg.base}/v1/images/generations`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-image-2', prompt, n: 1, size: '1024x1024' }),
  }, TIMEOUT_MS.IMAGE_GENERATION ?? 120000, outerSignal);
  if (!resp.ok) throw new Error(`gpt-image-2 生成失败: ${resp.status}`);
  const json = await resp.json();
  const b64 = json?.data?.[0]?.b64_json;
  if (!b64) throw new Error('gpt-image-2 返回无 b64_json');
  return { imageData: `data:image/png;base64,${b64}`, actualModel: 'gpt-image-2' };
}
```
（`'gpt-image-2'` 模型串与价表、注册表一致；其价表项在 Task 2 一并补。size 暂固定 1024x1024，aspectRatio→size 映射留后续。）

- [ ] **Step 4: 跑测试通过 + typecheck** → PASS / 0

- [ ] **Step 5: 提交**

```bash
git add src/main/services/media/imageGenerationService.ts tests/unit/services/media/imageGenerationService.test.ts
git commit -m "feat(design): gptimage engine — gpt-image-2 自定义端点(b64,不加NO_TEXT)"
```

> **联动**：Task 2 价表加 `'gpt-image-2'` 项；Task 4 `providerKeyConfigured` 加 `if (provider === 'gptimage') return !!getGptImageConfig();`。

---

## Task 10: url 下载 SSRF 守卫（D9）

**Files:**
- Modify: `src/main/services/media/imageGenerationService.ts`（`isImageUrl` 收紧 + 下载前校验）
- Test: `tests/unit/services/media/imageGenerationService.test.ts`（追加）

**背景**：`isImageUrl` 现在放行 `http://` 且不拦内网 IP；恶意中转返回 url 时可 SSRF。gpt-image-2 走 b64 不触发，但护住 wanx OSS url + 未来返回 url 的模型。

- [ ] **Step 1: 写失败测试**

```ts
import { isSafeImageUrl } from '../../../../src/main/services/media/imageGenerationService';
it('仅允许 https 公网，拒 http/私网/元数据地址', () => {
  expect(isSafeImageUrl('https://dashscope-result.oss-cn.aliyuncs.com/x.png')).toBe(true);
  expect(isSafeImageUrl('http://example.com/x.png')).toBe(false);       // 非 https
  expect(isSafeImageUrl('https://127.0.0.1/x')).toBe(false);
  expect(isSafeImageUrl('https://169.254.169.254/latest/meta-data')).toBe(false);
  expect(isSafeImageUrl('https://192.168.1.10/x')).toBe(false);
  expect(isSafeImageUrl('file:///etc/passwd')).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败** → FAIL（函数不存在）

- [ ] **Step 3: 写实现**

```ts
// imageGenerationService.ts
export function isSafeImageUrl(u: string): boolean {
  let url: URL;
  try { url = new URL(u); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const h = url.hostname;
  if (h === 'localhost') return false;
  // 私网/环回/链路本地 IPv4
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
  }
  if (h === '::1' || h.startsWith('fc') || h.startsWith('fd') || h.startsWith('fe80')) return false;
  return true;
}
```
并在 `downloadImageAsBase64` 开头加：`if (!isSafeImageUrl(url)) throw new Error('拒绝下载不安全的图片 URL');`。`isImageUrl` 保持原样（仅判断"是不是 url 字符串"），安全判断交给 `isSafeImageUrl`。

- [ ] **Step 4: 跑测试通过 + typecheck + 回归**

Run: `npx vitest run tests/unit/services/media/imageGenerationService.test.ts` → PASS
Run: `npm run typecheck` → 0
（注意：wanx 走 dashscope OSS 的 https 公网 url，`isSafeImageUrl` 应放行——回归跑 `tests/unit/services/media` 全绿。）

- [ ] **Step 5: 提交**

```bash
git add src/main/services/media/imageGenerationService.ts tests/unit/services/media/imageGenerationService.test.ts
git commit -m "fix(design): url 下载 SSRF 守卫(仅https公网,拒私网/元数据)"
```

---

## Self-Review（写完已核）

- **Spec 覆盖**：D1 注册表→T1；D2 mask 保持 wanx→T1 caps + T3 未碰 edit/expand handler；D6 只列已配 key→T4+T6；D7 只视觉模型→注册表仅含 image 模型，构造上满足；生图切换→T3+T7。视频(P2/P3) 不在本计划。✅
- **Placeholder**：Task 2 的价表值要求填具体数字（不留 TODO 作为占位）；Task 1 的 cogview/flux 实际模型串在 Task 2 Step 1 查实后回填测试。无 “TBD/handle edge cases” 类空话。
- **类型一致**：`imageModelById/imageEngineForModel/defaultImageModelId/IMAGE_MODELS` 跨 Task 1/3/5 命名一致；`model?: string` 在 IPC payload 与 handler 一致；`ModelOption{id,label,available}` 在 Task 4 IPC 出参与 Task 6 组件 props 一致。✅

---

## 执行交接

实现走 **subagent-driven-development（推荐）**：每 Task 派新 subagent + 两段审查；或 **executing-plans** 批量带检查点。高风险 Task 3/4（IPC/计费/能力闸）建议补 codex-audit。
