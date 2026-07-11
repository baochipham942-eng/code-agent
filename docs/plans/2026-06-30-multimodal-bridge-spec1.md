# Spec 1 · 多模态桥接脊柱 + 网关视频 + 音乐

> 程序（program）三 spec 之一。本 spec 是地基；Spec 2（Seedance 火山 Ark 原生）、Spec 3（Veo Google 原生）是往本 spec 的引擎适配器注册表里"插卡"，不重建。
> 日期：2026-06-30 ｜ 状态：设计待用户验收 ｜ 基线：main（PR #294 设置页重构合并后开新分支）

## 1. 问题

两套模型系统互不相通：

- **聊天模型世界**：LLM provider，能力枚举 `ModelCapability`（`src/shared/contract/model.ts:39`）只有 `code/vision/fast/reasoning/gui/general/search/compact/quick/longContext/unlimited`，**没有"生成"维度**。`inferModelCapabilities`（`src/shared/modelRuntime.ts:499`）甚至把 `image` 误归为 `vision`（图像**输入**，非**输出**）。
- **多模态生成世界**：独立注册表 `src/shared/constants/visualModels.ts`（`IMAGE_MODELS`/`VIDEO_MODELS`），每模型绑 `engine`，列表只来自内置表 + 两个 custom 注册表。

**真实痛点（Agnes）**：用户把 Agnes（OpenAI 兼容网关，`https://apihub.agnes-ai.com/v1`，一端同供聊天+生图+生视频）配成聊天 provider。发现时 `agnes-image-2.1-flash` / `agnes-video-v2.0` 被全收进聊天 provider，混进对话模型选择器（且选了也调不通——它们不能聊天），但**多模态页选不到**。

**目标**：让多模态页自动列出聊天 provider 里带生图/生视频/生音乐能力的模型，并能**真正用于生成**（硬规则：能列且能生成，不是只能列）。纯生成模型从对话选择器隐藏。复用源 provider 的 baseUrl+key，不让用户重填。

## 2. 用户已拍板决策

| 决策点 | 选择 |
|---|---|
| Scope | B：图像+视频+音乐全做 |
| 识别方式 | 自动推断生成能力 + 设置页可手动改标签 |
| 聊天选择器 | 纯生成模型从对话选择器**隐藏**（既能聊又能生成的保留） |
| 视频契约来源 | 联网调研（已完成，见 §3） |
| 音乐端点 | 指定 MiniMax `/v1/music_generation`（Agnes 无独立音乐 API） |
| 视频 poll 通用度 | 可扩展网关 flavor 注册表，首期内置 standard/agnes/openrouter/dashscope·minimax |
| 原生 API | 也要，但**拆成 Spec 2/3**；本 spec 仅"网关 + HappyHorse/Wan 搭现成 dashscope"。 |
| 交付组织 | 拆 3 个 spec 程序 |

## 3. 调研结论（真实契约）

### 3.1 图像
Agnes 走 OpenAI 标准 `POST /v1/images/generations`——**正是仓库现有 `generateImageOpenAICompat`（`imageGenerationService.ts:726`）已支持的事实标准**。零新引擎。

### 3.2 视频（无统一契约，poll 端各家私有）

| flavor | 建任务 | 轮询 | 完成 URL 字段 |
|---|---|---|---|
| `standard`（Sora 收敛） | `POST {base}/videos` | `GET {base}/videos/{id}` | `.url` / `.data[].url` |
| `agnes` | `POST {base}/videos` | `GET {origin}/agnesapi?video_id={id}` | `remixed_from_video_id`（completed 时） |
| `openrouter` | `POST {base}/videos` | `GET {base}/videos/{id}` | `unsigned_urls[0]` |
| `dashscope`（现有，含 HappyHorse/Wan） | DashScope 任务 | `submitAndPollWanxVideo` | `output.video_url` |
| `minimax`（现有，海螺） | MiniMax 三步 | `submitAndPollMinimaxVideo` | retrieve |

Agnes create 体：`{model, prompt, image?, width, height, num_frames(8n+1,≤441), frame_rate, negative_prompt?, seed?}`，`seconds=num_frames/frame_rate`。

### 3.3 音乐
Agnes 无独立音乐 API（仅"视频内嵌音轨"）。指定端点 = **MiniMax `POST {base}/music_generation`**：`{model:"music-2.6", prompt, lyrics?, audio_setting:{sample_rate,bitrate,format}}`。仓库已有 `getMinimaxApiKey` 通路。

### 3.4 原生全貌（→ Spec 2/3，本 spec 不做）
- HappyHorse-1.0 / Wan = 阿里百炼/DashScope → **本 spec 顺手并入**（搭现有 `submitAndPollWanxVideo`，加模型条目）。
- Seedance = 火山 Ark（Volcengine AK/SK，`contentGenerationTasks`）→ Spec 2。
- Veo = Google（Gemini key 轻 / Vertex OAuth 重）→ Spec 3。

## 4. 架构设计（单元）

核心思路：**不缝合两套系统**，而是给聊天模型加"生成能力"维度，再用派生层把带生成能力的聊天模型翻成视觉模型条目；执行时按源 provider 解析 baseUrl+key（key 不出 host）。

### U1 · 能力维度扩展
**文件**：`src/shared/contract/model.ts`、`src/shared/modelRuntime.ts`

- `ModelCapability` 加 `'imageGen' | 'videoGen' | 'musicGen'`。
- `inferModelCapabilities` 加推断 + 消歧：
  - imageGen：名含 `image`/`t2i`/`draw`/`paint`/`生图` 且非 omni/vl/4o（输入类）→ imageGen；保留 vision 推断给真·视觉输入模型（`4o`/`vl`/`omni`）。
  - videoGen：名含 `video`/`t2v`/`i2v`/`sora`/`veo`/`seedance`/`wan2`/`hailuo`/`happyhorse`/`kling`。
  - musicGen：名含 `music`/`song`/`suno`/`audio-gen`。
- `inferSupportsTool`：纯 *Gen（无 chat 能力）→ false（已部分覆盖，扩展生成关键词）。
- **判定 helper**：`isPureGenerationModel(capabilities)` = 含任一 *Gen 且不含 `general/code/reasoning/fast` 等 chat 能力。供 U5 用。
- **能力→媒介映射**：`mediaTypeForGenCapability(cap)`：imageGen→image / videoGen→video / musicGen→music。

### U2 · 派生层（新文件）
**文件**：`src/shared/visualModelBridge.ts`

- `deriveBridgedVisualModels(settings): BridgedVisualModel[]`
  - 遍历 `settings.models.providers`，对每个**已配置**（`isRuntimeProviderConfigured`）provider，取 `getProviderRuntimeModels`，过滤出带 *Gen 能力的模型。
  - 产出 `BridgedVisualModel { id: \`${providerId}:${modelId}\`, label, mediaType, sourceProvider: providerId, modelName: modelId, sourceLabel /* provider 显示名，作"来自 Agnes"徽标 */ }`。
  - id 用 `provider:model` 命名空间，避免与内置/custom id 撞。
- 纯函数、无 IPC、无 key——只读 settings。可单测。

### U3 · 列表合并（IPC）
**文件**：`src/host/ipc/workspace.ipc.ts`、`workspaceDesignMedia.ipc.ts`

- `handleListVisualImageModels` / `handleListVisualVideoModels` / **新 `handleListVisualMusicModels`** 返回：内置 + custom 注册表 + **派生层**（按 mediaType 过滤）。
- 每条带 `source: 'builtin'|'custom'|'bridged'`、`sourceLabel?`、`available`（bridged 的 available = 源 provider key 已配 `secureStorage.getApiKey(sourceProvider)`）。
- 派生层需要 settings：handler 经现有 configService 注入。

### U4 · 执行解析（host 引擎）
**文件**：`workspaceDesignMedia.ipc.ts`、`imageGenerationService.ts`、新 `videoGenEngine.ts`（poll flavor）、新 `musicGenerationService.ts`

桥接 key resolver（host 私有，新 helper）：`resolveBridgedEndpoint(sourceProvider, settings) → { baseUrl, apiKey }`，baseUrl 取 `settings.models.providers[sourceProvider].baseUrl`，apiKey 取 `secureStorage.getApiKey(sourceProvider)`。过 SSRF 守卫。key 绝不回 renderer。

- **图像**：bridged image → 复用 `generateImageOpenAICompat({baseUrl, apiKey, modelName})`。design 画布出图链在 `handleGenerateDesignImage` 加 bridged 分支（与现有 custom 分支并列，绝不进 `imageEngineForModel`）。
- **视频**：新 `generateVideoOpenAICompat({baseUrl, apiKey, modelName, flavor, mode, prompt, image?, params})`：
  - `POST {baseUrl}/videos` 建任务。
  - poll 走 **flavor 注册表**：`VIDEO_POLL_FLAVORS: Record<flavor, {pollUrl(base,id), statusField, urlFields[]}>`。
  - flavor 选择：`pickVideoFlavor(baseUrl)` 按 host 匹配（agnes-ai→agnes，openrouter→openrouter，否则 standard）。
  - `generateVideo`（`videoGenerationService.ts`）加 bridged/custom 分支，dashscope/minimax 现有分支收进同一调度（重构不改行为）。`handleGenerateDesignVideo` 解析 bridged 模型。
  - **顺手补完** orphaned `customVideoModelRegistry`：`listVisualVideoModels` 合并 custom 视频 + 执行接 `generateVideoOpenAICompat`（flavor=standard 默认）。
- **音乐**：新 `musicGenerationService.generateMusic({baseUrl, apiKey, modelName, prompt, lyrics?})` → MiniMax `/music_generation` 适配 + 通用 openai-compat 兜底。新 IPC handler `handleGenerateDesignMusic` + 产物落盘（design dir，过 `assertWithinDesignDir`）。

### U5 · 聊天选择器过滤
**文件**：`src/shared/modelRuntime.ts`（`buildRuntimeModelOptions` 消费层）

- 在生成 `RuntimeModelOption` 时，跳过 `isPureGenerationModel(model.capabilities)` 的模型。
- **只过滤切换器**，不动设置页"通用模型"列表（设置页仍需展示全部发现模型以便手动 override 能力）——过滤点在 option 构建/消费，发现层不变。

### U6 · 设置页
**文件**：`src/renderer/components/features/settings/tabs/VisualModelsSettings.tsx`、通用模型页组件

- 多模态页：现有"生图/生视频"两段 + **新增"生音乐"段**。每段列表 = 内置（只读）+ 自定义（CRUD）+ **桥接（只读，带"来自 {sourceLabel}"徽标 + available 态）**。
- 通用模型页：每模型能力 override 增 *Gen 标签勾选。改 → 影响 U5 过滤 + U2 派生（数据流：override 落 `providerConfig.models[id].capabilities`，U1/U2/U5 读它）。
- 文案走 i18n（zh/en 对齐，`en.ts` 同步加键）。

## 5. 数据流

```
聊天 provider /models 发现 ──► getProviderRuntimeModels
   │                                  │ (override.capabilities 或 inferModelCapabilities[U1])
   │                                  ▼
   │                         带 *Gen 能力的模型
   │                          ├──► U5 从聊天切换器隐藏（纯生成）
   │                          └──► U2 deriveBridgedVisualModels
   │                                  ▼
   │                         U3 list 合并（内置+custom+bridged）──► U6 多模态页展示
   │                                  ▼ (用户选中 bridged 模型生成)
   └──► U4 resolveBridgedEndpoint(sourceProvider) → {baseUrl, key}
            ├─ image ─► generateImageOpenAICompat（复用）
            ├─ video ─► generateVideoOpenAICompat（flavor 注册表）
            └─ music ─► musicGenerationService（MiniMax 适配）
```

## 6. 错误处理 / 边界

- bridged 模型源 provider 删除/改 key → list 的 `available=false`，UI 置灰，执行前硬门报错（缺 key 不走付费路径，对齐现有 video handler 前置 key 守卫）。
- SSRF：bridged baseUrl 过 `assertSafeCustomBaseUrl`；视频/音乐下载 URL 过现有 `isSafeImageUrl`/`assertSafeDownloadUrl`。redirect 防护（视频 poll 不透明跟 3xx，对齐 `generateImageOpenAICompat` 的 HIGH-1 修复）。
- 视频 flavor 未匹配 → 默认 standard；poll 超时/失败有上限退避，付费空调用前校验必填字段（对齐 `clampVideoDuration` 范式）。
- 能力推断误判 → 用户设置页手动 override 兜底（已是既定决策）。
- id 命名空间 `provider:model` 防撞内置/custom；派生层对同 id 跨 provider 去重。
- 成本：图像/视频/音乐生成均付费。dogfood 默认只跑一次（对齐 `feedback_paid_dogfood_cost_safety`）；成本估算入 `pricing.ts` 唯一源。

## 7. 分期（Spec 1 内）

| 期 | 内容 | 验收 |
|---|---|---|
| P1 共享脊柱 | U1+U2+U5 + U3 图像合并 + U6 override UI | Agnes 生图模型现身多模态页、从聊天选择器消失；typecheck+单测 |
| P2 图像执行 | U4 图像解析（复用引擎） | **当期真生成**，Agnes key 真 dogfood（1 次） |
| P3 视频执行 | U4 视频引擎 + flavor 注册表 + 补完 custom 视频 + HappyHorse/Wan 并入 | Agnes 真端点 dogfood；standard/openrouter flavor 单测 |
| P4 音乐执行 | U4 音乐引擎 + MiniMax 适配 + U6 音乐段 | MiniMax 真 key dogfood（1 次） |

每期独立可验收、可合并。P2 后图像完整可用。

## 8. 测试策略

- 单测：U1 推断/消歧（image-vs-vision、纯生成判定）、U2 派生（多 provider/去重/未配置过滤）、U5 过滤、视频 flavor 注册表各条 poll URL/字段解析、key resolver。
- 集成：U3 三 list handler 合并形状。
- E2E/dogfood：P2 图像、P3 视频、P4 音乐各真 key 跑 1 次（成本安全）。
- 红线：高风险（IPC/共享类型/计费/SSRF）走 codex-audit 或 multi-review。

## 9. 不做（YAGNI / 划给后续）

- 原生 Veo（Google）、原生 Seedance（火山 Ark）→ Spec 2/3。
- 视频高级参数（keyframes/多图 extra_body）MVP 不暴露，用默认。
- 音乐 lyrics 高级编排 MVP 仅透传。
- 网关 flavor 的设置页手选下拉（首期自动按 host 匹配；探针不准再加，YAGNI）。

## 10. 提交纪律

- 工作树有别会话 WIP（agentLoop/schema/App.tsx 等）。提交**只 `git add` 本 spec 涉及的自己的文件**，禁止 `git add -A`。
- 本 spec 文档为本地工作文件，不 push 公开 origin（"产品 spec 不进公开 git"）。
- 改 prompt 相关须 bump `PROMPT_VERSION`（本 spec 大概率不涉及）。
