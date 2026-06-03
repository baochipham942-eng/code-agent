# 项目空间容器设计（Project Space / P0-2）

> Status: 🚧 设计已拍板，实现中 · Owner: 林晨 · Created: 2026-06-03 · Branch: `feat/project-space`
> 产物中心路线图（`docs/research/2026-06-02-coze-codeg-cumora-competitive-analysis.md`）**最后一个 P0**。
> 本文是 SDD spec：§1 背景 / §2 已拍板决策 / §3 数据模型 / §4 迁移 / §5 后端 / §6 前端 / §7 与 P4 边界 / §8 范围与排期。

## 1. 背景与目标

cowork 的本质是围绕**长周期目标**协作，`session` 这个单元装不下。Coze 3.0 和 Cumora 都把组织单元从"会话"升到了"项目/房间"。

**产物中心修正版定位**：项目空间的中心视图不是"成员列表"（Coze 做法），而是"**产物列表**"——

> 项目 = 目标（goals）+ 产物集（artifacts）+ 围绕产物工作的 agent（roles）+ 关联会话（sessions）

**为什么是 P0**：goal 模式已 SHIPPED 但 goal 只挂在单次 run 上，跑完即弃；角色资产（PR #204/#207）已按 workspace hash 作用域存记忆，但没有显式的"项目"实体把目标 + 产物 + 角色 + 会话收束成一个可回看、可持续推进的容器。P0-2 补上这个容器。

## 2. 已拍板决策（2026-06-03，AskUserQuestion 敲定）

| # | 决策点 | 选择 | 理由 / 落地约束 |
|---|--------|------|----------------|
| D1 | Project ↔ workspace 关系 | **1:1 绑定 + 独立 ID** | 一个工作目录绑一个 project，但 project 有自己稳定 ID（`proj_` + 12 位 nanoid）。project 行记录 `workspacePath` 和 `workspaceKey`（= 现有 `getProjectKey()` hash）。接管现有项目记忆 key，**记忆文件零迁移**，只往 `projects/<key>/meta.json` 写入 `projectId`（落实 persistent-role-assets §3.4「只换索引不动文件」）。独立 ID 留出未来解耦成 N:1 的余地，不锁死 hash。 |
| D2 | 创建方式 | **隐式懒创建 + 可改名/设目标** | workspace 首次有 session 时自动建 project 行（沿用 `ensureProjectMemoryDirs` 的懒创建语义）。用户随时可改名/设目标。零 onboarding 摩擦，存量 session 自动归桶。显式"新建项目"和"升格建议"留 P1。 |
| D3 | goal 挂载 | **一个项目多个并行 goal** | 独立 `project_goals` 表，一个 project 可挂多条 goal，各自带状态（`active`/`met`/`aborted`/`archived`）。goal 完成 → 标 `met`，**项目不自动关闭**。project 派生状态：有 `active` goal 或运行中 session → `active`；否则 `idle`；用户归档 → `archived`。 |
| D4 | 迁移策略 | **按 workspace 自动归桶** | 存量 session 用 `working_directory`/`workspace` 算 hash 自动归入对应 project；无目录的归单一"未分类"项目（`proj_unsorted`）。`sessions.project_id` 为**可空列**，回填迁移幂等，不破坏存量。 |
| D5 | 中心视图 | **升级现有 Workspace Preview 为项目维度** | 复用 `buildWorkspacePreviewItems` 的 artifact 聚合，从 session 级升到 project 级（聚合同项目所有 session 的产物）+ 顶部 goal/状态条 + session/角色副栏。**不新建整页**，MVP 快且与现有 UI 一致。 |
| D6 | MVP 范围 | **含角色↔项目正式关联（角色入驻）** | 在实体 + DB + 产物面板 + 多 goal 基础上，加 `project_roles` join 表 + 入驻/退出。角色记忆本已按 workspace hash = 项目作用域，membership 是在其上加显式注册 + 列表。 |

## 3. 数据模型

### 3.1 三张新表（本地 SQLite，`schema.ts`）

```sql
-- 项目实体
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT PRIMARY KEY,          -- proj_<nanoid12>；proj_unsorted 为保留 ID
  name          TEXT NOT NULL,
  workspace_path TEXT,                     -- 绑定的工作目录绝对路径（unsorted 为 NULL）
  workspace_key  TEXT,                     -- getProjectKey(workspace_path)，接管项目记忆目录
  status        TEXT NOT NULL DEFAULT 'active',  -- active | idle | archived
  description   TEXT,
  is_deleted    INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL,
  archived_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_workspace_key ON projects(workspace_key) WHERE workspace_key IS NOT NULL;

-- 项目目标（多 goal 并行）
CREATE TABLE IF NOT EXISTS project_goals (
  id          TEXT PRIMARY KEY,            -- pgoal_<nanoid12>
  project_id  TEXT NOT NULL,
  goal        TEXT NOT NULL,               -- 自然语言目标
  verify      TEXT,                        -- 闸1 shell（可选，与 P4 GoalContract 同义但独立存储）
  review      TEXT,                        -- 闸2 软条件（可选）
  status      TEXT NOT NULL DEFAULT 'active',  -- active | met | aborted | archived
  last_run_session_id TEXT,                -- 最近一次推进这条 goal 的 session
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_project_goals_project ON project_goals(project_id);

-- 角色入驻项目（join 表，D6）
CREATE TABLE IF NOT EXISTS project_roles (
  project_id  TEXT NOT NULL,
  role_id     TEXT NOT NULL,               -- = agents/<id>.md 注册 id（roleAssetPaths.isSafeRoleId）
  joined_at   INTEGER NOT NULL,
  PRIMARY KEY (project_id, role_id),
  FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);
```

### 3.2 sessions 表渐进迁移（`migrations.ts`）

```sql
ALTER TABLE sessions ADD COLUMN project_id TEXT;   -- 可空，存量自动回填
```
索引：`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`。
沿用 `applySessionsMigrations` 的 `safeExec` 幂等模式，duplicate column 静默跳过。

### 3.3 contract 类型（`src/shared/contract/project.ts`）

```typescript
export type ProjectStatus = 'active' | 'idle' | 'archived';
export type ProjectGoalStatus = 'active' | 'met' | 'aborted' | 'archived';

export interface Project {
  id: string;
  name: string;
  workspacePath?: string | null;
  workspaceKey?: string | null;   // 项目记忆目录 key（接管 §3.4）
  status: ProjectStatus;
  description?: string;
  createdAt: number;
  updatedAt: number;
  archivedAt?: number | null;
}

export interface ProjectGoal {
  id: string;
  projectId: string;
  goal: string;
  verify?: string | null;
  review?: string | null;
  status: ProjectGoalStatus;
  lastRunSessionId?: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectRoleLink {
  projectId: string;
  roleId: string;
  joinedAt: number;
}

/** 项目详情聚合（中心视图数据） */
export interface ProjectDetail {
  project: Project;
  goals: ProjectGoal[];
  roles: ProjectRoleLink[];
  sessionIds: string[];
}
```

> **关键边界**：`ProjectGoal` 是 goal 的**持久化存储模型**，不复用也不修改 P4 的 `GoalContract`（`src/shared/contract/agent.ts`）/ `GoalRunInput`（`appService.ts`）。要把某条 ProjectGoal 跑起来时，由 ProjectService 投影成 `GoalRunInput`（goal/verify/review）交给现有 goal 链路——投影是单向只读的。详见 §7。

## 4. 迁移与归桶（D4）

启动迁移（`DatabaseService` 初始化时一次性，幂等）：

1. `ALTER TABLE sessions ADD COLUMN project_id`（safeExec）。
2. 建三张新表。
3. **回填归桶**（仅当存在 `project_id IS NULL` 的非删除 session 时执行）：
   - 取所有 `project_id IS NULL` 的 session，按 `working_directory`（缺则 `workspace`）分组；
   - 每个非空目录：`key = getProjectKey(dir)` → 查 `projects.workspace_key = key`，无则建 project 行（name = 目录 basename），把该组 session 的 `project_id` 指过去；
   - 无目录的 session：归入保留行 `proj_unsorted`（懒建）。
4. 对每个新建/接管的 project，若 `projects/<key>/meta.json` 存在则补写 `projectId` 字段（**不动记忆文件**）；不存在不强制创建（保持懒语义）。

回填用单事务，全程不删除、不改写 session 其它字段。存量 session 在迁移后仍可被旧代码路径读取（project_id 只是新增可空列）。

## 5. 后端

### 5.1 ProjectRepository（`src/main/services/core/repositories/ProjectRepository.ts`）

照 `ExperimentRepository` 样板，纯 SQL CRUD：
- `upsertProject` / `getProject` / `getProjectByWorkspaceKey` / `listProjects` / `archiveProject` / `softDeleteProject`
- `insertGoal` / `listGoals(projectId)` / `updateGoalStatus` / `archiveGoal`
- `addRole` / `removeRole` / `listRoles(projectId)`
- `assignSessionProject(sessionId, projectId, ts?)` / `listSessionIds(projectId)`
- `backfillSessions(ts)`：§4 回填归桶（注入时间戳，禁止内部 `Date.now()`，遵守硬编码红线）

经 `DatabaseService` facade 暴露 `getProjectRepo()`（照 `getSwarmTraceRepo` 模式）。

### 5.2 ProjectService（`src/main/services/.../projectService.ts`）

业务编排层（薄）：
- `ensureProjectForWorkspace(workspacePath)`：D2 隐式懒创建——查 `workspace_key`，无则建 + 接管 meta.json。session 创建链路调用它拿 `project_id`。
- `getProjectDetail(projectId)`：聚合 project + goals + roles + sessionIds（中心视图数据源）。
- `renameProject` / `setProjectStatus` / CRUD goal / join/leave role。
- `projectGoalToRunInput(goalId)`：投影成 `GoalRunInput`（§7 单向只读边界）。

时间戳一律由调用方传入或 `?? Date.now()`，repository 内不直接 `Date.now()`。

### 5.3 API + IPC

- `src/web/routes/projects.ts`：照 `sessions.ts` 的 `createProjectsRouter(deps)` 工厂；端点
  `GET /api/projects`、`GET /api/projects/:id`（= ProjectDetail）、`PATCH /api/projects/:id`（改名/状态）、
  `POST /api/projects/:id/goals`、`PATCH /api/projects/:id/goals/:goalId`、
  `POST /api/projects/:id/roles`、`DELETE /api/projects/:id/roles/:roleId`。
  在 `webServer.ts` 注册（照 `createSessionsRouter` 挂载点）。
- 桌面 IPC：对齐同名 handler（headless REST + 桌面 IPC 双链路，照现有 session 双链路）。

## 6. 前端（D5）

升级现有 Workspace Preview（`src/renderer/utils/workspacePreview.ts` + 对应面板组件），不新建整页：
- **数据**：产物聚合从「当前 session 的 messages/artifacts」扩展为「当前 project 下所有 session 的产物」。新增 `buildProjectPreviewItems(projectDetail, perSessionInputs)`，复用 `collect*` 原子函数，跨 session 去重后按优先级 + 时间排序。
- **项目 header**：面板顶部加一条 —— 项目名（可点改名）+ 状态徽标 + 多 goal 列表（每条目标 + 状态 + "推进"入口）+ 入驻角色头像行（点击管理入驻）。
- **副栏**：session 列表、角色列表作为支撑 rail，**产物列表占主区**（守住"中心是产物不是成员"红线）。

> 前端改 CSS/HTML 必须 desktop + mobile 双端截图验证（项目 frontend 规则）。

## 7. 与 P4（swarm goal）的边界

P4 swarm goal 已合并 origin/main（`feat/swarm-goal` 系列：`GoalContract.allowSwarm` + `SWARM_GOAL` 常量 + goal 内 swarm 执行接线）。边界约定：

| 维度 | P4 管 | P0-2 管 |
|------|-------|---------|
| goal 怎么执行 | ✅ 三层闸 / swarm 编排 / 预算记账 | — |
| goal 放在哪个容器、怎么持久化 | — | ✅ `project_goals` 表 + 状态机 |
| goal 契约字段 | ✅ `GoalContract` / `GoalRunInput`（`agent.ts` / `appService.ts`） | ❌ 不改，只**单向投影**读取 |

**红线**：P0-2 不修改 `src/shared/contract/agent.ts` 的 `GoalContract` 和 `appService.ts` 的 `GoalRunInput`。`projectGoalToRunInput` 是只读投影。若实现中发现必须改这两个 contract 文件，**停下来跟爸说**，不擅自改。

## 8. 范围与排期

**MVP（本期，✅ 已交付）**：§3 数据模型 + §4 迁移归桶 + §5 后端（Repo/Service/`domain:project` IPC，桌面原生 + HTTP 双链路统一）+ §6 前端 header + D6 角色入驻 + **跨 session 产物聚合**（`getProjectArtifacts`，原列 P1，按拍板提前到本期）。

**留 P1**：显式"新建项目"入口、session 积累升格建议、角色履历按项目分组（依赖本期 join 表）、项目记忆面板、N:1 多目录项目、产物聚合纳入工具输出文件（当前仅 assistant 消息内 artifact 代码块）。

**验证（✅ 全绿）**：
- typecheck 全程通过；`ProjectRepository.test.ts` 单测 13 条（迁移路径 / 1:1 归桶 / unsorted / 幂等 / 不破坏存量 / 多 goal 独立状态 / 角色入驻 / 归档过滤 / 跨 session 聚合·去重·limit）。
- `scripts/acceptance/project-space-e2e.ts` headless E2E 14 条（隐式归桶 / 1:1 绑定 / 详情聚合 / artifacts 端点 / 多 goal / 角色入驻 / 改名归档 / meta.json projectId 接管）。
- 前端：served webServer + Playwright 实跑——header 随会话 projectId 渲染、展开显 2 goal + 角色 chip、勾选 goal→已达成写回 round-trip、desktop + mobile(390px) 双端无布局破裂。

## 9. as-built 偏差

| 维度 | 设计 | as-built |
|---|---|---|
| 后端 transport | §5.3 写 express 路由 `routes/projects.ts` | 改为 **`domain:project` IPC 处理器**（`project.ipc.ts`），经 `domain.ts` 同时服务桌面原生 + HTTP，DRY 且桌面有 parity；express 路由已删 |
| 产物聚合 | §1/D5 列为"项目维度聚合"，§8 原把跨 session 聚合留 P1 | 按拍板**提前到本期**：`getProjectArtifacts` 扫项目下所有 session 抽 artifact，纯函数 `buildProjectArtifacts` 便于单测 |
| P4 边界 | 担心并行冲突 | P4 swarm-goal 已先合并 origin/main，本分支在其上开；`GoalContract`/`GoalRunInput` 零改动，仅单向投影 |
