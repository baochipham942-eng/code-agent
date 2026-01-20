# 热更新机制

> 云端配置热更新架构

## 概述

Code Agent 采用前后端分离的配置架构，支持多种配置的热更新：
- System Prompt
- Skill 定义
- Tool 元数据
- Feature Flags
- MCP Server 配置
- UI 字符串

**核心优势**：修改配置只需部署云端，无需重新打包客户端。

---

## 架构图

```
┌─────────────────┐     HTTP GET      ┌─────────────────┐
│   Code Agent    │ ─────────────────▶│   Vercel API    │
│    (Client)     │                   │  /api/v1/config │
│                 │ ◀───────────────── │                 │
│  CloudConfig    │     JSON + ETag   │   云端配置       │
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
GET https://code-agent-beta.vercel.app/api/v1/config
```

**响应**:
```json
{
  "version": "1.0.5",
  "prompts": {
    "gen1": "You are a code assistant...",
    "gen4": "You are an advanced AI agent..."
  },
  "skills": [...],
  "featureFlags": {
    "enableGen8": false,
    "maxIterations": 50
  }
}
```

### 仅获取版本

```
GET https://code-agent-beta.vercel.app/api/v1/config?version=true
```

**响应**:
```json
{
  "version": "1.0.5"
}
```

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
└── config.ts              # 云端 API 端点
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
2. **静默降级**: 网络失败不显示错误，使用内置配置
3. **版本检查**: 客户端记录配置版本，方便调试
4. **日志记录**: 配置加载状态会记录到日志
