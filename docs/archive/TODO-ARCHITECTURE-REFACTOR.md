# Code Agent 架构梳理与改造方案

> 版本：v1.0
> 日期：2025-01-19
> 状态：待执行

---

## 第一部分：现状分析

### 1. 项目概览

**技术栈**：Electron 33 + React 18 + TypeScript + Zustand + Tailwind CSS

**架构模式**：纯 Native 桌面应用，云端仅提供辅助 API

```
┌─────────────────────────────────────────────────────────────┐
│             Native (Electron Desktop App)                    │
│  ┌──────────────────────────────────────────────────────┐   │
│  │  src/renderer/ (React)        src/main/ (Node.js)    │   │
│  │  - 28 个 UI 组件              - 35 个工具            │   │
│  │  - 3 个 Zustand Store        - AgentLoop            │   │
│  │  - 打包进 Electron            - 本地 SQLite          │   │
│  └──────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼ HTTP (辅助 API)
┌─────────────────────────────────────────────────────────────┐
│             vercel-api/ (11 个 Serverless Functions)        │
│  - /api/prompts (Prompt 热更新) - /api/update (版本检查)    │
│  - /api/agent (简化版云端 Agent) - /api/sync (数据同步)     │
└─────────────────────────────────────────────────────────────┘
```

**核心问题**：修改任何核心功能都需要重新发布客户端

---

### 2. 编码规范问题

#### 2.1 已有优点
- [x] TypeScript 严格模式启用
- [x] 类型定义集中在 `src/shared/types.ts`
- [x] IPC 通道类型安全

#### 2.2 待解决问题

| 问题 | 位置 | 严重程度 |
|------|------|---------|
| `as any` 类型断言滥用 | `preload/index.ts:11`, `ipc.ts:57` | 中 |
| 魔法数字硬编码 | `main/index.ts:127` 等多处 | 低 |
| `console.log` 散落 | 生产代码中大量使用 | 低 |
| 函数/文件过长 | `main/index.ts` 超 2000 行 | 高 |
| 类型定义重复 | `ToolContext` 在多处略有不同 | 中 |

---

### 3. 目录结构问题

#### 3.1 当前结构

```
src/
├── main/                 # 主进程（过于臃肿）
│   ├── agent/           # Agent 核心
│   ├── cloud/           # 云端集成
│   ├── generation/      # 代际管理
│   ├── memory/          # 记忆系统
│   ├── mcp/             # MCP 协议
│   ├── model/           # 模型路由
│   ├── orchestrator/    # 统一调度（与 cloud 重叠）
│   ├── planning/        # 规划系统
│   ├── services/        # 16 个服务（混杂）
│   ├── tools/           # 按代际分（gen1-gen8）
│   └── index.ts         # 2000+ 行入口文件
├── renderer/            # React 前端
├── preload/             # 预加载脚本
└── shared/              # 共享类型
```

#### 3.2 问题清单

| 问题 | 说明 |
|------|------|
| main/index.ts 过大 | 2000+ 行，包含所有 IPC 处理 |
| 工具按代际分类 | 同类工具分散，不便维护 |
| 服务目录混杂 | 核心服务和业务服务混在一起 |
| cloud 和 orchestrator 重叠 | 职责边界模糊 |

---

### 4. 命名不一致

| 类型 | 现状 | 问题 |
|------|------|------|
| 文件名 | `AgentOrchestrator.ts` vs `metadata.ts` | PascalCase/camelCase 混用 |
| 工具名 | `read_file` vs `webFetch` | snake_case/camelCase 混用 |
| 目录名 | `vercel-api` vs `ToolRegistry` | kebab-case/PascalCase 混用 |
| 服务获取 | `getAuthService()` vs `new ConfigService()` | 单例模式不统一 |

---

### 5. 接口设计问题

| 问题 | 说明 |
|------|------|
| IPC 通道过多 | 70+ 个独立通道，维护困难 |
| 缺少 API 版本号 | `/api/agent` 无版本，升级难兼容 |
| 类型定义集中 | `types.ts` 684 行，应按领域拆分 |

---

### 6. 代际能力实现情况

| 代际 | 定义工具 | 实现状态 | 说明 |
|------|---------|---------|------|
| Gen1 | 4 | ✅ 完整 | bash, read_file, write_file, edit_file |
| Gen2 | 7 | ✅ 完整 | + glob, grep, list_directory |
| Gen3 | 12 | ✅ 完整 | + task, todo, ask_user, plan_* |
| Gen4 | 20 | ✅ 完整 | + skill, web_*, mcp_*, read_pdf |
| Gen5 | 24 | ✅ 完整 | + memory_*, code_index, auto_learn |
| Gen6 | 28 | ⚠️ 部分 | computer_use 依赖 Playwright/Claude |
| Gen7 | 31 | ⚠️ 部分 | spawn_agent 非真正并行 |
| Gen8 | 35 | ⚠️ 框架 | 自我进化能力有限 |

---

### 7. 安全问题

| 风险 | 位置 | 严重程度 |
|------|------|---------|
| **.env 文件打包** | `package.json extraResources` | **高** |
| **tool_create 无沙箱** | `gen8/toolCreate.ts` | **高** |
| 开发模式自动批准 | `devModeAutoApprove` 设置 | 高 |
| 加密密钥派生不安全 | `generateEncryptionKey()` 用主机名 | 中 |

---

### 8. 热更新现状

| 内容 | 可热更新？ | 说明 |
|------|----------|------|
| System Prompt | ✅ 是 | `/api/prompts` 已实现 |
| Skill 定义 | ❌ 否 | 硬编码在客户端 |
| 工具描述 | ❌ 否 | 硬编码在客户端 |
| Feature Flags | ❌ 否 | 无此机制 |
| UI 文案 | ❌ 否 | 打包在客户端 |
| Agent 规则 | ❌ 否 | 硬编码在 prompts/rules/ |

**现状：仅 Prompt 可热更新，其余均需发版**

---

## 第二部分：改造方案

### 改造目标

1. **减少发版频率**：60-70% 的改动可通过云端热更新
2. **提升代码质量**：解决编码规范、目录结构、接口设计问题
3. **增强安全性**：修复 P0 安全问题
4. **提升扩展性**：为插件系统打基础

---

## Phase 1：安全加固

**优先级**：P0
**预估时间**：1 周

### 1.1 移除 .env 打包

- [ ] 修改 `package.json`，移除 `extraResources` 中的 `.env`
- [ ] 首次启动引导用户在设置中配置 API Key
- [ ] 更新打包文档，说明环境变量配置方式
- [ ] 测试：确认打包产物不含 .env

### 1.2 Gen8 tool_create 沙箱

- [ ] 引入 `isolated-vm` 或 `vm2` 依赖
- [ ] 创建 `src/main/tools/evolution/sandbox.ts`
- [ ] 动态工具执行限制：
  - 禁止 `require`, `import`
  - 禁止 `process`, `fs`, `child_process`
  - 执行超时 5 秒
- [ ] 工具创建增加用户确认弹窗
- [ ] 测试：恶意代码无法逃逸

### 1.3 加密存储增强

- [ ] `SecureStorage` 改用 Electron `safeStorage.encryptString()`
- [ ] 移除 `generateEncryptionKey()` 中基于 hostname 的派生
- [ ] Session Token 强制存储到系统 Keychain
- [ ] 测试：重装应用后 Keychain 数据仍在

### 1.4 开发模式安全

- [ ] `devModeAutoApprove` 增加二次确认
- [ ] 生产包中禁用此选项
- [ ] 日志中不输出敏感信息（API Key 等）

---

## Phase 2：热更新系统

**优先级**：P0
**预估时间**：2 周

### 2.1 云端配置中心

创建统一配置端点 `/api/v1/config`：

```typescript
// vercel-api/api/v1/config.ts
interface CloudConfig {
  version: string;
  prompts: Record<GenerationId, string>;
  skills: SkillDefinition[];
  toolMeta: Record<string, ToolMetadata>;
  featureFlags: FeatureFlags;
  uiStrings: { zh: Record<string, string>; en: Record<string, string> };
  rules: Record<string, string>;
}
```

- [ ] 创建 `vercel-api/api/v1/config.ts`
- [ ] 迁移 `/api/prompts` 数据到新接口
- [ ] 添加 ETag 缓存控制
- [ ] 添加版本号字段
- [ ] 废弃旧 `/api/prompts`（保留兼容）

### 2.2 客户端配置服务

```typescript
// src/main/services/cloud/CloudConfigService.ts
class CloudConfigService {
  private cache: CloudConfig | null;
  private cacheExpiry: number;

  async initialize(): Promise<void>;
  async refresh(): Promise<void>;
  getPrompt(genId: GenerationId): string;
  getSkills(): SkillDefinition[];
  getToolMeta(name: string): ToolMetadata;
  getFeatureFlag(key: string): boolean;
  getUIString(key: string, lang: Language): string;
}
```

- [ ] 创建 `CloudConfigService`
- [ ] 启动时异步拉取配置
- [ ] 本地缓存 + 1 小时过期
- [ ] 离线时降级到内置配置
- [ ] 设置页面添加「刷新配置」按钮

### 2.3 Skills 动态化

- [ ] 迁移 `gen4/skill.ts` 中的 SKILLS 定义到云端
- [ ] `SkillExecutor` 改为从 `CloudConfigService` 读取
- [ ] 支持用户自定义 Skill（存 Supabase）
- [ ] Skill 版本管理

### 2.4 工具元数据动态化

- [ ] 工具 `description` 和 `inputSchema` 从云端获取
- [ ] 本地保留 `execute` 执行逻辑
- [ ] `ToolRegistry` 合并云端元数据

### 2.5 Feature Flags

```typescript
// src/main/services/cloud/FeatureFlagService.ts
interface FeatureFlags {
  enableGen8: boolean;
  enableCloudAgent: boolean;
  enableMemory: boolean;
  enableComputerUse: boolean;
  maxIterations: number;
  maxMessageLength: number;
}
```

- [ ] 创建 `FeatureFlagService`
- [ ] 从 `CloudConfigService` 读取 Flags
- [ ] 关键功能入口添加 Flag 检查
- [ ] 支持用户级 Flag 覆盖（A/B 测试预留）

### 2.6 UI 文案动态化

- [ ] 云端配置添加 `uiStrings` 字段
- [ ] `useI18n` hook 优先读取云端文案
- [ ] 降级到本地 `i18n/zh.ts`, `i18n/en.ts`

---

## Phase 3：主进程重构

**优先级**：P1
**预估时间**：2 周

### 3.1 入口文件拆分

将 `src/main/index.ts`（2000+ 行）拆分为：

```
src/main/
├── index.ts              # 入口（< 100 行）
├── app/
│   ├── bootstrap.ts      # 启动流程
│   ├── window.ts         # 窗口管理
│   └── lifecycle.ts      # 生命周期
└── ipc/
    ├── index.ts          # IPC 注册入口
    ├── agent.ipc.ts      # Agent 相关
    ├── session.ipc.ts    # Session 相关
    ├── generation.ipc.ts # Generation 相关
    ├── auth.ipc.ts       # Auth 相关
    ├── sync.ipc.ts       # Sync 相关
    ├── cloud.ipc.ts      # Cloud 相关
    ├── workspace.ipc.ts  # Workspace 相关
    ├── settings.ipc.ts   # Settings 相关
    └── update.ipc.ts     # Update 相关
```

- [ ] 创建 `src/main/app/` 目录
- [ ] 拆分 `bootstrap.ts`（服务初始化）
- [ ] 拆分 `window.ts`（窗口创建）
- [ ] 拆分 `lifecycle.ts`（app 事件）
- [ ] 创建 `src/main/ipc/` 目录
- [ ] 按领域拆分 IPC handlers（10 个文件）
- [ ] `index.ts` 精简到 < 100 行
- [ ] 验证：功能不变，启动正常

### 3.2 工具目录重组

从按代际分类改为按功能分类：

```
src/main/tools/
├── index.ts              # 导出
├── registry.ts           # 工具注册表
├── executor.ts           # 工具执行器
├── types.ts              # 工具类型
├── file/                 # 文件操作
│   ├── read.ts
│   ├── write.ts
│   ├── edit.ts
│   ├── glob.ts
│   └── listDirectory.ts
├── shell/                # Shell 操作
│   ├── bash.ts
│   └── grep.ts
├── planning/             # 规划工具
│   ├── task.ts
│   ├── todoWrite.ts
│   ├── askUserQuestion.ts
│   ├── planRead.ts
│   ├── planUpdate.ts
│   ├── enterPlanMode.ts
│   ├── exitPlanMode.ts
│   └── findingsWrite.ts
├── network/              # 网络工具
│   ├── webFetch.ts
│   ├── webSearch.ts
│   ├── readPdf.ts
│   └── skill.ts
├── mcp/                  # MCP 工具
│   ├── mcp.ts
│   ├── listTools.ts
│   ├── listResources.ts
│   ├── readResource.ts
│   └── getStatus.ts
├── memory/               # 记忆工具
│   ├── store.ts
│   ├── search.ts
│   ├── codeIndex.ts
│   └── autoLearn.ts
├── vision/               # 视觉工具
│   ├── screenshot.ts
│   ├── computerUse.ts
│   ├── browserNavigate.ts
│   └── browserAction.ts
├── multiagent/           # 多代理工具
│   ├── spawnAgent.ts
│   ├── agentMessage.ts
│   └── workflowOrchestrate.ts
└── evolution/            # 自我进化工具
    ├── strategyOptimize.ts
    ├── toolCreate.ts
    ├── selfEvaluate.ts
    ├── learnPattern.ts
    └── sandbox.ts        # Phase 1 新增
```

- [ ] 创建新目录结构
- [ ] 迁移工具文件（35 个）
- [ ] 更新 `ToolRegistry` 导入
- [ ] 代际映射改为配置：`generationTools.ts`
- [ ] 删除空的 `gen1-gen8` 目录
- [ ] 验证：所有工具正常执行

### 3.3 服务目录整理

```
src/main/services/
├── index.ts              # 统一导出
├── core/                 # 核心服务（启动必需）
│   ├── ConfigService.ts
│   ├── DatabaseService.ts
│   └── SecureStorage.ts
├── auth/                 # 认证服务
│   ├── AuthService.ts
│   └── TokenManager.ts
├── sync/                 # 同步服务
│   ├── SyncService.ts
│   └── CloudStorageService.ts
├── cloud/                # 云端服务
│   ├── CloudConfigService.ts   # Phase 2 新增
│   ├── FeatureFlagService.ts   # Phase 2 新增
│   ├── CloudTaskService.ts
│   ├── UpdateService.ts
│   └── PromptService.ts        # 待废弃
└── infra/                # 基础设施
    ├── LangfuseService.ts
    ├── NotificationService.ts
    ├── BrowserService.ts
    └── ToolCache.ts
```

- [ ] 创建服务子目录
- [ ] 迁移服务文件（16 个）
- [ ] 统一单例模式：`class XxxService` + `getXxxService()`
- [ ] 更新所有导入路径
- [ ] 验证：服务正常工作

---

## Phase 4：接口规范化

**优先级**：P1
**预估时间**：1 周

### 4.1 IPC 通道聚合

从 70+ 个通道聚合为领域模式：

```typescript
// 现状
'agent:send-message'
'agent:cancel'
'agent:event'
'session:list'
'session:create'
...

// 改造后（保留旧通道兼容）
'agent' -> { action: 'send' | 'cancel', ...payload }
'session' -> { action: 'list' | 'create' | 'load' | 'delete', ...payload }
'generation' -> { action: 'list' | 'switch' | 'getPrompt', ...payload }
```

- [ ] 设计新 IPC 协议格式
- [ ] 创建 `src/shared/ipc/protocol.ts`
- [ ] 新增聚合通道处理器
- [ ] 旧通道标记 `@deprecated`
- [ ] 渲染进程逐步迁移到新协议
- [ ] preload 脚本适配

### 4.2 云端 API 版本化

```
/api/prompts     -> /api/v1/config (合并)
/api/agent       -> /api/v1/agent
/api/sync        -> /api/v1/sync
/api/auth        -> /api/v1/auth
/api/update      -> /api/v1/update
/api/tools       -> /api/v1/tools
```

- [ ] 创建 `vercel-api/api/v1/` 目录
- [ ] 迁移现有端点到 v1
- [ ] 旧端点保留并 redirect
- [ ] 客户端适配新端点
- [ ] 更新 API 文档

### 4.3 类型定义拆分

将 `src/shared/types.ts`（684 行）拆分：

```
src/shared/types/
├── index.ts          # 重导出（保持兼容）
├── generation.ts     # GenerationId, Generation, GenerationDiff
├── model.ts          # ModelProvider, ModelConfig, ModelInfo
├── message.ts        # Message, MessageRole, MessageAttachment
├── tool.ts           # ToolDefinition, ToolContext, ToolResult
├── permission.ts     # PermissionRequest, PermissionResponse
├── session.ts        # Session, SessionExport
├── planning.ts       # TaskPlan, TodoItem, Finding, ErrorRecord
├── agent.ts          # AgentConfig, AgentState, AgentEvent
├── auth.ts           # AuthUser, AuthStatus
├── sync.ts           # SyncStatus, SyncConflict
├── settings.ts       # AppSettings
├── cloud.ts          # 已有，保持
└── ui.ts             # DisclosureLevel, Language
```

- [ ] 创建 `src/shared/types/` 目录
- [ ] 按领域拆分类型（14 个文件）
- [ ] `types.ts` 改为重导出
- [ ] 更新所有导入（可用 `types.ts` 兼容）
- [ ] 验证：类型检查通过

---

## Phase 5：编码规范统一

**优先级**：P2
**预估时间**：1 周

### 5.1 命名规范统一

| 类型 | 规范 | 示例 |
|------|------|------|
| 文件名 | camelCase | `agentOrchestrator.ts` |
| 目录名 | kebab-case | `cloud-config/` |
| 类名 | PascalCase | `AgentOrchestrator` |
| 工具 API 名 | snake_case | `read_file` |
| 内部函数 | camelCase | `executeReadFile` |
| 常量 | UPPER_SNAKE_CASE | `MAX_ITERATIONS` |

- [ ] 编写批量重命名脚本
- [ ] 重命名文件（约 50 个）
- [ ] 更新所有导入路径
- [ ] 配置 ESLint 命名规则
- [ ] 验证：lint 通过

### 5.2 消除 as any

- [ ] `preload/index.ts:11` 添加泛型
- [ ] `ipc.ts:57` 添加明确类型
- [ ] 全局搜索 `as any`，逐个修复
- [ ] 配置 `@typescript-eslint/no-explicit-any: error`
- [ ] 验证：无 any 警告

### 5.3 日志规范化

```typescript
// src/main/services/infra/Logger.ts
class Logger {
  debug(message: string, context?: object): void;
  info(message: string, context?: object): void;
  warn(message: string, context?: object): void;
  error(message: string, error?: Error, context?: object): void;
}
```

- [ ] 创建 `Logger` 服务
- [ ] 日志分级：debug, info, warn, error
- [ ] 生产环境过滤 debug
- [ ] 替换所有 `console.log`（约 200 处）
- [ ] 敏感信息脱敏

### 5.4 常量提取

- [ ] 创建 `src/shared/constants.ts`
- [ ] 提取魔法数字：
  - `MAX_ITERATIONS = 30`
  - `CACHE_TTL = 3600000`
  - `MAX_FILE_SIZE = 10 * 1024 * 1024`
  - ...
- [ ] 部分常量迁移到云端 FeatureFlags

---

## Phase 6：扩展性增强

**优先级**：P2
**预估时间**：2 周

### 6.1 工具注册装饰器

简化工具定义样板代码：

```typescript
// 现状：每个工具 50+ 行
export const readFileTool: Tool = {
  name: 'read_file',
  description: '...',
  generations: ['gen1', 'gen2', ...],
  requiresPermission: true,
  permissionLevel: 'read',
  inputSchema: {...},
  async execute(params, context) {...}
};

// 改造后：装饰器
@Tool('read_file', {
  generations: 'gen1+',
  permission: 'read',
})
@Param('file_path', { type: 'string', required: true })
@Param('encoding', { type: 'string', default: 'utf-8' })
class ReadFileTool {
  async execute(params: ReadFileParams, ctx: ToolContext): Promise<ToolResult> {
    // 只写核心逻辑
  }
}
```

- [ ] 设计装饰器 API
- [ ] 实现 `@Tool` 装饰器
- [ ] 实现 `@Param` 装饰器
- [ ] 工具自动注册机制
- [ ] 迁移 1-2 个工具验证
- [ ] 文档：装饰器使用说明

### 6.2 插件系统雏形

```typescript
// src/main/plugin/types.ts
interface Plugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  tools?: ToolDefinition[];
  skills?: SkillDefinition[];
  mcpServers?: MCPServerConfig[];
  hooks?: PluginHooks;
}

interface PluginHooks {
  onLoad?: () => Promise<void>;
  onUnload?: () => Promise<void>;
  beforeToolExecute?: (tool: string, params: any) => Promise<any>;
  afterToolExecute?: (tool: string, result: any) => Promise<any>;
}
```

- [ ] 设计 Plugin 接口
- [ ] 创建 `src/main/plugin/` 目录
- [ ] 实现 `PluginLoader`
- [ ] 实现 `PluginRegistry`
- [ ] 支持本地插件目录 `~/.code-agent/plugins/`
- [ ] 预留远程插件仓库接口

### 6.3 MCP 配置热更新

- [ ] MCP Server 配置迁移到云端 `/api/v1/config`
- [ ] 支持动态添加/移除 MCP Server
- [ ] MCP 连接状态实时 UI 显示
- [ ] 远程 MCP 服务器发现机制

---

## Phase 7：文档和测试

**优先级**：P2
**预估时间**：1 周

### 7.1 架构文档更新

- [ ] 更新 `docs/architecture/overview.md`
- [ ] 更新 `docs/architecture/tool-system.md`
- [ ] 新增 `docs/architecture/hot-update.md`
- [ ] 新增 `docs/architecture/plugin-system.md`
- [ ] 更新 `CLAUDE.md` 目录结构部分

### 7.2 API 文档

- [ ] 生成 TypeDoc 文档
- [ ] 云端 API OpenAPI 文档
- [ ] IPC 通道文档

### 7.3 测试补充

- [ ] 核心工具单元测试（file/, shell/）
- [ ] CloudConfigService 测试
- [ ] FeatureFlagService 测试
- [ ] IPC 集成测试
- [ ] 热更新 E2E 测试

---

## 第三部分：执行计划

### 里程碑

| Phase | 内容 | 时间 | 优先级 | 依赖 |
|-------|------|------|--------|------|
| Phase 1 | 安全加固 | 1 周 | P0 | 无 |
| Phase 2 | 热更新系统 | 2 周 | P0 | 无 |
| Phase 3 | 主进程重构 | 2 周 | P1 | Phase 2 |
| Phase 4 | 接口规范化 | 1 周 | P1 | Phase 3 |
| Phase 5 | 编码规范统一 | 1 周 | P2 | Phase 4 |
| Phase 6 | 扩展性增强 | 2 周 | P2 | Phase 5 |
| Phase 7 | 文档和测试 | 1 周 | P2 | Phase 6 |

**总计：约 10 周**

### 并行建议

- Phase 1 和 Phase 2 可并行（不同人负责）
- Phase 3/4/5 需串行（有依赖）
- Phase 6/7 可与前面并行

### 发版节奏

| 版本 | 包含 Phase | 说明 |
|------|-----------|------|
| v0.8.0 | Phase 1 | 安全修复版 |
| v0.9.0 | Phase 2 | 热更新版 |
| v0.10.0 | Phase 3+4 | 架构重构版 |
| v1.0.0 | Phase 5+6+7 | 正式版 |

---

## 第四部分：热更新能力矩阵

### 改造前

| 改动类型 | 需发版？ |
|---------|---------|
| System Prompt | ❌ 热更新 |
| 其他所有 | ✅ 需发版 |

### 改造后

| 改动类型 | 需发版？ | Phase |
|---------|---------|-------|
| System Prompt | ❌ 热更新 | 已有 |
| Skill 定义 | ❌ 热更新 | Phase 2 |
| 工具描述/参数 | ❌ 热更新 | Phase 2 |
| Feature Flags | ❌ 热更新 | Phase 2 |
| UI 文案 | ❌ 热更新 | Phase 2 |
| Agent 规则 | ❌ 热更新 | Phase 2 |
| 新增工具 | ✅ 需发版 | - |
| UI 组件 | ✅ 需发版 | - |
| 核心逻辑 | ✅ 需发版 | - |

**改造后约 60-70% 的日常改动可热更新**

---

## 第五部分：风险和缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 重构引入 Bug | 高 | 分阶段上线，每 Phase 独立测试 |
| 云端配置拉取失败 | 中 | 本地缓存 + 内置降级配置 |
| 向后兼容性破坏 | 中 | 保留旧接口 deprecated |
| 开发效率下降 | 低 | 先完成 P0，P1/P2 可渐进 |

---

## 第六部分：验收标准

### Phase 1 验收
- [ ] 打包产物不含 .env
- [ ] tool_create 执行恶意代码被拦截
- [ ] API Key 使用 safeStorage 加密

### Phase 2 验收
- [ ] 修改云端 Skill 定义后客户端自动生效
- [ ] Feature Flag 关闭后对应功能不可用
- [ ] 离线时使用本地缓存配置

### Phase 3 验收
- [ ] `main/index.ts` < 100 行
- [ ] 所有工具按功能目录组织
- [ ] `npm run typecheck` 通过

### Phase 4 验收
- [ ] IPC 通道数 < 20 个
- [ ] 所有 API 带版本号
- [ ] 类型定义按领域拆分

### Phase 5 验收
- [ ] ESLint 零警告
- [ ] 无 `console.log`
- [ ] 无 `as any`

### Phase 6 验收
- [ ] 至少 3 个工具使用装饰器
- [ ] 插件加载器可用
- [ ] MCP 配置可云端更新

### Phase 7 验收
- [ ] 文档与代码同步
- [ ] 核心模块测试覆盖 > 80%

---

## 附录 A：新增文件清单

```
vercel-api/api/v1/config.ts
src/main/app/bootstrap.ts
src/main/app/window.ts
src/main/app/lifecycle.ts
src/main/ipc/*.ipc.ts (10 个)
src/main/services/cloud/CloudConfigService.ts
src/main/services/cloud/FeatureFlagService.ts
src/main/services/infra/Logger.ts
src/main/tools/evolution/sandbox.ts
src/main/plugin/types.ts
src/main/plugin/PluginLoader.ts
src/main/plugin/PluginRegistry.ts
src/shared/types/*.ts (14 个)
src/shared/constants.ts
src/shared/ipc/protocol.ts
docs/architecture/hot-update.md
docs/architecture/plugin-system.md
```

## 附录 B：删除/废弃文件清单

```
# 删除
src/main/tools/gen1/ (目录)
src/main/tools/gen2/ (目录)
... gen3-gen8 同上

# 废弃（保留兼容）
vercel-api/api/prompts.ts -> 重定向到 /api/v1/config
src/main/services/PromptService.ts -> 改用 CloudConfigService
```

## 附录 C：参考资料

- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)
- [isolated-vm](https://github.com/laverdet/isolated-vm)
- [TypeScript 装饰器](https://www.typescriptlang.org/docs/handbook/decorators.html)
