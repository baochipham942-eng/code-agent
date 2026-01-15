# Code Agent 云端部署指南

本文档说明如何将 Code Agent 云端服务部署到 Vercel，并配置客户端自动更新。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                          云端服务                                │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐           │
│  │  Auth API    │  │  Sync API    │  │  Agent API   │           │
│  │  用户认证    │  │  数据同步    │  │  云端Agent   │           │
│  └──────────────┘  └──────────────┘  └──────────────┘           │
│         │                │                 │                     │
│         └────────────────┼─────────────────┘                     │
│                          │                                       │
│                   ┌──────▼──────┐                                │
│                   │  Neon DB    │                                │
│                   │  PostgreSQL │                                │
│                   └─────────────┘                                │
└─────────────────────────────────────────────────────────────────┘
```

## 前置条件

- GitHub 账号
- Vercel 账号（可用 GitHub 登录）
- Neon 数据库（可复用现有实例或新建）

## 部署步骤

### 步骤 1: 创建 GitHub 仓库

1. 在 GitHub 上创建新仓库：`code-agent`
2. 将代码推送到仓库：

```bash
cd /path/to/code-agent
git init
git add .
git commit -m "Initial commit"
git remote add origin git@github.com:YOUR_USERNAME/code-agent.git
git push -u origin main
```

### 步骤 2: 创建 GitHub OAuth App

1. 访问 GitHub Settings → Developer settings → OAuth Apps
2. 点击 "New OAuth App"
3. 填写信息：
   - Application name: `Code Agent`
   - Homepage URL: `https://your-app.vercel.app`
   - Authorization callback URL: `https://your-app.vercel.app/api/auth/github/callback`
4. 创建后记录：
   - **Client ID**
   - **Client Secret**（点击生成）

### 步骤 3: 配置 Neon 数据库

**选项 A：复用现有数据库**

如果你已有 Neon 数据库（如心理项目），可以直接复用：
- 使用同一个 `DATABASE_URL`
- 数据会存储在 `code_agent` schema 中，不会冲突

**选项 B：创建新数据库**

1. 访问 https://console.neon.tech
2. 创建新项目
3. 复制 `DATABASE_URL`

### 步骤 4: 部署云端服务到 Vercel

1. 访问 https://vercel.com/new
2. 导入 GitHub 仓库 `code-agent`
3. **重要**：设置 Root Directory 为 `cloud-agent`
4. 配置环境变量：

| 变量名 | 说明 | 示例 |
|--------|------|------|
| `DATABASE_URL` | Neon 连接字符串 | `postgresql://...` |
| `AUTH_SECRET` | JWT 签名密钥 | 随机 32 字符字符串 |
| `ANTHROPIC_API_KEY` | Claude API 密钥 | `sk-ant-...` |
| `GITHUB_CLIENT_ID` | GitHub OAuth ID | 步骤 2 获取 |
| `GITHUB_CLIENT_SECRET` | GitHub OAuth Secret | 步骤 2 获取 |
| `CI_PUBLISH_TOKEN` | CI 发布密钥 | 随机 32 字符字符串 |

生成随机密钥：
```bash
openssl rand -base64 32
```

5. 点击 Deploy

### 步骤 5: 初始化数据库

部署完成后，初始化数据库 Schema：

```bash
curl -X POST https://your-app.vercel.app/api/init-db \
  -H "X-Init-Key: YOUR_AUTH_SECRET"
```

成功响应：
```json
{
  "success": true,
  "message": "Database schema initialized successfully"
}
```

### 步骤 6: 配置 GitHub Actions Secrets

在 GitHub 仓库 Settings → Secrets and variables → Actions 中添加：

| Secret 名称 | 说明 |
|-------------|------|
| `CLOUD_API_URL` | Vercel 部署的 URL，如 `https://code-agent.vercel.app` |
| `CI_PUBLISH_TOKEN` | 与 Vercel 环境变量相同 |
| `CSC_LINK` | (可选) macOS 代码签名证书 |
| `CSC_KEY_PASSWORD` | (可选) 证书密码 |

### 步骤 7: 更新 GitHub OAuth 回调 URL

部署成功后，更新 GitHub OAuth App 的回调 URL：
- `https://YOUR-VERCEL-APP.vercel.app/api/auth/github/callback`

## 发布新版本

1. 更新 `package.json` 中的版本号
2. 创建 Git tag 并推送：

```bash
git tag v0.2.0
git push origin v0.2.0
```

3. GitHub Actions 会自动：
   - 构建 macOS/Windows/Linux 版本
   - 创建 GitHub Release
   - 通知云端 API 更新版本信息

## API 端点一览

### 认证
- `GET /api/auth/github` - GitHub OAuth 登录
- `GET /api/auth/github/callback` - OAuth 回调
- `GET /api/auth/me` - 获取当前用户
- `POST /api/auth/logout` - 登出

### 同步
- `POST /api/sync/push` - 推送数据到云端
- `GET /api/sync/pull` - 从云端拉取数据
- `GET /api/sync/stats` - 获取同步统计

### Agent
- `POST /api/agent/chat` - 云端 Agent 聊天
- `POST /api/agent/plan` - 生成执行计划

### 更新
- `GET /api/update/check` - 检查更新
- `GET /api/update/latest-mac.yml` - macOS 更新清单
- `GET /api/update/latest-win.yml` - Windows 更新清单
- `POST /api/update/publish` - 发布新版本（CI 专用）

### 管理
- `POST /api/init-db` - 初始化数据库
- `GET /api/health` - 健康检查

## 故障排除

### 数据库连接失败
- 检查 `DATABASE_URL` 是否正确
- 确认 Neon 项目是否在运行状态
- 检查 IP 白名单设置

### OAuth 登录失败
- 确认回调 URL 与 GitHub OAuth App 配置一致
- 检查 `GITHUB_CLIENT_ID` 和 `GITHUB_CLIENT_SECRET`

### 更新检查失败
- 确认 `releases` 表中有数据
- 检查 `is_latest` 字段是否正确设置

## 成本估算

| 服务 | 免费额度 | 预估月费 |
|------|----------|----------|
| Vercel | 100GB 带宽 | $0-20 |
| Neon | 0.5GB 存储 | $0 (复用) |
| GitHub Actions | 2000 分钟 | $0 |
| **总计** | | **$0-20/月** |
