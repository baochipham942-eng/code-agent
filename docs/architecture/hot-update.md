# 热更新机制

> 云端配置热更新架构

## 概述

Agent Neo 采用前后端分离的配置架构，支持多种配置的热更新：
- System Prompt
- Skill 定义
- Tool 元数据
- Feature Flags
- MCP Server 配置
- UI 字符串
- Capability Registry
- Agent Engine 模型目录
- 更新元数据与 runtime asset manifest

**核心优势**：修改配置只需部署云端，无需重新打包客户端。

---

## 架构图

```
┌─────────────────┐     HTTP GET      ┌─────────────────┐
│   Agent Neo     │ ─────────────────▶│   Vercel API    │
│    (Client)     │                   │  /api/v1/config │
│                 │ ◀───────────────── │                 │
│  CloudConfig    │ signed envelope   │   云端配置       │
│    Service      │                   │                 │
└─────────────────┘                   └─────────────────┘
        │
        ▼
┌─────────────────┐
│   本地缓存       │
│  (1 小时 TTL)   │
└─────────────────┘
        │
        ▼ (离线/失败)
┌─────────────────┐
│   内置配置       │
│ (builtinConfig) │
└─────────────────┘
```

---

## 核心服务

### CloudConfigService

**位置**: `src/main/services/cloud/cloudConfigService.ts`

**职责**:
- 从云端拉取配置
- 缓存管理（TTL + ETag）
- 离线降级

**关键方法**:

```typescript
class CloudConfigService {
  // 初始化（异步拉取，不阻塞）
  async initialize(): Promise<void>;

  // 刷新配置
  async refresh(): Promise<void>;

  // 获取配置
  getConfig(): CloudConfig;
  getPrompt(generationId: GenerationId): string;
  getSkills(): SkillDefinition[];
  getFeatureFlags(): FeatureFlags;
  getMCPServers(): MCPServerCloudConfig[];
}
```

### FeatureFlagService

**位置**: `src/main/services/cloud/featureFlagService.ts`

**职责**: 提供 Feature Flag 的便捷访问接口

```typescript
class FeatureFlagService {
  getAll(): FeatureFlags;
  get<K extends keyof FeatureFlags>(key: K): FeatureFlags[K];
  isGen8Enabled(): boolean;
  isCloudAgentEnabled(): boolean;
}
```

---

## 配置结构

### CloudConfig

```typescript
interface CloudConfig {
  version: string;           // 配置版本号
  prompts: Record<GenerationId, string>;  // 各代 Prompt
  skills: SkillDefinition[]; // Skill 定义
  toolMeta: Record<string, ToolMetadata>; // 工具元数据
  featureFlags: FeatureFlags; // Feature Flags
  mcpServers: MCPServerCloudConfig[]; // MCP 服务器配置
  uiStrings: Record<string, string>;  // UI 字符串
}
```

### FeatureFlags

```typescript
interface FeatureFlags {
  enableGen8: boolean;       // 启用 Gen8 自我进化
  enableCloudAgent: boolean; // 启用云端 Agent
  maxIterations: number;     // 最大迭代次数
  enableMemory: boolean;     // 启用记忆系统
  enableVision: boolean;     // 启用视觉工具
}
```

---

## 缓存策略

### TTL（Time To Live）

- 默认缓存时间：**1 小时**
- 缓存过期后异步刷新，不阻塞请求

### ETag 支持

```
请求: GET /api/v1/config
      If-None-Match: "abc123"

响应: 304 Not Modified（配置未变化）
或
响应: 200 OK
      ETag: "def456"
      Body: { ... }
```

### 离线降级

当云端不可达时，自动降级到内置配置：

```typescript
// builtinConfig.ts
export const getBuiltinConfig = (): CloudConfig => ({
  version: 'builtin-1.0',
  prompts: { ... },
  skills: [ ... ],
  // ...
});
```

---

## API 端点

### 获取配置

```
GET https://agentneo.vercel.app/api/v1/config
```

**响应**:
```json
{
  "schemaVersion": 1,
  "kind": "cloud_config",
  "issuedAt": "2026-05-17T05:00:00.000Z",
  "expiresAt": "2026-05-17T06:00:00.000Z",
  "contentHash": "sha256:...",
  "keyId": "production-2026-05",
  "signature": "...",
  "payload": {
    "version": "1.0.5",
    "prompts": {},
    "skills": [],
    "toolMeta": {},
    "featureFlags": {
      "enableCloudAgent": true,
      "enableMemory": true,
      "enableComputerUse": true,
      "maxIterations": 50,
      "maxMessageLength": 100000,
      "enableExperimentalTools": false
    },
    "uiStrings": {
      "zh": {},
      "en": {}
    },
    "rules": {},
    "mcpServers": []
  }
}
```

客户端只接受 `kind:"cloud_config"`、hash 匹配、未过期且 Ed25519 签名通过的响应。未签名、过期、hash mismatch 或未知 key 会回退到内置配置。

```
GET https://agentneo.vercel.app/api/prompts?gen=all
```

**响应**:
```json
{
  "schemaVersion": 1,
  "kind": "prompt_registry",
  "expiresAt": "2026-05-17T06:00:00.000Z",
  "contentHash": "sha256:...",
  "keyId": "production-2026-05",
  "signature": "...",
  "payload": {
    "version": "1.0.5",
    "prompts": {}
  }
}
```

`/api/v1/control-plane?artifact=cloud_config|prompt_registry|capability_registry|agent_engine_models` 复用同一签名逻辑。`agent_engine_models` 是 `agent_engine_model_catalog` 的短别名，给客户端读取 Codex / Claude 外部 engine 模型目录用；`/api/v1/agent-engine-models` 作为同类 envelope 的专用入口保留。

打包链会从 `CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS` 或 `CODE_AGENT_CONTROL_PLANE_KEY_ID + CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY` 生成 `dist/web/control-plane-public-keys.json`，并通过 Tauri resources 带进客户端。运行时优先使用 env 公钥；env 缺失时读取该 bundled public key file。

### Agent Engine 模型目录

Agent Engine 模型目录不属于普通 Provider 路由。它只约束外部 CLI engine：

| 字段 | 用途 |
|------|------|
| `kind` | `codex_cli` 或 `claude_code` |
| `defaultModel` | 服务端推荐默认模型 |
| `models[].id` | 传给 `codex exec --model` 或 `claude -p --model` 的模型 id |
| `models[].disabledReason` | 远程禁用原因，客户端不可选择 |
| `models[].capabilities` | UI 展示和筛选用能力标签 |

客户端读取顺序：

1. `RemoteAgentEngineModelCatalogService` 请求 `/api/v1/control-plane?artifact=agent_engine_models`。
2. 验证 control-plane envelope 的 `kind`、hash、过期时间、公钥和 Ed25519 签名。
3. 解析目录，过滤非法 engine/model/capability。
4. 失败时回退 `BUILTIN_AGENT_ENGINE_MODEL_CATALOG`，并把 diagnostics 暴露给设置页。

release bundle 和 env generator 必须同时产出 `agent-engine-model-catalog.json`，并写入 `CONTROL_PLANE_AGENT_ENGINE_MODEL_CATALOG_JSON`。生产 smoke 需要覆盖该 artifact，避免只验证 cloud config / prompt / capability registry。

### Update Download Redirect

官网和应用内下载入口不再硬编码某个版本的 DMG：

```
GET /api/update?action=download&platform=darwin&channel=stable
```

Update API 优先读取 `UPDATE_DOWNLOAD_URL_<CHANNEL>`；没有 override 时通过 `vercel-api/lib/updateMetadata.ts` 内部的 `fetchLatestRelease`（模块私有函数，从外部 export 出来的是 `buildUpdateResponseFromRelease` / `runtimeAssetsMetadataFromRelease` 等高阶 helper）拉取 release manifest，选择匹配平台的 DMG asset，并返回 302。找不到 asset 时返回 `download_asset_not_found` 和 release 页面链接。

### 发布托管：阿里云上海 OSS

2026-05-27 主仓库改为私有后，匿名访问 GitHub Releases 全部 404，三条更新链（落地页下载 / app 内更新 / Tauri updater）同时断更。2026-05-28 整条分发链路迁移到阿里云上海 OSS（commit `8981118f`）：

| 位置 | 旧端点（GitHub） | 新端点（OSS） |
|------|------------------|---------------|
| `vercel-api/lib/updateMetadata.ts` `fetchLatestRelease` | `https://api.github.com/repos/.../releases/latest` | `https://agent-neo-releases.oss-cn-shanghai.aliyuncs.com/stable/release.json` |
| `tauri.conf.json` updater 端点 | `github.com/.../releases/latest/download/latest.json` | `agent-neo-releases.oss-cn-shanghai.aliyuncs.com/stable/latest.json` |
| `updateService.ts` GitHub fallback | `api.github.com/repos/.../releases/latest` | `agent-neo-releases.oss-cn-shanghai.aliyuncs.com/stable/release.json` |

**Bucket**：`agent-neo-releases` @ `oss-cn-shanghai`（国内直连 1.9MB/s+ 无需代理）。

**Manifest 形状**：`stable/release.json` 保持 GitHub Release JSON 形状，下游 `selectAsset` / `buildUpdateResponseFromRelease` / `runtimeAssetsMetadataFromRelease` 无需任何改动。可通过 `UPDATE_RELEASE_MANIFEST_URL` env 覆盖。

**每个版本上传 5 个对象**：
- `v${VER}/Agent-Neo-${VER}-arm64.dmg` — DMG 本体
- `v${VER}/Agent.Neo.app.tar.gz` — Tauri updater 增量包（key 不带空格，避免 updater URL 转义差异）
- `v${VER}/Agent.Neo.app.tar.gz.sig` — 签名
- `stable/latest.json` — Tauri updater manifest
- `stable/release.json` — Vercel updateMetadata 读取的 GitHub-shaped manifest

`stable/latest.json.notes` 与 `stable/release.json.body` 都必须来自同一份 `docs/releases/v${VER}.md`。前者会进入 Tauri 原生 updater 的 `update.body`，最终展示在可选更新弹窗和设置页；后者会进入 cloud update API 的 `releaseNotes`，用于 native updater 不可用或强制更新策略场景。

**上传命令**：`~/bin/ossutil cp <local> oss://agent-neo-releases/<key> --acl public-read --force`

**Release 脚本钩子**：`export TAURI_UPDATER_ENDPOINT=…/stable/latest.json`（release 脚本会用它覆盖生成 updater conf）。

**已知边界**：旧版本（v0.16.80 及之前）仍指向 GitHub 端点，无法自动更新到 OSS 链路，需用户手动重装一次新版本完成切换。

### Renderer active bundle serve safety（2026-06-12）

Renderer hot-update 的 active bundle 不能压过更新后的 shell 修复。`resolveRendererServeDir()` 现在接受当前 shell version：如果 `.bundle-meta.json.version` 低于 shell version，即使 active bundle 有 `index.html`，web static router 也回退 serve 包内 builtin renderer。

| 场景 | Serve 目录 |
|------|------------|
| hot-update kill switch 打开 | builtin renderer |
| active bundle 缺 meta 或缺 `index.html` | builtin renderer |
| active bundle version < current shell version | builtin renderer |
| active bundle version >= current shell version 且健康 | active renderer cache |

这条只保证"旧前端不能遮住新壳修复"；它不代表远端 renderer latest 已经发布成功。生产补发仍要继续核 `renderer-bundle/latest/manifest.json`、`release-record.json` 和 app update latestVersion 是否对位。

---

## 更新流程

### 启动时

```
1. 创建窗口（不等待配置）
2. 异步调用 CloudConfigService.initialize()
3. 成功 → 使用云端配置
   失败 → 使用内置配置（静默）
```

### 运行时刷新

```typescript
// 手动刷新
await cloudConfigService.refresh();

// 定时刷新（每小时）
setInterval(() => cloudConfigService.refresh(), 3600000);
```

---

## 文件结构

```
src/main/services/cloud/
├── index.ts               # 导出入口
├── cloudConfigService.ts  # 云端配置服务
├── featureFlagService.ts  # Feature Flag 服务
└── builtinConfig.ts       # 内置配置

vercel-api/api/v1/
├── config.ts              # 签名 cloud_config envelope
└── control-plane.ts       # control-plane artifact 路由
vercel-api/api/
└── prompts.ts             # 签名 prompt_registry envelope
vercel-api/lib/
├── controlPlaneEnvelope.ts
└── controlPlanePayloads.ts
dist/web/
└── control-plane-public-keys.json
```

---

## 使用示例

### 获取 Prompt

```typescript
const prompt = getCloudConfigService().getPrompt('gen4');
```

### 检查 Feature Flag

```typescript
if (getFeatureFlagService().isGen8Enabled()) {
  // 启用 Gen8 工具
}
```

### 获取 MCP 服务器配置

```typescript
const mcpServers = getCloudConfigService().getMCPServers();
```

---

## 注意事项

1. **启动不阻塞**: 配置拉取在后台进行，不影响窗口创建
2. **验签失败降级**: 网络失败、未签名、过期或 hash mismatch 都使用内置配置
3. **私钥不进客户端**: Vercel 只保存 Ed25519 私钥，客户端只配置公钥
4. **版本检查**: 客户端记录配置版本、key id、expiresAt 和 trust diagnostics，方便调试
5. **日志记录**: 配置加载状态会记录到日志
