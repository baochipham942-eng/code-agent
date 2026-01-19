# Code Agent Cloud

云端 Agent 服务，部署在 Vercel Serverless 上。

## 功能

- **浏览器自动化**: 截图、抓取、表单填写、点击等
- **云端计算**: 在沙箱中执行 JavaScript 脚本
- **AI 技能**: Web 搜索、代码审查、文档生成、数据分析、翻译

## 部署

### 1. 安装依赖

```bash
cd cloud-agent
npm install
```

### 2. 配置环境变量

在 Vercel 控制台设置以下环境变量：

```
ANTHROPIC_API_KEY=your-anthropic-api-key
CLOUD_API_KEY=your-custom-api-key  # 用于验证来自本地 Agent 的请求
BROWSER_WS_ENDPOINT=wss://...      # 可选，远程浏览器服务地址
```

### 3. 部署到 Vercel

```bash
npm run deploy
```

## API 端点

### GET /api/health

健康检查，用于 warmup。

**响应:**
```json
{
  "status": "ok",
  "version": "0.1.0",
  "uptime": 12345
}
```

### POST /api/task

执行任务。

**请求头:**
```
Authorization: Bearer <CLOUD_API_KEY>
Content-Type: application/json
```

**请求体:**
```json
{
  "id": "task-123",
  "type": "browser | compute | skill",
  "payload": {
    // 根据任务类型不同
  }
}
```

## 任务类型

### Browser 任务

```json
{
  "type": "browser",
  "payload": {
    "action": "screenshot | scrape | fillForm | click | evaluate | pdf",
    "url": "https://example.com",
    "selector": ".content",  // 可选
    "fields": [...]          // fillForm 时需要
  }
}
```

### Compute 任务

```json
{
  "type": "compute",
  "payload": {
    "script": "return 1 + 1"
  }
}
```

### Skill 任务

```json
{
  "type": "skill",
  "payload": {
    "skillName": "webSearch | codeReview | generateDocs | analyzeData | translate",
    "params": {
      // 技能参数
    }
  }
}
```

## 费用说明

- **Vercel Hobby (免费)**: 每月 100GB 带宽，每次函数执行最长 10 秒
- **Vercel Pro ($20/月)**: 每次函数执行最长 60 秒，更多带宽

## 冷启动

Vercel Serverless 有冷启动延迟（约 500ms-2s）。本地 Agent 在执行任务前会先调用 `/api/health` 进行 warmup。

## 浏览器服务

由于 Vercel 环境限制，建议使用远程浏览器服务：

- [Browserless](https://browserless.io) - 推荐
- [Browserbase](https://browserbase.com)

设置 `BROWSER_WS_ENDPOINT` 环境变量即可连接。
