# Vercel 部署问题总结与解决方案

## 部署过程中遇到的问题

### 1. Root Directory 配置问题
**问题**: Vercel 默认从项目根目录部署，但我们的云端代码在 `cloud-agent/` 子目录
**解决**: 在 Vercel Dashboard → Settings → General → Root Directory 设置为 `cloud-agent`

### 2. Secret 引用错误
**问题**: `vercel.json` 中使用 `@secret-name` 引用 Secret，但 Hobby plan 不支持
```json
// 错误写法
"env": {
  "DATABASE_URL": "@database-url"
}
```
**解决**: 删除 `vercel.json` 中的 env 配置，改用 Vercel Dashboard → Environment Variables 配置

### 3. 缺少 Output Directory
**问题**: `Error: No Output Directory named "public" found`
**解决**: 创建 `cloud-agent/public/index.json` 文件，并在 `vercel.json` 中设置 `"outputDirectory": "public"`

### 4. Serverless Functions 数量超限
**问题**: Hobby plan 限制最多 12 个 Serverless Functions，我们有 16 个
**解决**: 将多个相关 API 合并为统一端点，使用 `?action=` 参数区分：
- `/api/auth?action=github|callback|me|logout`
- `/api/sync?action=push|pull|stats`
- `/api/update?action=check|latest|publish`
- `/api/agent?action=chat|plan`

### 5. ES Module 导入路径问题
**问题**: `Error [ERR_MODULE_NOT_FOUND]: Cannot find module '../lib/auth'`
**原因**: ES Modules 要求导入时必须包含 `.js` 扩展名
**解决**: 所有导入语句添加 `.js` 扩展名
```typescript
// 错误
import { getDb } from '../lib/db';
// 正确
import { getDb } from '../lib/db.js';
```

### 6. 环境变量格式问题
**问题**: `DATABASE_URL` 前面有 tab 字符导致连接失败
```
Connection string: \tpostgresql://...
```
**解决**: 在 Vercel Dashboard 中删除并重新粘贴环境变量值，确保没有前导空白字符

## 推荐的 Claude Code 插件

### 安装命令
```bash
claude plugin install <plugin-name>@claude-plugins-official
```

### 已安装的插件

| 插件名 | 功能 | 常用命令 |
|--------|------|----------|
| `vercel` | Vercel 部署 | `/deploy`, `/vercel-logs`, `/vercel-setup` |
| `commit-commands` | Git 提交 | `/commit`, `/commit-push-pr` |
| `code-review` | 代码审查 | `/code-review` |
| `typescript-lsp` | TypeScript 语言服务 | 自动类型检查 |
| `feature-dev` | 功能开发 | `/feature-dev` |
| `agent-sdk-dev` | Agent SDK 开发 | 创建 Agent 应用 |
| `security-guidance` | 安全指导 | 安全最佳实践 |

### Vercel Plugin 使用场景
- "deploy my app" - 部署应用
- "deploy this to production" - 部署到生产环境
- "show deployment logs" - 查看部署日志
- "check vercel status" - 检查部署状态

## 部署前检查清单

- [ ] `package.json` 包含 `"type": "module"` (如果使用 ES Modules)
- [ ] 所有导入语句包含 `.js` 扩展名
- [ ] Serverless Functions 数量 ≤ 12
- [ ] 环境变量无前导/尾随空白字符
- [ ] Root Directory 正确设置
- [ ] `vercel.json` 不包含 `@secret` 引用

## 环境变量配置

| 变量名 | 说明 | 示例 |
|--------|------|------|
| DATABASE_URL | Neon PostgreSQL 连接字符串 | `postgresql://user:pass@host/db?sslmode=require` |
| AUTH_SECRET | JWT 签名密钥 | `openssl rand -base64 32` 生成 |
| GITHUB_CLIENT_ID | GitHub OAuth App ID | `Ov23li...` |
| GITHUB_CLIENT_SECRET | GitHub OAuth Secret | `ed77e6...` |
| GITHUB_CALLBACK_URL | OAuth 回调地址 | `https://your-app.vercel.app/api/auth?action=callback` |
| ANTHROPIC_API_KEY | Claude API 密钥 (云端 Agent 用) | `sk-ant-...` |
| CI_PUBLISH_TOKEN | CI 发布版本用 Token | 自定义强密码 |
