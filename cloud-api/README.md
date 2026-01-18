# ⚠️ 已废弃 - 请勿修改此目录！

> **警告**：此目录 (`cloud-api/`) 已废弃，不再被 Vercel 部署。
>
> **请使用 `cloud-agent/` 目录！**
>
> - 正确的 API 目录：`cloud-agent/`
> - 正确的部署域名：`https://code-agent-beta.vercel.app`
> - 修改此目录的文件不会有任何效果

---

# Code Agent Cloud API (已废弃)

版本检查与更新服务 API。

## ~~部署到 Vercel~~（已废弃）

### 方法 1: Vercel CLI

```bash
cd cloud-api
npm install
npx vercel login
npx vercel --prod
```

### 方法 2: GitHub 集成

1. 将此文件夹 push 到 GitHub 仓库
2. 在 Vercel Dashboard 导入项目
3. 选择 `cloud-api` 作为根目录
4. 自动部署

### 方法 3: Vercel Dashboard 直接导入

1. 访问 https://vercel.com/new
2. 导入 Git 仓库
3. 设置根目录为 `cloud-api`
4. 部署

## API 端点

### 健康检查
```
GET /api/update
GET /api/update?action=health
```

### 检查更新
```
GET /api/update?action=check&version=1.0.0&platform=darwin
```

响应:
```json
{
  "success": true,
  "hasUpdate": true,
  "currentVersion": "1.0.0",
  "latestVersion": "1.0.1",
  "publishedAt": "2025-01-17T...",
  "releaseNotes": "...",
  "downloadUrl": "https://...",
  "fileSize": 157286400
}
```

### 获取最新版本信息
```
GET /api/update?action=latest
```

## 更新版本

编辑 `api/update.ts` 中的 `LATEST_RELEASE` 常量:

```typescript
const LATEST_RELEASE: ReleaseInfo = {
  version: '1.0.2',  // 更新版本号
  publishedAt: new Date().toISOString(),
  releaseNotes: `更新说明...`,
  downloads: {
    darwin: {
      url: 'https://github.com/.../v1.0.2/Code-Agent-1.0.2-arm64.dmg',
      size: 150 * 1024 * 1024,
    },
  },
};
```
