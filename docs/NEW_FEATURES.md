# Code Agent 新功能说明

## 概览

本次更新增加了以下核心功能：

1. **多模型 SDK 支持** - 支持 DeepSeek、Claude、OpenAI、Groq、本地模型
2. **云端 Agent** - Vercel Serverless 部署，支持浏览器自动化
3. **GUI Agent** - 基于 Claude Computer Use 的屏幕控制能力
4. **macOS 签名打包** - 完整的代码签名和公证配置

---

## 1. 多模型 SDK 支持

### 支持的模型提供商

| 提供商 | 模型 | 能力 |
|--------|------|------|
| DeepSeek | deepseek-chat, deepseek-coder, deepseek-reasoner | 代码生成、推理 |
| Claude | claude-4-sonnet, claude-3.5-sonnet, claude-3.5-haiku | 通用、代码、视觉、GUI |
| OpenAI | gpt-4o, gpt-4o-mini | 通用、代码、视觉 |
| Groq | llama-3.3-70b, llama-3.1-8b, mixtral-8x7b | 快速推理 |
| Local | qwen2.5-coder (Ollama) | 离线代码生成 |

### 按用途路由

系统会根据任务类型自动选择最佳模型：

```typescript
// 配置位置：Settings -> Models -> Routing
{
  code: { provider: 'deepseek', model: 'deepseek-coder' },
  vision: { provider: 'claude', model: 'claude-3-5-sonnet' },
  fast: { provider: 'groq', model: 'llama-3.3-70b-versatile' },
  gui: { provider: 'claude', model: 'claude-3-5-sonnet' },
}
```

### 配置 API Keys

```bash
# .env 文件
DEEPSEEK_API_KEY=your-key
ANTHROPIC_API_KEY=your-key
OPENAI_API_KEY=your-key
GROQ_API_KEY=your-key
```

---

## 2. 云端 Agent (Vercel)

### 功能

- **浏览器自动化**: 截图、抓取、表单填写、点击
- **云端计算**: 沙箱执行 JavaScript
- **AI 技能**: Web 搜索、代码审查、文档生成、翻译

### 部署

```bash
cd cloud-agent
npm install
npm run deploy
```

### 配置

```json
// Settings -> Cloud
{
  "cloud": {
    "enabled": true,
    "endpoint": "https://your-app.vercel.app",
    "apiKey": "your-cloud-api-key",
    "warmupOnInit": true
  }
}
```

### 冷启动处理

Vercel Serverless 有冷启动延迟（约 500ms-2s）。本地 Agent 会在执行云端任务前自动 warmup：

```typescript
// 自动 warmup
const cloudAgent = getCloudAgent();
await cloudAgent.warmup(); // 触发冷启动

// 执行任务
const result = await cloudAgent.screenshot('https://example.com');
```

### 费用说明

- **Hobby (免费)**: 每次执行最长 10 秒
- **Pro ($20/月)**: 每次执行最长 60 秒

---

## 3. GUI Agent (Computer Use)

### 功能

基于 Claude Computer Use API，实现屏幕控制能力：

- 截取屏幕截图
- 鼠标点击/移动
- 键盘输入
- 滚动屏幕

### 启用

```json
// Settings -> GUI Agent
{
  "guiAgent": {
    "enabled": true,
    "displayWidth": 1920,
    "displayHeight": 1080
  }
}
```

### 使用

```typescript
import { initGUIAgent, GUIAgent } from './main/agent/GUIAgent';

const guiAgent = initGUIAgent(
  { displayWidth: 1920, displayHeight: 1080 },
  { provider: 'claude', model: 'claude-3-5-sonnet-20241022', computerUse: true },
  modelRouter
);

// 执行任务
const result = await guiAgent.run(
  '打开 Chrome 浏览器，访问 github.com',
  (action, result) => {
    console.log('Action:', action, 'Result:', result);
  }
);
```

### macOS 权限

GUI Agent 需要以下系统权限：

1. **屏幕录制** - System Settings → Privacy & Security → Screen Recording
2. **辅助功能** - System Settings → Privacy & Security → Accessibility
3. **自动化** - System Settings → Privacy & Security → Automation

---

## 4. macOS 签名打包

### 开发构建（未签名）

```bash
npm run dist:mac
```

### 签名构建

需要 Apple Developer 账号。

```bash
# 设置环境变量
export CSC_LINK=/path/to/certificate.p12
export CSC_KEY_PASSWORD=your-password
export APPLE_ID=your-apple-id
export APPLE_APP_SPECIFIC_PASSWORD=your-app-password
export APPLE_TEAM_ID=your-team-id

# 签名构建
npm run dist:mac:signed
```

### 权限声明

`build/entitlements.mac.plist` 已配置以下权限：

- JIT 执行
- 网络访问
- 文件访问
- 屏幕录制
- Apple Events 自动化

---

## 文件结构

```
src/main/
├── model/
│   └── ModelRouter.ts        # 多模型路由（已更新）
├── cloud/
│   └── CloudAgentClient.ts   # 云端通信客户端（新增）
├── agent/
│   └── GUIAgent.ts           # GUI Agent（新增）
└── services/
    └── ConfigService.ts      # 配置服务（已更新）

cloud-agent/                   # Vercel 云端服务（新增）
├── api/
│   ├── health.ts             # 健康检查
│   └── task.ts               # 任务执行
├── lib/
│   ├── browser.ts            # 浏览器自动化
│   ├── compute.ts            # 云端计算
│   └── skills.ts             # AI 技能
└── package.json

build/
├── entitlements.mac.plist           # macOS 权限（新增）
└── entitlements.mac.inherit.plist   # 子进程权限（新增）

scripts/
└── notarize.js               # 公证脚本（新增）
```

---

## 后续计划

1. **完善 GUI Agent 操作实现** - 集成 robotjs 或原生模块
2. **添加 Google AI UI 支持** - 等待 Gemini 2.0 API
3. **API Key 加密存储** - 实现安全存储
4. **WebSocket 实时通信** - 云端任务进度推送
