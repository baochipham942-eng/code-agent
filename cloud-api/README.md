# Code Agent Cloud API

版本检查与更新服务 API。

## 部署到 Vercel

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
