# Spec 2：Seedance 原生（火山 Ark）视频生成

> 多模态桥接 3-spec 程序之 Spec 2。状态：设计已拍板（2026-06-30），待实施。
> 本文件 untracked，不进公开 git（沿用 Spec 1 惯例 + feedback_specs_out_of_public_git）。

## 0. 背景与定位

Agent Neo = cowork 人机协作产品，视频是产物媒介之一。Spec 1（多模态桥接）已让"聊天 provider 带生成能力的模型"桥到多模态页，并沉淀了三套**内置视频 provider 范式**（都在 `videoGenerationService.ts` 按 `model.provider` 路由）：

| Provider | 范式 | 鉴权 | 取片字段 |
|---|---|---|---|
| `dashscope`（通义万相） | 异步 task：POST→轮询 `/tasks/{id}` | Bearer | `output.video_url` |
| `minimax`（海螺） | 三步：submit→query→files/retrieve | Bearer(+GroupId) | `file.download_url` |
| `openai-compat`（网关，Spec 1） | POST `/videos`→flavor 轮询 | Bearer | flavor 抽取 |

当时拍板：**原生 API（非 OpenAI 兼容、各自一套鉴权）不走桥接机制，拆独立 spec**。本 spec 即 Spec 2 —— 字节 Seedance，经火山引擎方舟（Ark / ModelArk）原生 API 接入，作为**第四套内置 provider 范式** `provider: 'ark'`。

**拍板决策（林晨，2026-06-30）**：
1. 鉴权走 **Ark API Key**（纯 Bearer），不实现 Volcengine AK/SK V4 签名。
2. **本 spec 只做 Seedance**；HappyHorse（阿里 MaaS 原生 i2v）单拆，复用同一套 provider 骨架另开会话。
3. dogfood key 由林晨注册火山引擎 + 充值后提供，实现阶段真出片一条。
4. MVP 模型范围：Seedance 2.0 标准 + fast 两条 ×（t2v + i2v）。

## 1. 真实契约（已核实，2026-06-30）

来源：火山引擎官方文档 `volcengine.com/docs/82379` + 多份第三方 API 示例交叉验证。

- **Base**：`https://ark.cn-beijing.volces.com/api/v3/`
- **鉴权**：`Authorization: Bearer <ARK_API_KEY>` + `Content-Type: application/json`
- **建任务**：`POST {base}/contents/generations/tasks`
  - body 为**结构化字段**（不是写在 prompt 文本里的 `--rs/--dur` CLI flag）：
    ```json
    {
      "model": "doubao-seedance-2-0-260128",
      "content": [
        { "type": "text", "text": "<prompt>" },
        { "type": "image_url", "image_url": { "url": "<图 URL 或 data URL>" } }
      ],
      "resolution": "720p",
      "ratio": "16:9",
      "duration": 5,
      "watermark": false
    }
    ```
  - t2v：`content` 只含 text 项；i2v：text + image_url 项。
  - 返回 `{ id: "<task_id>" }`（建任务态）。
- **轮询任务**：`GET {base}/contents/generations/tasks/{task_id}`（同 Bearer header）
  - `status` 取值：`queued | running | succeeded | failed | expired | cancelled`
  - 成功响应：`{ id, status:"succeeded", content:{ video_url:"..." }, usage:{...} }`
  - **视频 URL 在 `content.video_url`**，指向火山对象存储，**24h 后过期** → 取到后必须立刻下载落 artifact。
- **model id**：Seedance 2.0 系 `doubao-seedance-2-0-260128`（标准）/ `doubao-seedance-2-0-fast-260128`（快）；另有 1.0 lite t2v/i2v。
  - ⚠️ **model id 带日期戳会轮换**，且可能因账号/地域不同。以林晨控制台实际可用 id 为准，dogfood 时校准；发给 API 的 `model` 字符串就是注册表里的内置常量，轮换时 bump 常量即可。

### 待 dogfood 校验的不确定点（实现/dogfood 阶段确认）
1. `image_url.url` 是否接受 base64 data URL（Spec 1 i2v 传的是 data URL）。若只接受公网 URL，需 fallback（先上传图拿 URL，或限制 i2v 仅接受公网图）。
2. `resolution` 合法枚举（480p/720p/1080p?）、`ratio` 合法枚举、`duration` 区间（2~12s? 还是 5/10 固定档）。
3. 精确定价（按 resolution×duration 还是按 token；`usage.completion_tokens` 暗示可能 token 计费）→ 查 `82379/1544106`。
4. 标准/fast 两档的实际 model id 日期戳。

## 2. 落点架构

### 2.1 复用 origin/main 已有地基（无 Spec 1 依赖）
经核实，Seedance 复用的下列地基**全在 origin/main 上**，与 Spec 1 解耦：
- `videoGenerationService.ts`：`generateVideo` 路由 + wanx/minimax 范式 + `downloadVideoAsBuffer`
- `visualModels.ts`：`VIDEO_MODELS` / `VisualVideoModel` / `VisualProviderId` / `videoModelById` / `clampVideoDuration`
- `customVideoModelRegistry.ts`、`videoCost.ts`、`VideoModelPicker.tsx`、videoGenerate 工具、设置页 `VisualModelsSettings.tsx`

Spec 1 独有的 `videoPollFlavors.ts`（compat flavor）和 `visualModelBridge.ts`（桥接）**Seedance 都不用**。

### 2.2 改动清单（全为加法 / 对称扩展）

| 文件 | 改动 |
|---|---|
| `src/shared/constants/visualModels.ts` | `VisualProviderId` 加 `'ark'`；`VIDEO_MODELS` 加 Seedance 内置条目（pro/fast × t2v/i2v，duration clamp） |
| `src/host/services/media/imageGenerationService.ts` | 新增 `getArkApiKey()` → **复用现有 volcengine 槽** `getConfigService().getApiKey('volcengine')`，env `ARK_API_KEY` 回落（与 gptimage 范式一致） |
| `src/host/services/media/videoGenerationService.ts` | 新增 `submitAndPollArkVideo` + `parseArkVideoTask`；`generateVideo` 加 `model.provider === 'ark'` 分支（与 wanx/minimax 对称）；`downloadVideoAsBuffer` 补 `redirect:'manual'` SSRF 加固（main 尚缺，对齐 Spec 1） |
| `src/shared/constants/pricing.ts` | `VIDEO_PRICING_CNY_PER_SEC` 加 Seedance 条目（价表唯一真源，videoCost.ts 自动查表，不动 videoCost.ts） |
| `src/host/ipc/workspace.ipc.ts`（`providerKeyConfigured`，line ~687） | 加 `if (provider === 'ark') return !!getArkApiKey();` |

**不需要**新 SecureStorage 槽、不需要新设置字段、不需要新 key 保存 IPC —— Ark API Key 是账号级、聊天+视频共用，复用用户在「火山引擎(豆包) provider」里配的 key 即可。设置页只在 Seedance 模型旁给一句提示「需在 火山引擎(豆包) provider 配置 API Key」（可选，低优先）。

### 2.3 Ark 引擎实现要点（submitAndPollArkVideo）

签名对齐现有内置引擎（host 原语，剥离 ToolContext）：
```
submitAndPollArkVideo(apiKey, { model, mode, prompt, imageDataUrl, durationSec, resolution?, ratio? }, outerSignal)
  → { url }
```
- 复用本文件 `fetchWithAbort`（超时 + outerSignal）、`isRecord`、超时常量；create 用放宽超时（异步建任务可能慢，对齐 compat 的 `createTimeoutMs` 思路，默认 120s）。
- POST body 按 §1 结构化拼装；i2v 把 `imageDataUrl` 放 `content[].image_url.url`。
- 轮询循环：`succeeded` 取 `content.video_url` 返回；`failed/expired/cancelled` 抛错（带 status）；其余继续；超 `TOTAL` 抛超时。
- status 解析单独抽函数 `parseArkVideoTask`（对齐 `parseWanxVideoTask`），便于单测。

### 2.4 `generateVideo` 路由分支

在现有 `provider === 'minimax'` 分支之后加 `provider === 'ark'`：
```
if (model.provider === 'ark') {
  const apiKey = getArkApiKey();
  if (!apiKey) throw new Error('Seedance 视频需要火山方舟 Ark API Key。');
  const { url } = await submitAndPollArkVideo(apiKey, { model: model.id, mode: args.mode, prompt, imageDataUrl, durationSec, resolution: DEFAULT_RESOLUTION }, signal);
  return { url, actualModel: model.id, durationSec };
}
```

## 3. 鉴权落点（复用 volcengine 槽，零新增配置面）

- 应用**已有 `volcengine`(豆包) 聊天 provider**，base = `ark.cn-beijing.volces.com/api/v3`（见 `model-catalog.json`）。Ark API Key 是**账号级凭据，聊天 + 视频共用同一个 key**。
- key 存取：`getArkApiKey()` = `process.env.ARK_API_KEY || getConfigService().getApiKey('volcengine') || undefined`（与 gptimage 范式一致；底层走 SecureStorage；key 绝不写进代码/明文 json/spec/git）。
- 用户只要在「火山引擎(豆包) provider」配过 key，Seedance 视频即可用，**无需二次输入**；设置页 Seedance 旁可加一句提示（可选，低优先）。
- 纯 Bearer，**不实现 AK/SK V4 签名**。
- ⚠️ **凭据类型校验**：Ark API Key 是方舟控制台「API Key 管理」创建的单个 Bearer token，**不是** AK/SK（AccessKey/SecretKey）。AK/SK 形态（短 AK + 带点长 SK / STS token）不能直接用，需 V4 签名（非目标）。dogfood 前确认拿到的是 Ark API Key。

## 4. 守门顺序（复用 wanx 范式，全在付费请求之前）

模型存在（`videoModelById`）→ cap 命中 `mode` → t2v 需非空 prompt / i2v 需底图 → key 存在 → 才发 POST。任何一关不过直接抛错，零付费请求。

## 5. 产物落地（24h 过期硬约束）

取到 `content.video_url` 后**立刻** `downloadVideoAsBuffer(url)` 下载落 artifact（火山 URL 24h 过期，不能只存 URL）。复用现成 `downloadVideoAsBuffer`；**若 origin/main 的该函数缺 `redirect: 'manual'` SSRF 加固**（Spec 1 曾补 H1），本 spec 一并补齐，与 Spec 1 对齐（防 SSRF-via-redirect）。

## 6. 验证策略

- **TDD**：`submitAndPollArkVideo` / `parseArkVideoTask` 单测（mock fetch），覆盖：
  - t2v body 形状（content 仅 text）/ i2v body 形状（text + image_url）
  - status 全分支映射（succeeded→url；failed/expired/cancelled→抛错；queued/running→续轮询）
  - `content.video_url` 抽取（缺字段抛错）
  - 守门顺序（缺 prompt/底图/key 在付费前抛错）
  - create/poll 超时分支
- **类型检查 + 既有测试**绿（基线已知 10 个预存在失败非本功能）。
- **对抗审计** `/codex-audit`：SSRF（download redirect + image_url 注入）、付费前置守门完整性、key 不泄漏（不进日志/不进响应）、model id 校验、status 解析健壮性。
- **真 key dogfood**：林晨提供 Ark key 后，真出片一条（t2v 优先；i2v 顺带验 data URL 是否接受）。按 feedback_paid_dogfood_cost_safety **默认只跑一次**，成功判断匹配 Ark 原始响应 JSON（`"status":"succeeded"`），别 grep pretty-print。dogfood 前先核 §1.待校验点。

## 7. 分支与提交

- 分支 `feat/seedance-native`，从 **origin/main** 开（独立于 Spec 1 的 feat/multimodal-bridge，无 stack）。
- 工作树可能有别会话 WIP，提交只 `git add` 自己改的文件（§2.2 清单），逐文件 add，绝不 `git add -A`。
- 与 Spec 1 唯一共享 `videoGenerationService.ts` / `visualModels.ts`，Spec 2 改动为加法，两 spec 都落地时这两文件做一次小 merge（ark 分支 vs compat 分支正交，冲突小）。
- spec / plan 文档 untracked，不进公开 git。
- 不擅自 push / 合并；实现 + 自验 + dogfood 后给林晨拍板。

## 8. 非目标（YAGNI / deferred）

- HappyHorse（阿里 MaaS 原生 i2v）—— 单拆另开会话，复用本 spec 的 provider 骨架。
- Veo 原生（Spec 3）。
- Seedance 首尾帧 / 多参考图（最多 9 个 reference role）—— 内置 t2v/i2v 跑通后按需增量。
- AK/SK V4 签名鉴权。
- 桥接机制接入（原生 provider 不走桥）。
