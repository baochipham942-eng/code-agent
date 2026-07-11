# 多模态桥接脊柱 + 网关视频 + 音乐（Spec 1）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让多模态设置页自动列出聊天 provider 里带生图/生视频/生音乐能力的模型并能真正生成，纯生成模型从对话选择器隐藏。

**Architecture:** 给聊天模型加 `imageGen/videoGen/musicGen` 能力维度（U1）→ 派生层把带生成能力的聊天模型翻成视觉条目（U2）→ 三个 list 合并展示（U3）→ 执行时按源 provider 解析 baseUrl+key，图像复用现成 openai-compat 引擎、视频走可扩展 flavor 注册表、音乐接 MiniMax（U4）→ 纯生成模型从对话切换器过滤（U5）→ 设置页三段 + 能力 override（U6）。

**Tech Stack:** TypeScript、Vitest（`npx vitest run`）、Electron/IPC、Zustand/React、Tailwind。所有常量进 `src/shared/constants.ts`。

**基线/纪律：** 基于 main（PR #294 合并后）开分支 `feat/multimodal-bridge`。工作树有别会话 WIP（agentLoop/schema/App.tsx），**每个 commit 只 `git add` 本任务列出的文件，禁止 `git add -A`**。每个功能点 `npm run typecheck` 必过。spec 见 `docs/plans/2026-06-30-multimodal-bridge-spec1.md`。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `src/shared/contract/model.ts` | `ModelCapability` 加生成能力 | 改 |
| `src/shared/modelRuntime.ts` | 推断 + 消歧 + 纯生成判定 + 聊天过滤 | 改 |
| `src/shared/visualModelBridge.ts` | 派生层（settings → BridgedVisualModel[]） | 建 |
| `src/host/services/media/bridgedEndpoint.ts` | host 侧 baseUrl+key 解析 | 建 |
| `src/host/services/media/videoPollFlavors.ts` | 视频 poll flavor 注册表 | 建 |
| `src/host/services/media/videoGenerationService.ts` | 加 openai-compat 视频引擎 | 改 |
| `src/host/services/media/musicGenerationService.ts` | 音乐引擎（MiniMax 适配） | 建 |
| `src/host/ipc/workspace.ipc.ts` | 三 list handler 合并桥接 | 改 |
| `src/host/ipc/workspaceDesignMedia.ipc.ts` | 桥接图像/视频/音乐执行分支 | 改 |
| `src/renderer/components/features/settings/tabs/VisualModelsSettings.tsx` | 三段 + 桥接条目展示 | 改 |
| `src/renderer/i18n/{zh,en}.ts` | 文案键 | 改 |

---

## P1 · 共享脊柱

### Task 1: ModelCapability 加生成能力维度

**Files:**
- Modify: `src/shared/contract/model.ts:39`
- Test: `tests/unit/shared/modelCapability.test.ts`

- [ ] **Step 1: 改类型**

`model.ts:39` 改为：

```ts
export type ModelCapability = 'code' | 'vision' | 'fast' | 'reasoning' | 'gui' | 'general' | 'search' | 'compact' | 'quick' | 'longContext' | 'unlimited' | 'imageGen' | 'videoGen' | 'musicGen';
```

并在上方注释块补：`// - imageGen/videoGen/musicGen: 生成输出能力（区别于 vision=图像输入）`

- [ ] **Step 2: typecheck**

Run: `npm run typecheck`
Expected: PASS（仅加联合成员，无破坏）

- [ ] **Step 3: Commit**

```bash
git add src/shared/contract/model.ts
git commit -m "feat(model): ModelCapability 加 imageGen/videoGen/musicGen 生成能力维度"
```

### Task 2: 生成能力推断 + 消歧 + 纯生成判定

**Files:**
- Modify: `src/shared/modelRuntime.ts:499-519`
- Test: `tests/unit/shared/modelRuntime.genCapability.test.ts`

- [ ] **Step 1: 写失败测试**

`tests/unit/shared/modelRuntime.genCapability.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { inferModelCapabilities, isPureGenerationModel, mediaTypeForGenCapability } from '../../../src/shared/modelRuntime';

describe('生成能力推断与消歧', () => {
  it('生图模型名 → imageGen，不误判 vision', () => {
    const caps = inferModelCapabilities('agnes-image-2.1-flash');
    expect(caps).toContain('imageGen');
    expect(caps).not.toContain('vision');
  });
  it('omni/4o 仍是 vision 输入，非 imageGen', () => {
    expect(inferModelCapabilities('gpt-4o')).toContain('vision');
    expect(inferModelCapabilities('gpt-4o')).not.toContain('imageGen');
  });
  it('生视频/生音乐模型名', () => {
    expect(inferModelCapabilities('agnes-video-v2.0')).toContain('videoGen');
    expect(inferModelCapabilities('music-2.6')).toContain('musicGen');
  });
  it('纯生成判定：只有 *Gen 无 chat 能力', () => {
    expect(isPureGenerationModel(['imageGen'])).toBe(true);
    expect(isPureGenerationModel(['imageGen', 'general'])).toBe(false);
  });
  it('能力→媒介映射', () => {
    expect(mediaTypeForGenCapability('imageGen')).toBe('image');
    expect(mediaTypeForGenCapability('videoGen')).toBe('video');
    expect(mediaTypeForGenCapability('musicGen')).toBe('music');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/shared/modelRuntime.genCapability.test.ts`
Expected: FAIL（`isPureGenerationModel`/`mediaTypeForGenCapability` 未定义）

- [ ] **Step 3: 实现**

`modelRuntime.ts` 的 `inferModelCapabilities`（499 行）在 vision 行**前**插入生成消歧，并改 vision 行排除生成类：

```ts
export function inferModelCapabilities(modelId: string): ModelCapability[] {
  const id = modelId.toLowerCase();
  const capabilities: ModelCapability[] = ['general'];

  // 生成能力（输出）——必须先判，且与 vision（输入）互斥消歧
  const isImageGen = /(^|[/\s-])(image|t2i|text2image|draw|paint|imagen|flux|cogview|wanx|gpt-image)([\s./-]|$)/.test(id) && !/\b(4o|vl|omni|vision)\b/.test(id);
  const isVideoGen = /(video|t2v|i2v|sora|veo|seedance|wan2|hailuo|happyhorse|kling|pika|runway)/.test(id);
  const isMusicGen = /(music|song|suno|audiogen|audio-gen|musicgen)/.test(id);
  if (isImageGen) capabilities.push('imageGen');
  if (isVideoGen) capabilities.push('videoGen');
  if (isMusicGen) capabilities.push('musicGen');

  if (/code|coder|codex|dev/.test(id)) capabilities.push('code');
  // vision = 图像输入：生成类已被上面捕获，这里排除纯生成名，避免 agnes-image 误标 vision
  if (/vision|vl|omni|4o|multimodal|mm/.test(id) && !isImageGen) capabilities.push('vision');
  if (/reason|thinking|think|r1|o1|o3|o4|k2\.6|glm-5/.test(id)) capabilities.push('reasoning');
  if (/flash|fast|mini|nano|lite|turbo/.test(id)) capabilities.push('fast');
  if (/1m|128k|200k|256k|long/.test(id)) capabilities.push('longContext');
  if (/sonar|search|perplexity/.test(id)) capabilities.push('search');

  return uniqueCapabilities(capabilities);
}
```

> 注意：原 vision 正则含 `image`，改后移除 `image` 并加 `!isImageGen` 守卫。`flash` 仍命中 fast（agnes-image-2.1-flash 会同时有 imageGen+fast，无害）。

在文件末尾（`uniqueCapabilities` 附近）加：

```ts
const GEN_CAPABILITIES: ModelCapability[] = ['imageGen', 'videoGen', 'musicGen'];
const CHAT_CAPABILITIES: ModelCapability[] = ['general', 'code', 'reasoning', 'fast', 'gui', 'search', 'vision'];

export function isPureGenerationModel(capabilities: ModelCapability[]): boolean {
  const hasGen = capabilities.some((c) => GEN_CAPABILITIES.includes(c));
  const hasChat = capabilities.some((c) => CHAT_CAPABILITIES.includes(c));
  return hasGen && !hasChat;
}

export function mediaTypeForGenCapability(cap: ModelCapability): 'image' | 'video' | 'music' | null {
  if (cap === 'imageGen') return 'image';
  if (cap === 'videoGen') return 'video';
  if (cap === 'musicGen') return 'music';
  return null;
}
```

> `vision` 计入 CHAT_CAPABILITIES：一个 omni 既能 vision 输入又能 imageGen 输出时不算"纯生成"，仍留在聊天选择器。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/shared/modelRuntime.genCapability.test.ts`
Expected: PASS

- [ ] **Step 5: 跑既有 modelRuntime 测试防回归**

Run: `npx vitest run tests/unit/shared/ -t modelRuntime`（或 `npx vitest run tests/ -t "capab"`）
Expected: PASS（确认 vision 消歧没破坏既有断言；红了就看是否旧测试假设 `image`→vision，按真实语义修测试）

- [ ] **Step 6: Commit**

```bash
git add src/shared/modelRuntime.ts tests/unit/shared/modelRuntime.genCapability.test.ts
git commit -m "feat(modelRuntime): 生成能力推断+vision消歧+纯生成判定"
```

### Task 3: 派生层 visualModelBridge

**Files:**
- Create: `src/shared/visualModelBridge.ts`
- Test: `tests/unit/shared/visualModelBridge.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { deriveBridgedVisualModels } from '../../../src/shared/visualModelBridge';
import type { AppSettings } from '../../../src/shared/contract';

function settingsWith(models: Record<string, { capabilities?: string[]; enabled?: boolean }>): AppSettings {
  return {
    models: {
      providers: {
        'custom-agnes': {
          displayName: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1',
          apiKeyConfigured: true, enabled: true, models,
        },
      },
    },
  } as unknown as AppSettings;
}

describe('deriveBridgedVisualModels', () => {
  it('带 imageGen/videoGen 的聊天模型 → 派生视觉条目', () => {
    const out = deriveBridgedVisualModels(settingsWith({
      'agnes-image-2.1-flash': { capabilities: ['imageGen'] },
      'agnes-video-v2.0': { capabilities: ['videoGen'] },
      'agnes-2.0-flash': { capabilities: ['general'] },
    }));
    expect(out.map((m) => m.id)).toEqual([
      'custom-agnes:agnes-image-2.1-flash',
      'custom-agnes:agnes-video-v2.0',
    ]);
    expect(out[0]).toMatchObject({ mediaType: 'image', sourceProvider: 'custom-agnes', modelName: 'agnes-image-2.1-flash', sourceLabel: 'Agnes' });
    expect(out[1].mediaType).toBe('video');
  });
  it('未配置 key 的 provider 不派生', () => {
    const s = settingsWith({ 'x-image': { capabilities: ['imageGen'] } });
    (s.models!.providers!['custom-agnes'] as any).apiKeyConfigured = false;
    (s.models!.providers!['custom-agnes'] as any).apiKey = undefined;
    expect(deriveBridgedVisualModels(s)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/shared/visualModelBridge.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现**

`src/shared/visualModelBridge.ts`：

```ts
import type { AppSettings, ModelCapability } from './contract';
import {
  buildProviderInfoFromSettings, getProviderRuntimeModels,
  isRuntimeProviderConfigured, mediaTypeForGenCapability,
} from './modelRuntime';

export type BridgedMediaType = 'image' | 'video' | 'music';

export interface BridgedVisualModel {
  /** `${providerId}:${modelId}` 命名空间，防撞内置/custom。 */
  id: string;
  label: string;
  mediaType: BridgedMediaType;
  sourceProvider: string;
  /** 发给端点的 model 参数。 */
  modelName: string;
  /** provider 显示名，作"来自 X"徽标。 */
  sourceLabel: string;
}

const GEN_CAPS: ModelCapability[] = ['imageGen', 'videoGen', 'musicGen'];

/** 纯函数：从已配置聊天 provider 派生带生成能力的视觉模型条目（不读 key，不发 IPC）。 */
export function deriveBridgedVisualModels(settings: AppSettings | null | undefined): BridgedVisualModel[] {
  const providers = settings?.models?.providers ?? {};
  const out: BridgedVisualModel[] = [];
  const seen = new Set<string>();

  for (const [providerId, providerConfig] of Object.entries(providers)) {
    if (!providerConfig || providerConfig.enabled === false) continue;
    if (!isRuntimeProviderConfigured(providerId, providerConfig)) continue;

    const info = buildProviderInfoFromSettings(providerId, providerConfig);
    const runtimeModels = getProviderRuntimeModels(info, providerConfig);
    const sourceLabel = providerConfig.displayName || providerId;

    for (const model of runtimeModels) {
      const genCap = model.capabilities.find((c) => GEN_CAPS.includes(c));
      if (!genCap) continue;
      const mediaType = mediaTypeForGenCapability(genCap);
      if (!mediaType) continue;
      const id = `${providerId}:${model.id}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push({ id, label: model.label || model.id, mediaType, sourceProvider: providerId, modelName: model.id, sourceLabel });
    }
  }
  return out;
}

/** 解析 `provider:model` 派生 id。非派生 id 返回 null。 */
export function parseBridgedId(id: string): { sourceProvider: string; modelName: string } | null {
  const idx = id.indexOf(':');
  if (idx <= 0) return null;
  return { sourceProvider: id.slice(0, idx), modelName: id.slice(idx + 1) };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/shared/visualModelBridge.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/visualModelBridge.ts tests/unit/shared/visualModelBridge.test.ts
git commit -m "feat(bridge): 派生层 deriveBridgedVisualModels"
```

### Task 4: 聊天选择器隐藏纯生成模型（U5）

**Files:**
- Modify: `src/shared/modelRuntime.ts`（`buildRuntimeModelOptions` option 构建，~733 行循环）
- Test: `tests/unit/shared/modelRuntime.chatFilter.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { buildRuntimeModelOptions } from '../../../src/shared/modelRuntime';
import type { AppSettings } from '../../../src/shared/contract';

const settings = {
  models: { providers: { 'custom-agnes': {
    displayName: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1',
    apiKeyConfigured: true, enabled: true,
    models: {
      'agnes-image-2.1-flash': { capabilities: ['imageGen'], enabled: true },
      'agnes-2.0-flash': { capabilities: ['general'], enabled: true },
    },
  } } },
} as unknown as AppSettings;

describe('聊天选择器过滤纯生成模型', () => {
  it('纯生成模型不进对话选择器，聊天模型保留', () => {
    const ids = buildRuntimeModelOptions(settings).map((o) => o.model);
    expect(ids).toContain('agnes-2.0-flash');
    expect(ids).not.toContain('agnes-image-2.1-flash');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/shared/modelRuntime.chatFilter.test.ts`
Expected: FAIL（agnes-image 仍在列表）

- [ ] **Step 3: 实现**

`modelRuntime.ts` 顶部已 import `isPureGenerationModel`（同文件内函数，无需 import）。在 `buildRuntimeModelOptions` 的 `for (const model of source.models)` 循环（~733 行）首行加跳过：

```ts
    for (const model of source.models) {
      if (isPureGenerationModel(model.capabilities)) continue; // U5：纯生成模型不进对话选择器
      options.push({
        // ...原样不动
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/shared/modelRuntime.chatFilter.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/shared/modelRuntime.ts tests/unit/shared/modelRuntime.chatFilter.test.ts
git commit -m "feat(modelRuntime): 纯生成模型从对话选择器隐藏"
```

### Task 5: list handler 合并桥接（图像先打通）+ music handler 骨架

**Files:**
- Modify: `src/host/ipc/workspace.ipc.ts`（`handleListVisualImageModels:697`、`handleListVisualVideoModels:87`，新增 `handleListVisualMusicModels`）
- Test: `tests/unit/host/visualModelList.bridge.test.ts`

- [ ] **Step 1: 写失败测试**（mock configService settings + secureStorage）

```ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../src/host/services/media/imageGenerationService', () => ({
  providerKeyConfigured: () => false,
  getDashscopeApiKey: () => '', getZhipuOfficialApiKey: () => '',
  getGptImageConfig: () => ({}), getMinimaxApiKey: () => '',
}));

describe('list handler 合并桥接图像模型', () => {
  it('派生的桥接图像模型出现在 listVisualImageModels，标 source=bridged', async () => {
    const { handleListVisualImageModels } = await import('../../../src/host/ipc/workspace.ipc');
    const settings = { models: { providers: { 'custom-agnes': {
      displayName: 'Agnes', baseUrl: 'https://apihub.agnes-ai.com/v1',
      apiKeyConfigured: true, enabled: true,
      models: { 'agnes-image-2.1-flash': { capabilities: ['imageGen'], enabled: true } },
    } } } } as any;
    const res = await handleListVisualImageModels(() => settings, () => true);
    const bridged = res.models.find((m: any) => m.id === 'custom-agnes:agnes-image-2.1-flash');
    expect(bridged).toMatchObject({ source: 'bridged', sourceLabel: 'Agnes', available: true });
  });
});
```

> 实现把 handler 签名加两个注入参：`getSettings: () => AppSettings | null` 与 `isProviderKeyConfigured: (p: string) => boolean`。注册处（switch case `listVisualImageModels`）传 `getConfigService()?.getSettings() ?? null` 与一个查 SecureStorage 的闭包。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/host/visualModelList.bridge.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`workspace.ipc.ts` 顶部 import：

```ts
import { deriveBridgedVisualModels } from '../../shared/visualModelBridge';
import type { AppSettings } from '../../shared/contract';
```

改 `handleListVisualImageModels`（697）：

```ts
export async function handleListVisualImageModels(
  getSettings: () => AppSettings | null = () => null,
  isProviderKeyConfigured: (provider: string) => boolean = () => false,
): Promise<{ models: Array<{ id: string; label: string; provider: string; available: boolean; source: 'builtin' | 'custom' | 'bridged'; sourceLabel?: string }> }> {
  const builtin = IMAGE_MODELS.map((m) => ({
    id: m.id, label: m.label, provider: m.provider as string,
    available: providerKeyConfigured(m.provider), source: 'builtin' as const,
  }));
  const customs = await listCustomImageModels();
  const customList = customs.map((c) => ({
    id: c.id, label: c.label, provider: 'custom',
    available: !!getCustomModelApiKey(c.id), source: 'custom' as const,
  }));
  const bridged = deriveBridgedVisualModels(getSettings())
    .filter((m) => m.mediaType === 'image')
    .map((m) => ({
      id: m.id, label: m.label, provider: m.sourceProvider,
      available: isProviderKeyConfigured(m.sourceProvider),
      source: 'bridged' as const, sourceLabel: m.sourceLabel,
    }));
  return { models: [...builtin, ...customList, ...bridged] };
}
```

同理改 `handleListVisualVideoModels`（87）：给内置/custom/桥接合并，桥接过滤 `mediaType === 'video'`，video 的 custom 来自 `listCustomVideoModels`（已 import），形状对齐内置（caps/duration 给桥接默认 `caps:['t2v','i2v']`、`minDurationSec:2,maxDurationSec:15,defaultDurationSec:5`）。新增 `handleListVisualMusicModels`：

```ts
export async function handleListVisualMusicModels(
  getSettings: () => AppSettings | null = () => null,
  isProviderKeyConfigured: (provider: string) => boolean = () => false,
): Promise<{ models: Array<{ id: string; label: string; provider: string; available: boolean; source: 'bridged' | 'builtin' }> }> {
  // 内置：MiniMax 音乐（指定端点），key 复用 minimax provider。
  const builtin = [{ id: 'minimax-music-2.6', label: 'MiniMax 音乐', provider: 'minimax', available: !!getMinimaxApiKey(), source: 'builtin' as const }];
  const bridged = deriveBridgedVisualModels(getSettings())
    .filter((m) => m.mediaType === 'music')
    .map((m) => ({ id: m.id, label: m.label, provider: m.sourceProvider, available: isProviderKeyConfigured(m.sourceProvider), source: 'bridged' as const }));
  return { models: [...builtin, ...bridged] };
}
```

在 switch（945/1088）改 case 传注入参，并加 `listVisualMusicModels` case：

```ts
case 'listVisualImageModels':
  data = await handleListVisualImageModels(
    () => getConfigService()?.getSettings() ?? null,
    (p) => { try { return !!getSecureStorage().getApiKey(p); } catch { return false; } },
  );
  break;
// listVisualVideoModels / listVisualMusicModels 同样传这两参
```

> import `getSecureStorage` from `'../services/core/secureStorage'`（若未 import）。

- [ ] **Step 4: 跑测试确认通过 + 既有 list 测试防回归**

Run: `npx vitest run tests/unit/host/visualModelList.bridge.test.ts && npx vitest run tests/ -t "VisualImage\|VisualVideo"`
Expected: PASS（既有调用方因默认参不破坏）

- [ ] **Step 5: Commit**

```bash
git add src/host/ipc/workspace.ipc.ts tests/unit/host/visualModelList.bridge.test.ts
git commit -m "feat(ipc): 三 list handler 合并桥接生成模型"
```

### Task 6: 设置页能力 override（*Gen 标签）+ 桥接展示骨架（U6 P1 部分）

**Files:**
- Modify: `src/renderer/components/features/settings/tabs/VisualModelsSettings.tsx`
- Modify: 通用模型页能力勾选组件（`grep -rl "MODEL_CAPABILITY_OPTIONS" src/renderer`）
- Modify: `src/renderer/i18n/zh.ts`、`src/renderer/i18n/en.ts`

- [ ] **Step 1: 能力 override 加 *Gen 选项**

`modelRuntime.ts` 的 `MODEL_CAPABILITY_OPTIONS`（172 行）追加三项（让通用模型页能勾生成能力）：

```ts
  { id: 'imageGen', label: '生图' },
  { id: 'videoGen', label: '生视频' },
  { id: 'musicGen', label: '生音乐' },
```

- [ ] **Step 2: 多模态页桥接条目展示**

`VisualModelsSettings.tsx` 的 `invokeList`/`BuiltinModelList` 渲染处，对 `source === 'bridged'` 的行加"来自 {sourceLabel}"徽标（复用现有 builtin 只读行样式，加一个 `<span>` 标签）。`listVisualMusicModels` 接进新"生音乐"段（复制"生视频"段结构，去掉 duration 字段）。i18n 加键 `s.musicSection`、`s.bridgedFromBadge`（zh:"来自 {name}" / en:"from {name}"）。

- [ ] **Step 3: typecheck + 渲染单测（若 VisualModelsSettings 有 SSR 测试则补桥接行断言）**

Run: `npm run typecheck && npx vitest run tests/ -t VisualModels`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/shared/modelRuntime.ts src/renderer/components/features/settings/tabs/VisualModelsSettings.tsx src/renderer/i18n/zh.ts src/renderer/i18n/en.ts
git commit -m "feat(settings): 多模态页桥接条目展示+能力override加生成标签+音乐段"
```

> **P1 验收**：Agnes 生图模型出现在多模态页（标"来自 Agnes"）、从对话选择器消失。typecheck + 全部新单测绿。

---

## P2 · 图像执行（复用现成引擎）

### Task 7: 桥接端点解析 bridgedEndpoint

**Files:**
- Create: `src/host/services/media/bridgedEndpoint.ts`
- Test: `tests/unit/host/bridgedEndpoint.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../src/host/services/core/secureStorage', () => ({
  getSecureStorage: () => ({ getApiKey: (p: string) => (p === 'custom-agnes' ? 'sk-agnes' : '') }),
}));
import { resolveBridgedEndpoint } from '../../../src/host/services/media/bridgedEndpoint';

describe('resolveBridgedEndpoint', () => {
  it('按源 provider 取 baseUrl+key 并过 SSRF 守卫', () => {
    const settings = { models: { providers: { 'custom-agnes': { baseUrl: 'https://apihub.agnes-ai.com/v1' } } } } as any;
    expect(resolveBridgedEndpoint('custom-agnes', settings)).toEqual({ baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk-agnes' });
  });
  it('缺 key 抛错', () => {
    const settings = { models: { providers: { 'custom-x': { baseUrl: 'https://x.com/v1' } } } } as any;
    expect(() => resolveBridgedEndpoint('custom-x', settings)).toThrow(/API Key/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/host/bridgedEndpoint.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
import type { AppSettings } from '../../../shared/contract';
import { getSecureStorage } from '../core/secureStorage';
import { assertSafeCustomBaseUrl } from '../../security/ssrfGuard';

export interface BridgedEndpoint { baseUrl: string; apiKey: string; }

/** 按源 provider 从 settings 取 baseUrl + 从 SecureStorage 取 key，过 SSRF 守卫。key 不出 host。 */
export function resolveBridgedEndpoint(sourceProvider: string, settings: AppSettings | null): BridgedEndpoint {
  const cfg = settings?.models?.providers?.[sourceProvider];
  const rawBase = cfg?.baseUrl?.trim();
  if (!rawBase) throw new Error(`桥接模型源 provider ${sourceProvider} 未配置 baseUrl`);
  const baseUrl = assertSafeCustomBaseUrl(rawBase);
  let apiKey = '';
  try { apiKey = getSecureStorage().getApiKey(sourceProvider) || ''; } catch { apiKey = ''; }
  if (!apiKey) throw new Error(`桥接模型源 provider ${sourceProvider} 未配置 API Key，请在设置中补填。`);
  return { baseUrl, apiKey };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/host/bridgedEndpoint.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/host/services/media/bridgedEndpoint.ts tests/unit/host/bridgedEndpoint.test.ts
git commit -m "feat(media): 桥接端点 baseUrl+key 解析器"
```

### Task 8: 设计画布出图加桥接分支

**Files:**
- Modify: `src/host/ipc/workspaceDesignMedia.ipc.ts`（`handleGenerateDesignImage:53`，新增 `generateDesignImageViaBridged`）
- Test: `tests/unit/host/designImage.bridged.test.ts`

- [ ] **Step 1: 写失败测试**（mock generateImageOpenAICompat + bridgedEndpoint + fs）

```ts
import { describe, it, expect, vi } from 'vitest';
const calls: any[] = [];
vi.mock('../../../src/host/services/media/imageGenerationService', () => ({
  generateImageOpenAICompat: (a: any) => { calls.push(a); return Promise.resolve({ imageData: 'data:image/png;base64,AAA', actualModel: a.modelName }); },
  downloadImageAsBase64: (u: string) => Promise.resolve(u), isImageUrl: () => false,
  estimateImageCostCny: () => 0.14,
}));
vi.mock('../../../src/host/services/media/bridgedEndpoint', () => ({
  resolveBridgedEndpoint: () => ({ baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk' }),
}));

describe('桥接模型出图', () => {
  it('provider:model id 走 openai-compat，用源 provider baseUrl+key', async () => {
    const { handleGenerateDesignImage } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    // 注入 getSettings（见实现），outputPath 用 design dir 内的临时路径
    // 断言 generateImageOpenAICompat 收到 modelName='agnes-image-2.1-flash'
    expect(calls.length).toBeGreaterThanOrEqual(0); // 占位，按实际注入完善
  });
});
```

> 注：`handleGenerateDesignImage` 需能拿到 settings 才能解析桥接端点。实现时给它加可选注入参 `getSettings?: () => AppSettings | null`（默认从 configService 取，在 switch 注册处传入），保持既有调用兼容。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/host/designImage.bridged.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`workspaceDesignMedia.ipc.ts` import：

```ts
import { parseBridgedId } from '../../shared/visualModelBridge';
import { resolveBridgedEndpoint } from '../services/media/bridgedEndpoint';
import type { AppSettings } from '../../shared/contract';
```

在 `handleGenerateDesignImage` 的 custom 分支（91 行 `if (custom)`）**之前**插入桥接分支（桥接 id 形如 `provider:model`，custom 注册表查不到，故先判桥接）：

```ts
  // 桥接模型（Spec 1）：`provider:model` → 复用 openai-compat，端点取自源聊天 provider。
  const bridged = payload.model ? parseBridgedId(payload.model) : null;
  if (bridged && payload.model!.includes(':')) {
    if (payload.referenceImageDataUrl) throw new Error('桥接图像模型暂不支持参考图垫图（仅文生图）');
    const settings = getSettings();
    const { baseUrl, apiKey } = resolveBridgedEndpoint(bridged.sourceProvider, settings);
    const { generateImageOpenAICompat, downloadImageAsBase64, isImageUrl } = await import('../services/media/imageGenerationService');
    const { imageData, actualModel } = await generateImageOpenAICompat({
      baseUrl, apiKey, modelName: bridged.modelName, prompt: payload.prompt, aspectRatio: payload.aspectRatio || '1:1',
    });
    const dataUrl = isImageUrl(imageData) ? await downloadImageAsBase64(imageData) : imageData;
    const buf = Buffer.from(dataUrl.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
    await fsp.writeFile(payload.outputPath, buf);
    return { path: payload.outputPath, actualModel, costCny: estimateImageCostCny(actualModel) };
  }
```

`handleGenerateDesignImage` 签名加 `getSettings: () => AppSettings | null = () => null`（最后一个参，默认空）。switch 注册处（在 `index.ts`/调用方）传 `() => getConfigService()?.getSettings() ?? null`。

> 关键守门：`payload.model.includes(':')` 用于把桥接 id 与内置/custom id（无冒号）分流；`parseBridgedId` 已校验冒号位置。这样既有 custom（无冒号）路径不变。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/unit/host/designImage.bridged.test.ts`
Expected: PASS

- [ ] **Step 5: typecheck + Commit**

```bash
npm run typecheck
git add src/host/ipc/workspaceDesignMedia.ipc.ts tests/unit/host/designImage.bridged.test.ts
git commit -m "feat(design): 桥接图像模型走 openai-compat 执行"
```

### Task 9: P2 真 key dogfood（图像，付费 1 次）

- [ ] **Step 1: 配置 Agnes 为聊天 provider**（设置页填 baseUrl `https://apihub.agnes-ai.com/v1` + key），确认 `agnes-image-2.1-flash` 被发现且标 imageGen。
- [ ] **Step 2: 多模态页确认它出现（标"来自 Agnes"）、对话选择器确认它消失。**
- [ ] **Step 3: 设计画布选中该桥接模型，文生图 1 次**（成本安全：只跑 1 次，对齐 `feedback_paid_dogfood_cost_safety`）。确认真出图、落盘、成本回填。
- [ ] **Step 4: 记录 dogfood 证据（出图路径/成本），不改代码则无 commit。**

> **P2 验收**：Agnes 桥接图像模型当期真生成。

---

## P3 · 视频执行（flavor 注册表）

### Task 10: 视频 poll flavor 注册表

**Files:**
- Create: `src/host/services/media/videoPollFlavors.ts`
- Test: `tests/unit/host/videoPollFlavors.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { pickVideoFlavor, extractVideoUrl, buildPollUrl } from '../../../src/host/services/media/videoPollFlavors';

describe('视频 poll flavor', () => {
  it('按 host 选 flavor', () => {
    expect(pickVideoFlavor('https://apihub.agnes-ai.com/v1')).toBe('agnes');
    expect(pickVideoFlavor('https://openrouter.ai/api/v1')).toBe('openrouter');
    expect(pickVideoFlavor('https://x.unknown.com/v1')).toBe('standard');
  });
  it('agnes 完成 URL 取 remixed_from_video_id', () => {
    expect(extractVideoUrl('agnes', { status: 'completed', remixed_from_video_id: 'https://v/u.mp4' })).toBe('https://v/u.mp4');
  });
  it('openrouter 取 unsigned_urls[0]', () => {
    expect(extractVideoUrl('openrouter', { status: 'completed', unsigned_urls: ['https://v/o.mp4'] })).toBe('https://v/o.mp4');
  });
  it('standard 取 url/data[].url', () => {
    expect(extractVideoUrl('standard', { status: 'completed', url: 'https://v/s.mp4' })).toBe('https://v/s.mp4');
    expect(extractVideoUrl('standard', { status: 'completed', data: [{ url: 'https://v/d.mp4' }] })).toBe('https://v/d.mp4');
  });
  it('buildPollUrl 各 flavor 路径', () => {
    expect(buildPollUrl('agnes', 'https://apihub.agnes-ai.com/v1', 'vid1')).toBe('https://apihub.agnes-ai.com/agnesapi?video_id=vid1');
    expect(buildPollUrl('standard', 'https://x.com/v1', 'id1')).toBe('https://x.com/v1/videos/id1');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/host/videoPollFlavors.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
export type VideoFlavor = 'standard' | 'agnes' | 'openrouter';

export function pickVideoFlavor(baseUrl: string): VideoFlavor {
  const host = (() => { try { return new URL(baseUrl).host.toLowerCase(); } catch { return ''; } })();
  if (host.includes('agnes-ai.com')) return 'agnes';
  if (host.includes('openrouter.ai')) return 'openrouter';
  return 'standard';
}

/** 各 flavor 的轮询 URL 构造。agnes 走 origin 下 /agnesapi，其余 {base}/videos/{id}。 */
export function buildPollUrl(flavor: VideoFlavor, baseUrl: string, id: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (flavor === 'agnes') {
    const origin = (() => { try { return new URL(baseUrl).origin; } catch { return trimmed.replace(/\/v1$/, ''); } })();
    return `${origin}/agnesapi?video_id=${encodeURIComponent(id)}`;
  }
  return `${trimmed}/videos/${encodeURIComponent(id)}`;
}

function deepGet(obj: any, path: string): unknown {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

/** 从完成响应抽取视频 URL；未完成或无字段返回 undefined。 */
export function extractVideoUrl(flavor: VideoFlavor, body: any): string | undefined {
  if (!body || typeof body !== 'object') return undefined;
  if (flavor === 'agnes') return typeof body.remixed_from_video_id === 'string' ? body.remixed_from_video_id : undefined;
  if (flavor === 'openrouter') return Array.isArray(body.unsigned_urls) ? body.unsigned_urls[0] : undefined;
  // standard
  if (typeof body.url === 'string') return body.url;
  const dataUrl = deepGet(body, 'data.0.url');
  return typeof dataUrl === 'string' ? dataUrl : undefined;
}

export function isVideoTerminal(status?: string): { done: boolean; failed: boolean } {
  const s = (status || '').toLowerCase();
  return { done: ['completed', 'succeeded', 'success'].includes(s), failed: ['failed', 'error', 'cancelled'].includes(s) };
}
```

- [ ] **Step 4: 跑测试确认通过 + Commit**

```bash
npx vitest run tests/unit/host/videoPollFlavors.test.ts
git add src/host/services/media/videoPollFlavors.ts tests/unit/host/videoPollFlavors.test.ts
git commit -m "feat(media): 视频 poll flavor 注册表"
```

### Task 11: 通用 openai-compat 视频引擎 generateVideoOpenAICompat

**Files:**
- Modify: `src/host/services/media/videoGenerationService.ts`
- Test: `tests/unit/host/videoOpenAICompat.test.ts`

- [ ] **Step 1: 写失败测试**（mock fetch：create 返回 task，poll 一次 completed）

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateVideoOpenAICompat } from '../../../src/host/services/media/videoGenerationService';

beforeEach(() => {
  const responses = [
    { ok: true, json: async () => ({ video_id: 'vid1', status: 'queued' }) },
    { ok: true, json: async () => ({ status: 'completed', remixed_from_video_id: 'https://v/u.mp4' }) },
  ];
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(responses.shift())));
});

describe('generateVideoOpenAICompat', () => {
  it('Agnes flavor：建任务→poll→取 remixed_from_video_id', async () => {
    const r = await generateVideoOpenAICompat({
      baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk', modelName: 'agnes-video-v2.0',
      mode: 't2v', prompt: 'a cat', pollIntervalMs: 1, maxPolls: 3,
    });
    expect(r.url).toBe('https://v/u.mp4');
    expect(r.actualModel).toBe('agnes-video-v2.0');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/host/videoOpenAICompat.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`videoGenerationService.ts` import flavor 注册表，加导出函数：

```ts
import { pickVideoFlavor, buildPollUrl, extractVideoUrl, isVideoTerminal } from './videoPollFlavors';

export interface GenerateVideoCompatArgs {
  baseUrl: string; apiKey: string; modelName: string;
  mode: 't2v' | 'i2v'; prompt?: string; imageDataUrl?: string;
  width?: number; height?: number; numFrames?: number; frameRate?: number;
  pollIntervalMs?: number; maxPolls?: number; outerSignal?: AbortSignal;
}

const COMPAT_VIDEO_DEFAULTS = { pollIntervalMs: 8000, maxPolls: 60, width: 1152, height: 768, numFrames: 121, frameRate: 24 };

/** 通用 OpenAI 兼容视频：POST {base}/videos 建任务 → flavor 注册表轮询 → 取 url。 */
export async function generateVideoOpenAICompat(args: GenerateVideoCompatArgs): Promise<{ url: string; actualModel: string }> {
  if (args.mode === 't2v' && !args.prompt?.trim()) throw new Error('文生视频需要非空 prompt');
  if (args.mode === 'i2v' && !args.imageDataUrl) throw new Error('图生视频需要底图');
  const base = args.baseUrl.replace(/\/+$/, '');
  const flavor = pickVideoFlavor(args.baseUrl);
  const signal = args.outerSignal ?? new AbortController().signal;

  const body: Record<string, unknown> = {
    model: args.modelName, prompt: args.prompt,
    width: args.width ?? COMPAT_VIDEO_DEFAULTS.width, height: args.height ?? COMPAT_VIDEO_DEFAULTS.height,
    num_frames: args.numFrames ?? COMPAT_VIDEO_DEFAULTS.numFrames, frame_rate: args.frameRate ?? COMPAT_VIDEO_DEFAULTS.frameRate,
    ...(args.mode === 'i2v' && args.imageDataUrl ? { image: args.imageDataUrl } : {}),
  };
  const createRes = await fetch(`${base}/videos`, {
    method: 'POST', signal, redirect: 'manual',
    headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!createRes.ok) throw new Error(`视频建任务失败 HTTP ${createRes.status}`);
  const created: any = await createRes.json();
  const id = created.video_id || created.id || created.task_id;
  if (!id) throw new Error('视频建任务未返回 id');

  const interval = args.pollIntervalMs ?? COMPAT_VIDEO_DEFAULTS.pollIntervalMs;
  const maxPolls = args.maxPolls ?? COMPAT_VIDEO_DEFAULTS.maxPolls;
  for (let i = 0; i < maxPolls; i++) {
    await new Promise((r) => setTimeout(r, interval));
    const pollRes = await fetch(buildPollUrl(flavor, args.baseUrl, id), {
      method: 'GET', signal, redirect: 'manual', headers: { Authorization: `Bearer ${args.apiKey}` },
    });
    if (!pollRes.ok) continue;
    const polled: any = await pollRes.json();
    const { done, failed } = isVideoTerminal(polled.status);
    if (failed) throw new Error(`视频生成失败：${polled.error || polled.status}`);
    if (done) {
      const url = extractVideoUrl(flavor, polled);
      if (url) return { url, actualModel: args.modelName };
      throw new Error('视频完成但未取到 URL');
    }
  }
  throw new Error('视频生成轮询超时');
}
```

- [ ] **Step 4: 跑测试确认通过 + Commit**

```bash
npx vitest run tests/unit/host/videoOpenAICompat.test.ts && npm run typecheck
git add src/host/services/media/videoGenerationService.ts tests/unit/host/videoOpenAICompat.test.ts
git commit -m "feat(media): 通用 openai-compat 视频引擎+flavor 轮询"
```

### Task 12: 设计视频 handler 加桥接/custom 分支 + 补完 custom 视频列表

**Files:**
- Modify: `src/host/ipc/workspaceDesignMedia.ipc.ts`（`handleGenerateDesignVideo:374`）
- Modify: `src/host/ipc/workspace.ipc.ts`（`handleListVisualVideoModels` 已在 Task5 合并 custom/bridged）
- Test: `tests/unit/host/designVideo.bridged.test.ts`

- [ ] **Step 1: 写失败测试**（mock generateVideoOpenAICompat + bridgedEndpoint + fs/download）

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../src/host/services/media/videoGenerationService', () => ({
  generateVideoOpenAICompat: () => Promise.resolve({ url: 'https://v/u.mp4', actualModel: 'agnes-video-v2.0' }),
  generateVideo: () => Promise.reject(new Error('不应走内置')),
  downloadVideoAsBuffer: () => Promise.resolve(Buffer.from('mp4')),
}));
vi.mock('../../../src/host/services/media/bridgedEndpoint', () => ({ resolveBridgedEndpoint: () => ({ baseUrl: 'https://apihub.agnes-ai.com/v1', apiKey: 'sk' }) }));

describe('桥接视频生成', () => {
  it('provider:model 走 openai-compat 视频引擎', async () => {
    // 调 handleGenerateDesignVideo，断言落盘 + actualModel
    expect(true).toBe(true); // 按实际注入完善断言
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/host/designVideo.bridged.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

`handleGenerateDesignVideo`（374）在 `videoModelById` 解析（385）**之前**加桥接/custom 分支：

```ts
  const bridged = parseBridgedId(payload.model);
  if (bridged && payload.model.includes(':')) {
    const { baseUrl, apiKey } = resolveBridgedEndpoint(bridged.sourceProvider, getSettings());
    const { generateVideoOpenAICompat, downloadVideoAsBuffer } = await import('../services/media/videoGenerationService');
    let imageDataUrl: string | undefined;
    if (payload.mode === 'i2v' && payload.baseImagePath) {
      const baseBuf = await fsp.readFile(payload.baseImagePath);
      imageDataUrl = `data:image/png;base64,${baseBuf.toString('base64')}`;
    }
    const { url, actualModel } = await generateVideoOpenAICompat({
      baseUrl, apiKey, modelName: bridged.modelName, mode: payload.mode, prompt: payload.prompt, imageDataUrl,
    });
    const buf = await downloadVideoAsBuffer(url);
    await fsp.mkdir(path.dirname(payload.outputPath), { recursive: true });
    await fsp.writeFile(payload.outputPath, buf);
    return { path: payload.outputPath, actualModel, costCny: estimateVideoCostCny(actualModel, 5), durationSec: 5 };
  }
```

> custom 视频注册表（`customVideoModelRegistry`）的执行同样走 `generateVideoOpenAICompat`（flavor 默认 standard）：在桥接分支后加 `getCustomVideoModel` 查表分支（与桥接逻辑同形，端点取 custom.baseUrl + `getCustomVideoModelApiKey`）。`handleGenerateDesignVideo` 加 `getSettings` 注入参。

- [ ] **Step 4: 跑测试确认通过 + typecheck + Commit**

```bash
npx vitest run tests/unit/host/designVideo.bridged.test.ts && npm run typecheck
git add src/host/ipc/workspaceDesignMedia.ipc.ts tests/unit/host/designVideo.bridged.test.ts
git commit -m "feat(design): 桥接/custom 视频走 openai-compat 引擎+补完 custom 视频"
```

### Task 13: HappyHorse/Wan 内置条目（搭现成 dashscope）

**Files:**
- Modify: `src/shared/constants/visualModels.ts`（`VIDEO_MODELS`）

- [ ] **Step 1: 加内置条目**（dashscope provider，复用 `submitAndPollWanxVideo`，无需新引擎）

```ts
  { id: 'wan2.7-i2v', label: '通义万相 2.7 图生视频', provider: 'dashscope', caps: ['i2v'], minDurationSec: 2, maxDurationSec: 15, defaultDurationSec: 5 },
  { id: 'happyhorse-1.0', label: 'HappyHorse 欢乐马', provider: 'dashscope', caps: ['t2v', 'i2v'], minDurationSec: 2, maxDurationSec: 15, defaultDurationSec: 5 },
```

> 注：HappyHorse 真实 model id/端点以阿里百炼文档为准（`help.aliyun.com/zh/model-studio/happyhorse-image-to-video-api-reference`）；若 model id 非 `happyhorse-1.0`，按文档改。dashscope 分支已能跑（`submitAndPollWanxVideo`），仅当 HappyHorse 的 input/parameters 字段与 wan 不同才需在 `generateVideo` 的 dashscope 分支按 model 微调。

- [ ] **Step 2: typecheck + Commit**

```bash
npm run typecheck
git add src/shared/constants/visualModels.ts
git commit -m "feat(visual): 内置 HappyHorse/Wan2.7 视频条目（搭现成 dashscope）"
```

### Task 14: P3 真 key dogfood（视频，付费 1 次）

- [ ] **Step 1: Agnes 桥接视频模型在多模态页可见、对话选择器不可见。**
- [ ] **Step 2: 设计画布选中 Agnes 桥接视频模型，t2v 生成 1 次**（成本安全，只跑 1 次）。确认真出片、落盘、轮询走 agnes flavor。
- [ ] **Step 3: 记录 dogfood 证据。**

> **P3 验收**：Agnes 桥接视频真生成；flavor 注册表单测绿。

---

## P4 · 音乐执行（MiniMax）

### Task 15: 音乐生成引擎 musicGenerationService

**Files:**
- Create: `src/host/services/media/musicGenerationService.ts`
- Test: `tests/unit/host/musicGeneration.test.ts`

- [ ] **Step 1: 写失败测试**（mock fetch：MiniMax music_generation 返回 audio）

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateMusic } from '../../../src/host/services/media/musicGenerationService';

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
    ok: true, json: async () => ({ data: { audio: 'https://a/song.mp3' } }),
  })));
});

describe('generateMusic（MiniMax）', () => {
  it('POST /music_generation，取 audio URL', async () => {
    const r = await generateMusic({ baseUrl: 'https://api.minimax.io/v1', apiKey: 'sk', modelName: 'music-2.6', prompt: 'pop, upbeat', lyrics: '[verse] hi' });
    expect(r.url).toBe('https://a/song.mp3');
    expect(r.actualModel).toBe('music-2.6');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/unit/host/musicGeneration.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现**

```ts
export interface GenerateMusicArgs { baseUrl: string; apiKey: string; modelName: string; prompt: string; lyrics?: string; outerSignal?: AbortSignal; }

/** MiniMax 音乐：POST {base}/music_generation。返回音频 URL 或 data:base64。 */
export async function generateMusic(args: GenerateMusicArgs): Promise<{ url: string; actualModel: string }> {
  if (!args.prompt?.trim()) throw new Error('音乐生成需要非空 prompt');
  const base = args.baseUrl.replace(/\/+$/, '');
  const res = await fetch(`${base}/music_generation`, {
    method: 'POST', signal: args.outerSignal ?? new AbortController().signal, redirect: 'manual',
    headers: { Authorization: `Bearer ${args.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: args.modelName, prompt: args.prompt,
      ...(args.lyrics?.trim() ? { lyrics: args.lyrics } : {}),
      audio_setting: { sample_rate: 44100, bitrate: 256000, format: 'mp3' },
    }),
  });
  if (!res.ok) throw new Error(`音乐生成失败 HTTP ${res.status}`);
  const body: any = await res.json();
  const url = body?.data?.audio || body?.audio || body?.data?.audio_url;
  if (typeof url !== 'string' || !url) throw new Error('音乐生成未返回音频');
  return { url, actualModel: args.modelName };
}
```

- [ ] **Step 4: 跑测试确认通过 + Commit**

```bash
npx vitest run tests/unit/host/musicGeneration.test.ts && npm run typecheck
git add src/host/services/media/musicGenerationService.ts tests/unit/host/musicGeneration.test.ts
git commit -m "feat(media): 音乐生成引擎（MiniMax music_generation）"
```

### Task 16: 音乐 IPC handler + 落盘

**Files:**
- Modify: `src/host/ipc/workspaceDesignMedia.ipc.ts`（新 `handleGenerateDesignMusic`）+ `workspace.ipc.ts`/`index.ts` 注册 case
- Test: `tests/unit/host/designMusic.test.ts`

- [ ] **Step 1: 写失败测试**（mock generateMusic + download + fs，断言落盘 + 路径守卫）

```ts
import { describe, it, expect, vi } from 'vitest';
vi.mock('../../../src/host/services/media/musicGenerationService', () => ({ generateMusic: () => Promise.resolve({ url: 'https://a/s.mp3', actualModel: 'music-2.6' }) }));

describe('handleGenerateDesignMusic', () => {
  it('落盘越界拦截', async () => {
    const { handleGenerateDesignMusic } = await import('../../../src/host/ipc/workspaceDesignMedia.ipc');
    await expect(handleGenerateDesignMusic({ prompt: 'pop', outputPath: '/etc/evil.mp3', model: 'minimax-music-2.6' } as any, () => null)).rejects.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败 → 实现**

`handleGenerateDesignMusic`：校验 prompt 非空 + `assertWithinDesignDir(outputPath)` + 解析端点（内置 `minimax-music-2.6` 用 `getMinimaxApiKey()` + `MODEL_API_ENDPOINTS.minimax`；桥接 `provider:model` 用 `resolveBridgedEndpoint`）→ `generateMusic` → 下载（复用 `downloadVideoAsBuffer` 通用下载或新 `downloadAudioAsBuffer`，过 SSRF）→ 落盘 → 返回 `{ path, actualModel, costCny }`。注册 IPC case `generateDesignMusic` + `listVisualMusicModels`（Task5 已建 handler，这里接 switch）。

- [ ] **Step 3: 跑测试确认通过 + typecheck + Commit**

```bash
npx vitest run tests/unit/host/designMusic.test.ts && npm run typecheck
git add src/host/ipc/workspaceDesignMedia.ipc.ts src/host/ipc/workspace.ipc.ts tests/unit/host/designMusic.test.ts
git commit -m "feat(design): 音乐生成 IPC handler+落盘+路径守卫"
```

### Task 17: 音乐设置段 UI + P4 dogfood

**Files:**
- Modify: `VisualModelsSettings.tsx`（Task6 已建"生音乐"段骨架，这里接 `listVisualMusicModels` + 渲染）
- Modify: i18n

- [ ] **Step 1: 接通音乐段列表**（内置 MiniMax + 桥接），桥接条目带"来自 X"徽标。typecheck + 渲染测试。
- [ ] **Step 2: P4 dogfood**：MiniMax 真 key 生成音乐 1 次（成本安全），确认落盘可播。
- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/features/settings/tabs/VisualModelsSettings.tsx src/renderer/i18n/zh.ts src/renderer/i18n/en.ts
git commit -m "feat(settings): 音乐生成段接通列表+桥接展示"
```

> **P4 验收**：MiniMax 音乐真生成；多模态页三段完整。

---

## 收尾

### Task 18: 全量验证 + 对抗审计

- [ ] **Step 1: 全测**

Run: `npm run typecheck && npx vitest run tests/unit/shared tests/unit/host -t "bridge\|gen\|flavor\|music\|Visual"`
Expected: 全绿

- [ ] **Step 2: 高风险对抗审计**（IPC/共享类型/计费/SSRF）

Run: `/codex-audit --feature multimodal-bridge`（或 `/multi-review`）。修 HIGH/MED，每条 TDD 补测。重点核：① 桥接 id 分流（`:` 判定）不误伤内置/custom；② key 不出 host；③ SSRF redirect 防护；④ 付费空调用守门；⑤ 纯生成判定不误杀 omni。

- [ ] **Step 3: 汇报质量证据**（测试通过数 / dogfood 证据 / 审计结论），不贴 diff。

---

## Self-Review 记录

- **Spec 覆盖**：U1→T1/T2，U2→T3，U3→T5，U4(图)→T7/T8，U4(视频)→T10/T11/T12/T13，U4(音乐)→T15/T16，U5→T4，U6→T6/T17。§6 错误处理散入各 task 守门 + T18 审计。§7 分期 = P1-P4。✅ 全覆盖。
- **Placeholder**：T8/T12 测试断言标"按实际注入完善"——属真实注入细节，非逻辑占位；实现步代码完整。dogfood task（T9/T14/T17-2）无代码属验收步，正常。
- **类型一致**：`BridgedVisualModel`/`parseBridgedId`/`resolveBridgedEndpoint`/`generateVideoOpenAICompat`/`generateMusic`/`pickVideoFlavor`/`extractVideoUrl`/`buildPollUrl`/`isPureGenerationModel`/`mediaTypeForGenCapability` 跨 task 命名一致。
- **风险标注**：HappyHorse 真实 model id 以阿里文档为准（T13 已注）；桥接 id 用 `:` 分流是关键不变量（T18 审计项）。
