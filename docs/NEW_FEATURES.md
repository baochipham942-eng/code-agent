# Code Agent 新功能说明

## 概览

截至 2026-04-27，当前主线新增能力已经从早期“多模型 / 云端 / GUI Agent”推进到 agent runtime hardening、workbench、live preview、browser/computer、activity context 和 eval/model protocol 六条主线：

1. **Agent Runtime Capability Hardening** - run lifecycle、run-level abort、Tool/MCP 权限合同、durable runtime state、multiagent reliability、real-agent-run eval gate
2. **Chat-Native Workbench B+** - ChatInput 极简化、右侧 WorkbenchTabs、Settings 对话 tab、Sidebar User Menu、semantic tool UI
3. **Live Preview V2** - Vite-only devServerManager、click-to-source、TweakPanel、bridge protocol 0.3.0、Next.js 支持延期
4. **Browser / Computer Workbench** - in-app managed browser 的 session/profile/account/artifact/lease/proxy/TargetRef，Computer Surface background AX / CGEvent
5. **Activity Providers** - OpenChronicle、Tauri Native Desktop、audio、screenshot-analysis 统一成 ActivityContext
6. **评测与模型协议修复** - experiment progress SSE、fatal error 熔断、multi-turn adapter 修复、thinking-mode `reasoning_content` 协议修复

早期更新增加了以下核心功能：

1. **多模型 SDK 支持** - 支持 DeepSeek、Claude、OpenAI、Groq、本地模型
2. **云端 Agent** - Vercel Serverless 部署，支持浏览器自动化
3. **GUI Agent** - 基于 Claude Computer Use 的屏幕控制能力
4. **macOS 签名打包** - 完整的代码签名和公证配置

---

## 2026-04-27 当前新增能力

### Agent Runtime Capability Hardening

| 能力 | 说明 |
|------|------|
| Run lifecycle | `ConversationRuntime` 统一 terminal path，failure/cancel/interrupted 都进入 `RunFinalizer`；cancel 发 `agent_cancelled` |
| Run-level abort | cancel signal 贯穿 ToolExecutionEngine、ToolExecutor、ToolResolver 和长工具执行链 |
| TaskManager-owned chat run | desktop chat send/interrupt 优先走 TaskManager-owned path，减少 session/task 状态漂移 |
| Tool/MCP 权限合同 | `Bash/bash` 归一、`approvedToolCall` 传递、MCP dynamic direct execute、project skill `allowed-tools` trust gate |
| ToolSearch loadable 语义 | 搜索命中但不可调用的项返回 `loadable:false` 和 `notCallableReason`，lazy MCP server 按 query discover |
| Runtime durable state | todos、session tasks、context interventions、compression state、persistent system context、pending approvals kind hydrate 落 SQLite |
| Multiagent reliability | parallel inbox、dependsOn success gate、failed/blocked/cancelled aggregation、run-level cancel |
| Replay / Eval gate | structured replay join model/tool/event evidence；`real-agent-run` gate 绑定 `telemetryCompleteness` |

## 2026-04-26 当前新增能力

### Chat-Native Workbench B+

| 能力 | 说明 |
|------|------|
| ChatInput `+` 菜单 | 附件、slash command、Code/Plan/Ask 收进单一入口 |
| 模型 + effort 胶囊 | 模型和 reasoning effort 作为一组配置展示 |
| Settings “对话”tab | Routing / Browser 低频偏好迁出输入框 |
| Settings 分组导航 | 基础偏好、能力与连接、记忆与隐私、系统四组；搜索和外部跳转复用同一 tab registry |
| Settings 页面骨架 | `SettingsLayout` 统一 settings page / section / details，MCP 诊断信息进入折叠区 |
| Sidebar User Menu | Eval / Lab / Automation / Agent Flow / Desktop 全局入口从 TitleBar 移入用户菜单 |
| Semantic Tool UI | `_meta.shortDescription`、target icon、memory citation、session diff、URL chip 进入聊天渲染 |

### Live Preview V2

| 能力 | 说明 |
|------|------|
| DevServerLauncher | 探测并启动本地 Vite/CRA dev server，显示 logs，关闭 tab 自动 stop |
| Bridge protocol 0.3.0 | `SelectedElementInfo` 回传 `className` 与 `computedStyle` |
| TweakPanel | spacing / color / fontSize / radius / align 5 类 Tailwind 原子修改 |
| Vite-only MVP | Next.js App Router V2-C 已按 ADR-012 延期 |

### Browser / Computer Workbench

| 能力 | 说明 |
|------|------|
| Managed BrowserSession/Profile | sessionId、profileId、profileMode、workspaceScope、artifactDir、lease、proxy |
| AccountState | storageState import/export、cookie/localStorage/sessionStorage summary、expired cookie 分类 |
| TargetRef / Artifact | snapshotId、targetRef、stale recovery、download/upload artifact 摘要 |
| Acceptance suite | System Chrome/CDP、workflow、browser task benchmark、UI、app-host、background AX/CGEvent |
| Computer Surface | foreground fallback、background AX、background CGEvent 三类动作面分开表达 |

### Activity Providers

| 能力 | 说明 |
|------|------|
| ActivityProvider contract | 描述 provider kind、lifecycle、capture source、privacy boundary |
| ActivityContextProvider | 汇总 OpenChronicle、Tauri Native Desktop、audio、screenshot-analysis |
| Prompt formatter | 控制 legacy separate blocks 和 unified activity-context block |

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
