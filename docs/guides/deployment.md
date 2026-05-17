# Code Agent 部署配置指南

> 从 CLAUDE.md 提取的部署相关文档

## 部署架构总览

```
┌─────────────────────────────────────────────────────────────────┐
│                      Code Agent 部署架构                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  ┌──────────────┐                                               │
│  │   客户端      │ Electron / Tauri 桌面应用                     │
│  │  (macOS)     │ - Electron: npm run dist:mac (~169MB DMG)     │
│  └──────┬───────┘ - Tauri: cargo tauri build (~33MB DMG)        │
│         │                                                       │
│         │ HTTPS                                                 │
│         ▼                                                       │
│  ┌──────────────────────────────────────────────────────┐       │
│  │                    Vercel                             │       │
│  │  https://code-agent-beta.vercel.app                   │       │
│  │                                                       │       │
│  │  /api/update    - 版本检查                            │       │
│  │  /api/auth      - GitHub OAuth                        │       │
│  │  /api/sync      - 数据同步                            │       │
│  │  /api/prompts   - 签名 Prompt registry                │       │
│  │  /api/model-proxy - AI 模型代理                       │       │
│  │  /api/tools     - 云端工具 (搜索/抓取/PPT)            │       │
│  └──────────────────────┬───────────────────────────────┘       │
│                         │                                       │
│         ┌───────────────┼───────────────┐                       │
│         │               │               │                       │
│         ▼               ▼               ▼                       │
│  ┌────────────┐  ┌────────────┐  ┌────────────┐                 │
│  │  Supabase  │  │ 阿里云 FC  │  │  AI APIs   │                 │
│  │  PostgreSQL│  │ DDG 代理   │  │ DeepSeek   │                 │
│  │  + pgvector│  │            │  │ 智谱/OpenAI│                 │
│  └────────────┘  └────────────┘  └────────────┘                 │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## Vercel 配置

| 配置项 | 值 |
|--------|-----|
| 项目名 | `code-agent` |
| 域名 | `https://code-agent-beta.vercel.app` |
| Root Directory | `vercel-api` |

```bash
# 验证部署
curl -s "https://code-agent-beta.vercel.app/api/update?action=health"
```

### API 端点列表

> 注意：由于 Vercel Hobby 计划 12 函数限制，运维类 API 已整合

| 端点 | 说明 |
|------|------|
| /api/agent | 云端 Agent |
| /api/auth | GitHub OAuth 认证 |
| /api/model-proxy | 模型代理 |
| /api/prompts | 签名 Prompt registry envelope |
| /api/sync | 数据同步 |
| /api/system | 运维整合（health/init-db/migrate）|
| /api/tools | 云端工具（api/scrape/search/ppt）|
| /api/update | 版本更新检查 |
| /api/user-keys | 用户 API Key 管理 |
| /api/v1/config | 云端配置中心 |
| /api/v1/control-plane | control-plane artifact 路由 |

### system.ts 用法

```bash
# 健康检查
curl "https://code-agent-beta.vercel.app/api/system?action=health"

# 初始化数据库（需要 X-Init-Key header）
curl -X POST "https://code-agent-beta.vercel.app/api/system?action=init-db" \
  -H "X-Init-Key: $DB_INIT_KEY"

# 数据库迁移
curl -X POST "https://code-agent-beta.vercel.app/api/system?action=migrate" \
  -H "X-Init-Key: $DB_INIT_KEY"
```

---

## 阿里云函数计算 (FC)

用于 DuckDuckGo 搜索代理，绕过国内网络限制。

| 配置项 | 值 |
|--------|-----|
| 服务名 | `code-agent-proxy` |
| 运行环境 | Node.js 18 |
| 内存 | 128MB |
| 超时 | 30s |
| 代码位置 | `vercel-api/docs/aliyun-fc-proxy.js` |

### 部署步骤

1. 登录阿里云函数计算控制台 https://fc.console.aliyun.com
2. 创建服务 `code-agent-proxy`
3. 创建函数，粘贴 `vercel-api/docs/aliyun-fc-proxy.js` 代码
4. 配置 HTTP 触发器（公网访问）
5. 复制触发器 URL 到 Vercel 环境变量 `DUCKDUCKGO_PROXY_URL`

### 验证

```bash
curl -X POST "https://<your-fc-trigger-url>" \
  -H "Content-Type: application/json" \
  -d '{"query": "test search", "maxResults": 5}'
```

---

## Control-plane 签名配置

`/api/v1/config` 和 `/api/prompts` 必须返回 control-plane envelope。客户端会验证：

- `schemaVersion: 1`
- `kind` 分别为 `cloud_config` 或 `prompt_registry`
- `contentHash` 与 `payload` 匹配
- `expiresAt` 未过期
- `keyId` 对应本地配置的 Ed25519 公钥
- `signature` 验签通过

Vercel 端只保存私钥和待下发 payload。缺少签名密钥或 payload 时，接口返回 `503 control_plane_unconfigured`，客户端会回退内置配置。

### Vercel 环境变量

| 变量 | 说明 |
|------|------|
| `CONTROL_PLANE_PRIVATE_KEY` | Ed25519 PKCS8 PEM 私钥，支持原始 PEM、转义换行或 base64 PEM |
| `CONTROL_PLANE_KEY_ID` | 签名 key id，必须与客户端配置的公钥 key id 对应 |
| `CONTROL_PLANE_TTL_SECONDS` | envelope 有效期，默认 3600 秒 |
| `CONTROL_PLANE_CLOUD_CONFIG_JSON` | `/api/v1/config` 的完整 `CloudConfig` payload |
| `CONTROL_PLANE_PROMPT_REGISTRY_JSON` | `/api/prompts` 的 `{ "version": "...", "prompts": { ... } }` payload |

客户端公钥配置：

```bash
CODE_AGENT_CONTROL_PLANE_KEY_ID="production-2026-05"
CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY="-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"
```

也可以用 JSON 一次配置多把公钥：

```bash
CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS='{"production-2026-05":"-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----"}'
```

`npm run build:web` 会把这些公钥写入 `dist/web/control-plane-public-keys.json`。Tauri release bundle 会把该文件放进 app resources；Finder 启动时即使没有 shell env，客户端也能用随包公钥验证 Vercel 返回的签名 envelope。`tauri:release:bundle` 默认要求 release 环境提供 control-plane 公钥，可用 `REQUIRE_CONTROL_PLANE_PUBLIC_KEYS=0` 关闭这个 gate。

如果 CI 不方便直接放 JSON，也可以设置 `CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE` 指向一个只含公钥的 JSON 文件；build 会读取它并写入随包公钥文件。

### API 验证

```bash
# 获取签名 cloud config envelope
curl "https://code-agent-beta.vercel.app/api/v1/config"

# 获取签名 prompt registry envelope
curl "https://code-agent-beta.vercel.app/api/prompts?gen=all"

# 统一路由
curl "https://code-agent-beta.vercel.app/api/v1/control-plane?artifact=prompt_registry"

# 版本更新检查，Vercel 端从 GitHub Releases 派生 metadata，可按 channel 叠加 release policy
curl "https://code-agent-beta.vercel.app/api/update?action=check&version=0.16.75&platform=darwin&channel=stable"
```

Update policy 可通过 Vercel env 下发：`UPDATE_MIN_VERSION`、`UPDATE_LATEST_VERSION`、`UPDATE_FORCE_UPDATE`、`UPDATE_DOWNLOAD_URL`、`UPDATE_SHA256`。按 channel 覆盖时追加大写后缀，例如 `UPDATE_MIN_VERSION_BETA`。

---

## 智谱 vs DeepSeek 模型对比

本应用支持智谱和 DeepSeek 两个基础模型提供商。如果配置了智谱 API Key，将优先使用智谱。

### 价格对比（2025-01 更新）

| 能力 | 智谱 GLM-4.7 | DeepSeek V3.2 | 说明 |
|------|-------------|---------------|------|
| 输入价格 | ¥2-4/M tokens | $0.28/M (~¥2/M) | 智谱按上下文长度分层 |
| 输出价格 | ¥8-16/M tokens | $0.42/M (~¥3/M) | DeepSeek 更便宜 |
| 缓存命中 | ¥0.4-0.8/M | $0.028/M (~¥0.2/M) | 缓存后 DeepSeek 优势明显 |
| 免费模型 | GLM-4.7-Flash ✅ | ❌ | 智谱有免费快速模型 |
| 上下文 | 200K | 128K | 智谱支持更长上下文 |

### 功能对比

| 功能 | 智谱 | DeepSeek | 备注 |
|------|------|----------|------|
| Tool Calls | ✅ | ✅ | 均支持 |
| JSON Mode | ✅ | ✅ | 均支持 |
| Streaming | ✅ | ✅ | 均支持 |
| 视觉理解 | GLM-4.6V | ❌ | 智谱支持多模态 |
| 图片生成 | CogView-4 (¥0.06/张) | ❌ | 智谱独有 |
| 视频生成 | CogVideoX-3 (¥1/个) | ❌ | 智谱独有 |
| 思维链推理 | GLM-Z1 系列 | deepseek-reasoner | 均支持 |

### 推荐配置

| 场景 | 推荐 | 原因 |
|------|------|------|
| 编程助手（高频使用） | 智谱 Coding Max | 固定成本，高速率 |
| 多模态（图片/视频） | 智谱 | 独有能力 |
| 长上下文处理 | 智谱 GLM-4.7 | 200K 上下文 |
| 成本敏感（按量付费） | DeepSeek | 输出价格便宜 50%+ |
| 推理能力 | DeepSeek Reasoner | 思维链更强 |

---

## .env 文件位置

| 场景 | 路径 |
|------|------|
| 开发模式 | `/Users/linchen/Downloads/ai/code-agent/.env` |
| Tauri 打包 | release 包不得打入 `.env`、私钥或本地 token |

签名私钥只放 Vercel 环境变量。客户端只配置 control-plane 公钥；如果公钥缺失，远程 config/prompts 会被拒绝并降级到内置配置。

---

## Tauri 打包

Tauri 2.x 作为 Electron 的轻量替代方案，产物体积约 33MB（Electron ~169MB）。

### 前置条件

- Rust 工具链: `rustup`（安装后确保 `cargo` 在 PATH 中）
- Xcode Command Line Tools（macOS 编译需要）

### 打包流程

```bash
npm run typecheck && npm version patch --no-git-tag-version
git add package.json && git commit -m "chore: bump version" && git push
npm run build && npm run build:web && cargo tauri build
# 产物位置: src-tauri/target/release/bundle/dmg/Code Agent_*.dmg
```

### 开发模式

```bash
# 需要代理访问国际 API
HTTPS_PROXY=http://127.0.0.1:7897 cargo tauri dev
```

### 与 Electron 的关键差异

| 项目 | Electron | Tauri |
|------|----------|-------|
| DMG 体积 | ~169MB | ~33MB |
| 原生模块 | `npm run rebuild-native` 必需 | 不需要 |
| .env 部署 | 手动 `cp` 到 Resources | release 包禁止打入 `.env` |
| 构建命令 | `npm run dist:mac` | `npm run tauri:release:bundle` |
| 开发命令 | `npm run dev` | `cargo tauri dev` |
| Auto-update | Electron updater | Tauri updater signature + `latest.json` manifest |

---

## Bridge 服务部署

Local Bridge 为 Web 端提供本地能力（文件读写、Shell 执行等），通过 localhost:9527 通信。

### 安装

**macOS:**
```bash
curl -fsSL https://code-agent.dev/install.sh | bash
```

**Windows:**
```powershell
irm https://code-agent.dev/install.ps1 | iex
```

### 构建

```bash
npm run build:bridge
# 产物: dist/bridge/code-agent-bridge.cjs (1.8MB)
```

### 启动

```bash
node dist/bridge/code-agent-bridge.cjs --dir /path/to/project
# 监听 localhost:9527
```

### 验证

```bash
# 健康检查
curl http://localhost:9527/api/health

# 带 Auth Token 调用
TOKEN=$(cat ~/.code-agent-bridge/token)
curl -H "Authorization: Bearer $TOKEN" http://localhost:9527/api/tools
```

### 安全说明

- Auth Token 在首次启动时自动生成，存储于 `~/.code-agent-bridge/token`
- CORS 仅允许 localhost 来源
- 工作目录沙箱：所有文件操作限制在 `--dir` 指定的目录内
- 命令黑名单：阻止 `rm -rf /`、`sudo`、`curl|bash` 等危险命令
