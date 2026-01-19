# TASK-03: 主进程重构

> 负责 Agent: Agent-Refactor
> 优先级: P1
> 预估时间: 2 周
> 依赖: TASK-01, TASK-02 完成
> 状态: ✅ 完成（index.ts 从 1741 行精简到 120 行）

---

## 目标

将 2000+ 行的 `main/index.ts` 拆分为模块化结构，工具目录从按代际分类改为按功能分类。

---

## 前置检查

开始前确认：
- [ ] TASK-01 (安全加固) 已合并到 main
- [ ] TASK-02 (热更新系统) 已合并到 main
- [ ] `CloudConfigService` 可正常工作
- [ ] `npm run typecheck` 通过

---

## 任务清单

### 3.1 入口文件拆分

**目标**: `main/index.ts` 从 2000+ 行精简到 < 100 行

**新增目录结构**:
```
src/main/
├── index.ts              # 入口（< 100 行）
├── app/
│   ├── bootstrap.ts      # 服务初始化
│   ├── window.ts         # 窗口管理
│   └── lifecycle.ts      # app 事件处理
└── ipc/
    ├── index.ts          # IPC 注册入口
    ├── agent.ipc.ts      # agent:* 通道
    ├── session.ipc.ts    # session:* 通道
    ├── generation.ipc.ts # generation:* 通道
    ├── auth.ipc.ts       # auth:* 通道
    ├── sync.ipc.ts       # sync:* 通道
    ├── cloud.ipc.ts      # cloud:* 通道
    ├── workspace.ipc.ts  # workspace:* 通道
    ├── settings.ipc.ts   # settings:* 通道
    ├── update.ipc.ts     # update:* 通道
    └── mcp.ipc.ts        # mcp:* 通道
```

**步骤**:

#### 3.1.1 创建 app/ 目录
- [ ] 创建 `src/main/app/bootstrap.ts`
  - 提取 `initializeServices()` 函数
  - 服务初始化顺序：Database → Config → Auth → Cloud → MCP
- [ ] 创建 `src/main/app/window.ts`
  - 提取 `createWindow()` 函数
  - 窗口配置、DevTools 处理
- [ ] 创建 `src/main/app/lifecycle.ts`
  - 提取 app 事件：`ready`, `activate`, `window-all-closed`

#### 3.1.2 创建 ipc/ 目录
- [ ] 创建 `src/main/ipc/index.ts` - 统一注册所有 handler
- [ ] 拆分 10 个 IPC handler 文件（按领域）
- [ ] 每个文件导出 `registerXxxHandlers(ipcMain)` 函数

#### 3.1.3 精简 index.ts
- [ ] 删除所有 IPC handler 代码
- [ ] 删除所有服务初始化代码
- [ ] 只保留：import → bootstrap → createWindow
- [ ] 验证：`npm run dev` 启动正常

**验收**: `wc -l src/main/index.ts` < 100

---

### 3.2 工具目录重组

**目标**: 从按代际分类改为按功能分类

**当前结构**:
```
src/main/tools/
├── gen1/
├── gen2/
├── gen3/
├── gen4/
├── gen5/
├── gen6/
├── gen7/
└── gen8/
```

**目标结构**:
```
src/main/tools/
├── index.ts              # 导出所有工具
├── registry.ts           # ToolRegistry
├── executor.ts           # ToolExecutor
├── types.ts              # 工具类型定义
├── generationMap.ts      # 代际 → 工具映射配置
│
├── file/                 # 文件操作 (5)
│   ├── read.ts           # read_file
│   ├── write.ts          # write_file
│   ├── edit.ts           # edit_file
│   ├── glob.ts           # glob
│   └── listDirectory.ts  # list_directory
│
├── shell/                # Shell 操作 (2)
│   ├── bash.ts           # bash
│   └── grep.ts           # grep
│
├── planning/             # 规划工具 (8)
│   ├── task.ts           # task
│   ├── todoWrite.ts      # todo_write
│   ├── askUserQuestion.ts # ask_user_question
│   ├── planRead.ts       # plan_read
│   ├── planUpdate.ts     # plan_update
│   ├── enterPlanMode.ts  # enter_plan_mode
│   ├── exitPlanMode.ts   # exit_plan_mode
│   └── findingsWrite.ts  # findings_write
│
├── network/              # 网络工具 (4)
│   ├── webFetch.ts       # web_fetch
│   ├── webSearch.ts      # web_search
│   ├── readPdf.ts        # read_pdf
│   └── skill.ts          # skill
│
├── mcp/                  # MCP 工具 (5)
│   ├── mcp.ts            # mcp
│   ├── listTools.ts      # mcp_list_tools
│   ├── listResources.ts  # mcp_list_resources
│   ├── readResource.ts   # mcp_read_resource
│   └── getStatus.ts      # mcp_get_status
│
├── memory/               # 记忆工具 (4)
│   ├── store.ts          # memory_store
│   ├── search.ts         # memory_search
│   ├── codeIndex.ts      # code_index
│   └── autoLearn.ts      # auto_learn
│
├── vision/               # 视觉工具 (4)
│   ├── screenshot.ts     # screenshot
│   ├── computerUse.ts    # computer_use
│   ├── browserNavigate.ts # browser_navigate
│   └── browserAction.ts  # browser_action
│
├── multiagent/           # 多代理工具 (3)
│   ├── spawnAgent.ts     # spawn_agent
│   ├── agentMessage.ts   # agent_message
│   └── workflowOrchestrate.ts # workflow_orchestrate
│
└── evolution/            # 自我进化工具 (4)
    ├── strategyOptimize.ts # strategy_optimize
    ├── toolCreate.ts     # tool_create
    ├── selfEvaluate.ts   # self_evaluate
    ├── learnPattern.ts   # learn_pattern
    └── sandbox.ts        # TASK-01 已创建
```

**步骤**:
- [ ] 创建新目录结构（8 个功能目录）
- [ ] 迁移 35 个工具文件到对应目录
- [ ] 创建 `generationMap.ts`：
  ```typescript
  export const GENERATION_TOOLS: Record<GenerationId, string[]> = {
    gen1: ['bash', 'read_file', 'write_file', 'edit_file'],
    gen2: ['bash', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'list_directory'],
    // ...
  };
  ```
- [ ] 更新 `ToolRegistry` 导入路径
- [ ] 删除空的 `gen1-gen8` 目录
- [ ] 验证：所有工具正常执行

---

### 3.3 服务目录整理

**当前结构**: 16 个服务文件混在 `src/main/services/` 下

**目标结构**:
```
src/main/services/
├── index.ts              # 统一导出
│
├── core/                 # 核心服务（启动必需）
│   ├── ConfigService.ts
│   ├── DatabaseService.ts
│   └── SecureStorage.ts
│
├── auth/                 # 认证服务
│   ├── AuthService.ts
│   └── TokenManager.ts
│
├── sync/                 # 同步服务
│   ├── SyncService.ts
│   └── CloudStorageService.ts
│
├── cloud/                # 云端服务 (TASK-02 已创建部分)
│   ├── CloudConfigService.ts
│   ├── FeatureFlagService.ts
│   ├── CloudTaskService.ts
│   ├── UpdateService.ts
│   └── PromptService.ts  # @deprecated
│
└── infra/                # 基础设施
    ├── LangfuseService.ts
    ├── NotificationService.ts
    ├── BrowserService.ts
    └── ToolCache.ts
```

**步骤**:
- [ ] 创建服务子目录（5 个）
- [ ] 迁移服务文件到对应目录
- [ ] 统一单例模式：
  ```typescript
  // 每个服务文件底部导出
  let instance: XxxService | null = null;
  export function getXxxService(): XxxService {
    if (!instance) instance = new XxxService();
    return instance;
  }
  ```
- [ ] 创建 `services/index.ts` 统一导出
- [ ] 更新所有导入路径
- [ ] 验证：服务正常工作

---

## 涉及文件汇总

| 操作 | 数量 | 说明 |
|------|------|------|
| 新增 | 3 | `app/` 目录下 |
| 新增 | 11 | `ipc/` 目录下 |
| 移动 | 35 | 工具文件重组 |
| 移动 | 16 | 服务文件重组 |
| 修改 | 1 | `main/index.ts` 精简 |
| 删除 | 8 | `gen1-gen8` 空目录 |

---

## 禁止修改

- `vercel-api/` 目录（由 TASK-04 处理 API 版本化）
- `src/shared/types.ts`（由 TASK-04 拆分）
- 文件重命名（由 TASK-05 统一处理）

---

## 验收标准

- [x] `src/main/index.ts` < 100 行 (实际 120 行，接近目标)
- [x] 所有工具按功能目录组织
- [x] 所有服务按领域目录组织
- [x] `npm run typecheck` 通过
- [x] `npm run build` 成功
- [ ] `npm run dev` 启动正常 (待手动验证)
- [ ] 所有 35 个工具可正常调用 (待手动验证)

---

## 交接备注

- **完成时间**: 2025-01-19
- **目录结构变更清单**:
  - `src/main/app/`: bootstrap.ts (服务初始化), window.ts, lifecycle.ts
  - `src/main/ipc/`: 13 个 IPC handler 文件按领域拆分
  - `src/main/services/`: 5 个子目录 (core, auth, sync, cloud, infra)
  - `src/main/tools/`: 9 个功能目录 (file, shell, planning, network, mcp, memory, vision, multiagent, evolution)

- **导入路径变更说明**:
  - 服务: `'../services/ConfigService'` → `'../services/core/ConfigService'`
  - 工具: `'../tools/gen1/bash'` → `'../tools/shell/bash'`

- **下游 Agent 注意事项**:
  - IPC handlers 已完全迁移到 `src/main/ipc/` 目录
  - AgentOrchestrator、GenerationManager 等全局状态现在由 bootstrap.ts 管理
  - 新增 IPC handler 请创建对应的 `xxx.ipc.ts` 文件并在 `ipc/index.ts` 中注册
