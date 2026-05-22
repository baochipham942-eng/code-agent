# 2026-05-22 Agent Engine 模型目录与 Web 持久化状态 Spec

## 目标

把外部 Agent Engine 的模型选择、显式模型降级边界、Web 会话持久化状态和发布下载入口收成可验证合同。

## 非目标

- 不把 Native Agent Neo 的普通 Provider 模型迁到 Agent Engine 模型目录。
- 不改变 Tauri updater 的 `.app.tar.gz + .sig + latest.json` 更新路径。
- 不把 Web persistence health 当成 Supabase 同步状态。
- 不让外部 Codex / Claude engine 获得 workspace 之外的 cwd 或 write 权限。

## 合同

### Agent Engine 模型目录

控制面新增 `agent_engine_model_catalog` artifact。远程 payload 必须被 Ed25519 envelope 包裹，`kind` 必须等于 `agent_engine_model_catalog`，客户端只接受未过期、hash 匹配、签名可信的目录。

目录结构：

```ts
interface AgentEngineModelCatalog {
  version: string;
  updatedAt: string;
  engines: Array<{
    kind: 'codex_cli' | 'claude_code';
    defaultModel: string;
    models: Array<{
      id: string;
      label: string;
      capabilities: ModelCapability[];
      recommended?: boolean;
      disabledReason?: string;
      updatedAt?: string;
    }>;
  }>;
}
```

验签失败、未配置公钥、网络失败、payload 不合法时，客户端回退到 `BUILTIN_AGENT_ENGINE_MODEL_CATALOG`，并带 diagnostics 给设置页展示。

### 外部 engine 选择

`AgentEngineSessionMetadata.model` 表示当前 session 对外部 CLI 的模型选择。`codex_cli` 运行时传 `codex exec --model <id>`；`claude_code` 运行时传 `claude -p --model <id>`。如果用户没有显式选择模型，使用本机设置里的 engine 默认模型；如果本机默认不可用，使用远程目录默认；再不行取第一个 enabled model。

所有外部 engine 仍满足：

- 只允许 manual chat session。
- `cwd` 必须在 workspace root 内。
- 当前 release 只允许 `read_only` permission profile。

### 显式模型降级

用户点选具体 Native model 后，`modelConfig.adaptive` 为 false。此时 Provider 失败、能力不匹配或 artifact-write 偏好都不能跨 provider fallback；错误应回到当前模型链路。只有用户选择“自动”时，`adaptive=true` 才启用跨 provider fallback 和 capability fallback。

### Web 持久化健康

`GET /api/health` 返回：

```ts
interface PersistenceHealth {
  status: 'available' | 'unavailable';
  mode: 'database' | 'memory';
  durable: boolean;
  message: string;
  reason?: string;
  checkedAt: number;
}
```

Web 模式下 SQLite 初始化成功时 `durable=true`；失败时 `durable=false`，会话只在进程内有效。状态栏和 Data Settings 只在 `durable=false` 时提示用户。

### 发布与下载入口

官网下载按钮走 `/api/update?action=download&platform=darwin&channel=stable`。Update API 优先使用 channel-specific `UPDATE_DOWNLOAD_URL_*`，否则查最新 GitHub Release 中匹配平台的 DMG asset 并 302 跳转。

## 验收

- `npx vitest run tests/unit/agentEngine/agentEngineModelCatalog.test.ts tests/unit/agentEngine/agentEngineContract.test.ts tests/renderer/components/modelSwitcher.agentEngine.test.ts tests/unit/model/modelRouter.test.ts`
- `npx vitest run tests/unit/web/healthRouter.persistence.test.ts tests/unit/web/sessionCache.persistence.test.ts tests/renderer/services/persistenceHealth.test.ts`
- `npx vitest run tests/scripts/controlPlaneReleaseBundle.test.ts tests/scripts/controlPlaneSmoke.test.ts tests/scripts/generateControlPlaneEnv.test.ts tests/unit/vercel/controlPlaneArtifacts.test.ts tests/unit/vercel/updateMetadata.test.ts`
- `npm run acceptance:session-persistence`
- `npm run release:verify-macos`
