# Agent Neo Multi-Source Project P0-P2 实施计划

> 状态：ready for implementation  
> 计划日期：2026-07-24  
> 目标仓库：`/Users/linchen/Downloads/ai/code-agent`  
> 实施分支：`codex/multi-source-project`  
> 基线：`origin/main@af33d10c6`  
> 范围约束：P0、P1、P2 均属于本次开发与验证范围，不允许完成 P0 后提前收口。  
> 发布边界：本次只做本地开发、验证和本地提交；未经用户明确授权，不 push、不创建 PR、不合并、不发布、不部署。

## 1. 产品判断

Agent Neo 当前已经有高于 Session 的 Project 容器，但 Project 与本地目录仍是 1:1：

- `Project.workspacePath` 只保存一个绝对路径。
- `Session.workingDirectory` 同时承担默认 cwd、项目归因和授权根。
- `RunContext.workspace` 是单根授权边界，`cwd` 必须位于该根目录内。
- ToolExecutor、权限分类、沙盒、Git 状态、产物追踪、Goal/Neo Tag、外部 Agent Engine 都依赖单根假设。
- 侧边栏已经能把同一 Project 下多个 Session 的路径聚合展示，但这只是展示能力，执行权限仍是单目录。

本次应将现有 Project 升级为多 Source 项目：

```text
Project
├── Primary source
│   ├── 项目默认 cwd
│   ├── 项目记忆、Skills、Hooks、MCP、Commands、Project AGENTS.md
│   └── 默认 Git / Review / PR 对象
├── Additional source A (read_only 或 read_write)
└── Additional source B (read_only 或 read_write)
```

现有 `workspacePath` 自动成为 Primary source。Session 继续保留自己的 `workingDirectory`，表示该会话的默认执行目录，不因编辑 Project Sources 被覆盖。

## 2. 用户价值

完成后，用户可以在一个 Project 中：

1. 以主代码仓作为 Primary source。
2. 添加需求文档、设计稿、数据、旧实现或其他配套仓库。
3. 在历史会话中继续工作，不需要复制文件、建软链接或重新创建会话。
4. 明确看到每个 Source 的权限、Git 状态和变更归属。
5. 保证未加入 Project 的目录仍处于 external access 边界。

## 3. 产品契约

### 3.1 Project 与 Source

新增结构化 Source：

```ts
type ProjectSourceRole = 'primary' | 'additional';
type ProjectSourceAccess = 'read_only' | 'read_write';

interface ProjectSource {
  id: string;
  projectId: string;
  path: string;
  canonicalPath: string;
  role: ProjectSourceRole;
  access: ProjectSourceAccess;
  trustState: 'trusted' | 'blocked';
  createdAt: number;
  updatedAt: number;
}
```

硬约束：

- 每个非 `proj_unsorted` Project 必须且只能有一个 Primary source。
- Primary source 固定为 `read_write`。
- Additional source 默认 `read_only`。
- 同一 canonical path 不能重复加入同一 Project。
- 同一路径允许属于不同 Project，但信任和权限决定必须可审计。
- Source path 必须在落库前完成 realpath/canonical path 解析。
- symlink、目录 inode/dev 身份改变后，已有 trust decision 失效。
- Source 不允许包含另一个 Source 或被另一个 Source 包含，除非明确证明不会产生权限歧义；P0-P2 默认拒绝重叠根。

### 3.2 Project 配置优先级

- Primary source 提供 Project 级：
  - 记忆
  - Skills
  - Hooks
  - MCP
  - Commands
  - Policy
  - 顶层 `AGENTS.md`
- Additional source 的指令文件只对该 Source 内目标路径生效。
- Additional source 不自动加载 Skills、Hooks、MCP 或 Commands，避免添加资料目录时引入可执行配置。
- 目标文件同时命中 Primary 与 Additional 的指令时，先加载 Primary 项目规则，再加载目标 Source 的路径级规则；安全策略只能收紧。

### 3.3 Session 与 Run

- `Session.projectId` 继续表示 Project 归属。
- `Session.workingDirectory` 继续表示该会话默认 cwd。
- 新建 Session 默认 cwd = Primary source。
- 历史 Session 的 cwd 不迁移、不重写。
- 历史 Session 下一次启动新 Run 时读取当前 Project Sources。
- 运行中的 Run 持有不可变 Source 快照；Project 编辑不能中途扩权或缩权。
- Project Source 删除后，新 Run 立即失去该 Source；旧消息、产物和审计记录继续保留。
- cwd 可以位于任一授权 Source 内；默认仍使用 Session cwd，否则回退 Primary source。

建议将 RunContext 演进为：

```ts
interface WorkspaceRoot {
  sourceId: string;
  path: string;
  access: 'read_only' | 'read_write';
  role: 'primary' | 'additional';
}

interface WorkspaceScope {
  projectId: string;
  primaryRoot: string;
  roots: readonly WorkspaceRoot[];
  version: string;
}

interface RunContext {
  runId: string;
  sessionId: string;
  workspaceScope: WorkspaceScope;
  cwd: string;
  createdAt: number;
}
```

`version` 应由已排序的 canonical roots、role、access 和 trust identity 生成稳定摘要，用于恢复、审计和权限漂移检测。

### 3.4 UI 入口

统一使用“编辑项目”弹窗，入口有两处：

1. 左侧历史会话 Project Group 菜单 → `编辑项目`
2. Project Detail / Workspace Preview Header → `项目设置`

弹窗包含：

- Project 名称
- `Source folders`
- Primary source，带 `Primary` 标记，不允许直接删除
- Additional sources，显示 `只读` / `读写`
- `添加文件夹`
- `设为主目录`
- `移除`
- `删除项目`
- `取消` / `保存`

交互约束：

- 添加 Source 后先进入 Folder Trust 检查，再保存。
- Additional 默认只读；切换读写必须显式确认。
- 切换 Primary 前检查新目录存在、可信且可写。
- Primary 被切换后，Project 记忆和配置归属跟随新 Primary；历史 Session cwd 不变。
- 删除 Project 只删除 Neo 的项目关系和会话归组，不删除磁盘文件、Git 仓库或产物文件。
- Source 有运行中任务时，移除操作阻止并解释原因。
- Source 有未提交变更时，移除前给出明确警告。

## 4. P0：项目级多 Source 与只读访问

### 4.1 目标

交付“Primary 可写 + 多个 Additional 只读”的完整闭环，使历史会话下一次运行能读取 Project Additional Sources。

### 4.2 数据层

新增 `project_sources` 表：

```sql
CREATE TABLE project_sources (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  path TEXT NOT NULL,
  canonical_path TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'additional')),
  access TEXT NOT NULL CHECK (access IN ('read_only', 'read_write')),
  trust_state TEXT NOT NULL CHECK (trust_state IN ('trusted', 'blocked')),
  identity_dev TEXT,
  identity_ino TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

索引与约束：

- `UNIQUE(project_id, canonical_path)`
- 每 Project 单 Primary，使用 partial unique index：
  - `UNIQUE(project_id) WHERE role = 'primary'`
- `project_id` 普通索引

兼容迁移：

- 保留 `projects.workspace_path` 与 `workspace_key`。
- 启动迁移为所有已有、非空 `workspace_path` Project 幂等创建 Primary source。
- `proj_unsorted` 不创建 Source。
- 迁移可重复执行，不产生重复 Source。
- 项目创建、懒归桶和 workspace backfill 同时写 Primary source。
- 旧数据库、空数据库、迁移中断后的数据库都必须可再次启动。

主要改造入口：

- `src/shared/contract/project.ts`
- `src/host/services/core/database/schema.ts`
- `src/host/services/core/repositories/ProjectRepository.ts`
- `src/host/services/project/projectService.ts`
- `tests/unit/services/ProjectRepository.test.ts`
- 新增 Project Source repository/service tests

### 4.3 Project Domain API

新增或扩展 actions：

- `sources`
- `addSource`
- `updateSourceAccess`
- `setPrimarySource`
- `removeSource`
- `updateProject`

推荐 `updateProject` 接受完整、带 revision 的 Project 编辑请求，由 Service 在一个数据库事务中完成：

1. 校验 Project revision。
2. canonicalize 所有路径。
3. 校验单 Primary、权限和重叠根。
4. 校验 Folder Trust。
5. 写 Project metadata 和 Sources。
6. 增加 Project source revision。

禁止“改名称成功、Sources 失败”的半完成状态。

主要改造入口：

- `src/host/ipc/project.ipc.ts`
- `src/renderer/services/projectClient.ts`
- `src/shared/ipc/types.ts`
- Project IPC/domain tests

### 4.4 WorkspaceScopeResolver

新增单一授权真相模块，例如：

- `src/host/runtime/workspaceScope.ts`

职责：

- canonical path 解析
- root 去重
- 重叠根校验
- 判断候选路径属于哪个 Source
- 判断 read/write 是否允许
- 判断 cwd 是否位于任一 Source
- 输出 sourceId、role、access，供审批和审计使用

所有调用方禁止继续使用字符串 `startsWith(workingDirectory)` 判断边界，统一迁移到 resolver。

P0 至少迁移：

- `src/host/runtime/runContext.ts`
- `src/host/tools/toolExecutor.ts`
- `src/host/tools/permissionClassifier.ts`
- `src/host/tools/toolPermissionClassification.ts`
- `src/host/agent/runtime/toolPreflightGuards.ts`
- Read / Glob / Grep / ListDirectory 路径处理
- subagent ToolContext 投影
- Run durable recovery

### 4.5 Folder Trust

- 每个 Source 单独 evaluate 和 set。
- Project 编辑弹窗汇总显示每个 Source 的 trust 状态。
- Primary 的危险配置按现有逻辑加载。
- Additional P0 只允许读取普通文件；其 Hooks/MCP/Skills/Commands 不加载。
- Additional 内路径级 `AGENTS.md` 的加载必须在 trust 通过后进行。
- identity 漂移后 fail-closed。

主要改造入口：

- `src/host/security/folderTrustService.ts`
- `src/host/ipc/folderTrust.ipc.ts`
- `src/renderer/components/FolderTrustDialog.tsx`
- folder trust unit/renderer tests

### 4.6 P0 UI

新增复用弹窗：

- `ProjectSettingsDialog`
- `ProjectSourceList`
- `ProjectSourceRow`
- folder picker adapter

接入：

- `src/renderer/components/features/sidebar/SidebarProjectGroup.tsx`
- `src/renderer/components/features/sidebar/SidebarProjectDrawer.tsx`
- `src/renderer/components/ProjectHeaderBar.tsx`
- `src/renderer/services/projectClient.ts`

UI 必须支持：

- 当前 Primary 展示
- 添加只读 Source
- 保存失败后保留用户输入
- 重复目录、重叠目录、被阻止目录的明确错误
- Delete Project 的文件安全说明
- 中文与英文文案

### 4.7 P0 验收

1. 旧 Project 启动后自动拥有一个 Primary source。
2. 历史 Session 不改 cwd。
3. 添加兄弟目录为只读 Source 后，历史 Session 新 Run 能 Read/Glob/Grep/List。
4. 未加入 Project 的第三个目录仍分类为 external access。
5. Additional Source 无法 Write/Edit，也无法通过 Bash 工作目录绕过。
6. Source symlink retarget 后，新 Run fail-closed。
7. Project 编辑中的新增/删除/改名原子化。
8. 真实应用中从左侧 Project Group 打开弹窗，保存、重启后状态存在。

## 5. P1：Additional Source 可写与完整变更追踪

### 5.1 目标

允许用户显式将 Additional Source 提升为 `read_write`，并让所有写入、安全、产物和恢复链路理解多根。

### 5.2 沙盒

统一 `SandboxWrapOptions`：

```ts
interface SandboxWrapOptions {
  cwd: string;
  readOnlyRoots: string[];
  readWriteRoots: string[];
  allowNetwork?: boolean;
}
```

macOS Seatbelt：

- `cwd` 只决定进程相对路径。
- 所有 `readWriteRoots` 写入 allow list。
- `readOnlyRoots` 不获得写权限。
- 继续保护 sensitive host paths。
- 产品文案不能声称 macOS shell 已完全禁止读取所有未授权普通目录，除非本阶段同时完成并验证 read confinement。
- Native Read/Search 工具必须严格遵循 Project Source 范围。

Linux Bubblewrap：

- `readOnlyRoots` 使用 `--ro-bind`。
- `readWriteRoots` 使用 `--bind`。
- `cwd` 使用 `--chdir`。
- sensitive paths 继续覆盖屏蔽。

主要改造入口：

- `src/host/sandbox/manager.ts`
- `src/host/sandbox/seatbelt.ts`
- `src/host/sandbox/bubblewrap.ts`
- `tests/integration/sandbox/seatbeltWrap.test.ts`
- `tests/integration/sandbox/bubblewrapWrap.test.ts`

### 5.3 工具权限与写隔离

迁移所有写路径判断：

- Write
- Edit
- MultiEdit
- Bash
- notebook/office/document 写入工具
- artifact repair
- checkpoint
- write isolation
- Neo Tag write scope
- Goal evidence/verify
- workspace hygiene
- file mutation tracking
- completion summary
- subagent permission contraction

每条审批和审计记录增加：

- projectId
- sourceId
- sourceRole
- sourceAccess
- relativePathWithinSource
- workspaceScopeVersion

Additional `read_write` 仍不能加载或执行该目录的 Hooks/MCP/Skills。

### 5.4 产物、恢复和历史

- 相对产物路径必须绑定 Source，而非默认拼到 Primary。
- `ProjectArtifact` 增加可选 `sourceId`。
- checkpoint 与 rollback 记录 Source。
- completion summary 按 Source 分组 changed files。
- durable recovery 校验恢复时的 Scope version；Source 被移除时不得静默继续写。
- 旧消息中无 sourceId 的路径按历史 Session cwd 兼容解析。

### 5.5 P1 UI

- Additional Source 支持 `只读` / `读写` 切换。
- 提升读写时显示风险说明和目标绝对路径。
- Project 页面与审批框展示 Source 标签。
- 移除可写 Source 前检查运行中任务和 dirty state。
- Source 不可用时显示 `路径失效`，Project 其他 Source 继续工作。

### 5.6 P1 验收

1. Additional 默认只读。
2. 用户显式提升读写后，Write/Edit/Bash 可以修改该 Source。
3. 只读 Source 始终无法写。
4. 未授权目录无法借绝对路径、`..`、symlink 或 Bash cwd 绕过。
5. macOS 与 Linux 权限矩阵一致，差异有清晰产品说明。
6. Source 被移除后，新 Run 无法继续写；旧 Run 不被动态扩权。
7. checkpoint、undo/rollback、completion summary 能正确标注 Source。
8. Neo Tag、Goal、subagent 写入遵守同一 WorkspaceScope。

## 6. P2：多仓 Git、外部 Agent Engine 与交付闭环

### 6.1 目标

当多个 Source 本身是独立 Git repository 时，Neo 能明确展示、审阅和验证每个仓的状态，避免把多仓改动伪装成单仓交付。

### 6.2 Source Git 模型

新增派生信息：

```ts
interface ProjectSourceGitState {
  sourceId: string;
  isRepository: boolean;
  repositoryRoot?: string;
  headSha?: string;
  branch?: string;
  dirtyFiles?: string[];
  ahead?: number;
  behind?: number;
}
```

规则：

- Primary 仍是默认 Git / Review / PR 对象。
- Additional read-only 只展示状态。
- Additional read-write 若发生变更，必须在交付摘要中独立列出。
- Git status、diff、checkpoint、completion summary 按 repositoryRoot 分组。
- 一个 Source 内嵌多个 repo 的场景 P2 不自动递归接管；只识别 Source 根或明确选择的 repo root。
- Commit、PR、merge、release 必须明确 repo；不能对多个 repo 做隐式批量操作。

### 6.3 Review 与交付

- Project Review 面板按 repo 分组 diff。
- 每组显示 Source、repo root、branch、HEAD、dirty files。
- Goal 完成证据记录所有发生变更 repo 的 HEAD SHA 和验证命令。
- 若任何可写 Source dirty 但未进入交付摘要，Goal/Completion Gate fail-closed。
- Delete/Remove Source 不得隐藏未交付改动。

主要改造入口：

- `src/host/services/git/gitStatusService.ts`
- `src/host/session/completionSummaryService.ts`
- Workspace Preview / Review 相关组件
- Project artifact / handoff / Goal gate

### 6.4 外部 Agent Engine

当前外部 Engine 适配器只接收一个 `workspaceRoot`，且强制 cwd 位于该根。P2 需要：

- Engine launch request 接收 WorkspaceScope。
- cwd 可位于任一授权 Source。
- 各外部 Engine 显式映射其多目录能力。
- 无原生多根能力的 Engine：
  - 保持 cwd = Primary
  - 通过其支持的 sandbox/add-dir/allowed-root 参数传递 Additional Sources
  - 无法安全表达时 fail-closed，并在 UI 标注该 Engine 暂不支持当前 Project Sources
- read-only profile 不因多 Source 被扩大为 write。

主要改造入口：

- `src/host/services/agentEngine/agentEngineGuards.ts`
- `src/host/services/agentEngine/claudeCodeAdapter.ts`
- `src/host/services/agentEngine/codexCliAdapter.ts`
- `src/host/services/agentEngine/kimiCliAdapter.ts`
- `src/host/services/agentEngine/mimoCliAdapter.ts`
- external engine durable lifecycle 与 acceptance

### 6.5 LSP 与开发体验

- Primary source 继续作为默认 LSP root。
- 若 LSP 支持 workspace folders，则添加代码类 Additional Sources。
- 不支持多 root 的 LSP 保持 Primary，不阻断文件访问。
- Project Header 显示 Primary 与 Source 数量。
- Source 不可用、trust 失效、Engine 不支持时给出可行动提示。

### 6.6 P2 验收

1. Primary 与 Additional 是两个独立 Git repo 时，状态和 diff 分组正确。
2. 一个 repo clean、另一个 dirty 时，交付摘要不会漏报。
3. 非 Git Source 不影响项目运行。
4. 外部 Agent Engine 不会把 Additional Source 当成 Primary 覆盖项目配置。
5. 不支持多根的 Engine 明确阻止或降级，不能静默丢 Source。
6. Goal 完成证据包含所有变更 repo 的 HEAD SHA。
7. Project Review 能从 UI 定位到每个 Source 的变更。

## 7. 数据迁移与兼容性

迁移策略必须满足：

1. 现有 `projects.workspace_path` 不删除。
2. 首次启动幂等回填 Primary source。
3. 新建 Project 同时写旧字段与 `project_sources`。
4. 读路径优先读 `project_sources`；缺失时从旧字段构造内存 Primary 并触发修复。
5. `workspace_key` 与项目记忆仍由 Primary path 派生。
6. 切换 Primary 时原子更新 `workspace_path`、`workspace_key`、Source roles 和记忆 meta。
7. `proj_unsorted` 保持无 Source。
8. 已归入 Project 但 Session cwd 与 Primary 不同的历史数据保留；若 cwd 不属于任何 Source，显示历史外部 cwd 状态，新 Run 默认回退 Primary，不自动把该 cwd 加为 Source。

迁移验证：

- 空数据库
- 只有旧 Project 的数据库
- 已有 Primary source 的数据库
- 迁移执行一半后重启
- workspace 路径不存在
- symlink 指向改变
- 同路径不同文本表示

## 8. 安全不变量

本次实现不得破坏：

- Run scope 启动后不可变。
- 子 Agent 权限只能收紧。
- read-only Source 不可通过 Bash、外部 Engine 或工具旁路写入。
- Source 新增必须经过用户动作与 trust gate。
- dangerous project config 只从 Primary 自动加载。
- sensitive paths 持续屏蔽。
- 所有路径比较基于 canonical realpath 与 `path.relative`，禁止字符串前缀判断。
- Project 删除不删除用户磁盘文件。
- Source 删除不删除文件。
- 运行中任务不能因 Project 编辑获得新权限。

## 9. 实施顺序

### Stage A：契约与迁移

1. ProjectSource contract
2. `project_sources` schema/index
3. repository/service CRUD 与幂等回填
4. domain API 与 revision 原子更新
5. 数据层测试

决策门：旧数据库无损迁移、单 Primary 约束和原子更新通过后再进入运行时。

### Stage B：运行时多根只读

1. WorkspaceScopeResolver
2. RunContext / ToolContext
3. Read/Search 与 cwd 校验
4. Folder Trust
5. durable recovery / subagent 投影
6. P0 UI 与真实应用验收

决策门：未加入目录和 read-only Source 无写入逃逸后，P0 才算通过；继续进入 P1。

### Stage C：多根写入

1. Seatbelt/Bubblewrap 多根
2. Write/Edit/Bash
3. write isolation / checkpoints / artifacts / Neo Tag / Goal
4. 审批与审计 Source attribution
5. P1 UI 与恢复验证

决策门：macOS/Linux 权限矩阵、symlink 和子 Agent 场景通过后，P1 才算通过；继续进入 P2。

### Stage D：多仓 Git 与 Engine

1. per-Source Git state
2. Review / completion / Goal evidence
3. external Agent Engine mapping
4. LSP 降级策略
5. P2 UI 与跨仓验收

决策门：所有发生变更的 repo 都能被发现、审阅和记录 HEAD 后，P2 才算通过。

### Stage E：完整回归与真实运行

1. 全量 typecheck/lint/unit/build
2. project-space acceptance
3. macOS Seatbelt integration
4. Linux Bubblewrap tests
5. session persistence/recovery
6. external engine acceptance
7. 真实应用 UI 路径与截图
8. 新鲜目标分支构建产物验证

## 10. 测试矩阵

### 10.1 单元测试

- ProjectSource repository/service
- migration idempotency
- single Primary invariant
- canonical path / symlink / overlap roots
- WorkspaceScopeResolver read/write
- run scope immutability
- permission classification
- folder trust identity drift
- artifact source resolution
- completion summary per Source
- external engine capability mapping
- sidebar/project settings state

### 10.2 集成测试

- Seatbelt:
  - Primary read/write
  - Additional read-only
  - Additional read/write
  - external write denied
  - sensitive read denied
- Bubblewrap 同一矩阵
- subagent 不扩权
- durable restart 后 Scope 恢复
- Source 删除/权限调整后新旧 Run 行为
- 两个 Git repo 的 dirty state 与 diff

### 10.3 Acceptance / E2E

扩展：

- `scripts/acceptance/project-space-e2e.ts`
- `scripts/acceptance/session-persistence-smoke.ts`
- Agent Engine selector / Codex CLI / Claude acceptance

新增：

- `scripts/acceptance/multi-source-project-e2e.ts`
- 真实 renderer/browser Project Settings 流程

真实路径：

1. 打开已有 Project。
2. 编辑项目。
3. 添加兄弟目录。
4. 默认只读保存。
5. 回到历史 Session 读取该目录文件。
6. 验证写入受阻。
7. 提升读写。
8. 验证跨目录修改、审批、变更追踪。
9. 两目录都是 Git repo 时验证分组 diff。
10. 重启应用后复验。

### 10.4 必跑命令

至少执行：

```bash
npm run typecheck
npm run lint
npx vitest run \
  tests/unit/services/ProjectRepository.test.ts \
  tests/unit/security/folderTrustService.test.ts \
  tests/unit/host/sandbox/seatbeltSensitivePaths.test.ts \
  tests/unit/host/sandbox/bubblewrapSensitivePaths.test.ts \
  tests/integration/sandbox/seatbeltWrap.test.ts \
  tests/integration/sandbox/bubblewrapWrap.test.ts
npm run test
npm run build
npm run acceptance:session-persistence
```

再运行扩展后的 Project Space 和新增 Multi-Source acceptance。若仓库提供总门 `npm run check`，最终必须通过。

## 11. 交付证据

最终交接必须包含：

- 基线、分支和最终 HEAD SHA
- 数据模型与迁移说明
- P0/P1/P2 文件级变更
- 每阶段验证命令与结果
- macOS/Linux 权限矩阵
- 真实 UI 截图
- 历史 Session 升级验证
- 两 repo Git 分组验证
- 外部 Agent Engine 支持/降级表
- 未解决风险
- 工作树状态

测试绿、静态 UI、schema 完成或 P0 完成都不能单独视为本目标完成。

## 12. 明确非目标

- 不自动把任意历史 cwd 加入 Project。
- 不扫描整台机器推荐 Source。
- 不自动 commit、push、创建 PR、merge、release 或 deploy。
- 不把多个 Git repo 合并成一个 repo。
- 不从 Additional Source 自动加载可执行配置。
- 不在本次实现嵌套 repo 的递归管理。
- 不通过扩大到父目录来伪造多 Source。

## 13. 完成定义

本目标完成要求同时满足：

1. P0、P1、P2 全部实现。
2. 旧 Project 无损迁移为单 Primary source。
3. 历史 Session 下一次 Run 使用 Project Sources，cwd 保持不变。
4. 多根 read/write 权限在 Native tools、Bash、subagent 和外部 Engine 中一致且 fail-closed。
5. Project Settings 两个入口可用，真实应用重启后持久化。
6. 多仓 Git 状态、diff、completion 和 Goal evidence 不漏仓。
7. 定向测试、全量测试、构建和真实 E2E 均通过。
8. 未 push、未 PR、未发布、未部署。

