# ADR-049：能力中心 —— 一个能力只有一个家

- 状态：已采纳
- 日期：2026-07-23
- 相关：ADR-047（主理人编排）、ADR-048（云下发角色包）

## 背景

Neo 的「能力」（专家 / 自动化 / 技能 / 连接器 / 插件 / 资料库）在两处入口分居：

| 能力 | 会话区侧栏 | 设置页 tab |
|---|---|---|
| 资料库 | ✅ `LibraryPanel` | 无 |
| 专家 | ✅ `ExpertPanel` | `roles` |
| 自动化 | ✅ `CronCenterPanel` | `automation` |
| 技能 | ❌ | `skills` |
| 连接器 | ❌ | `capabilities` + `mcp` |
| 插件 | ❌ | `plugins` |

结果是三种病同时存在：**专家 / 自动化有两份列表实现**（改一处忘一处）、**技能 / 连接器 / 插件没有会话区的家**
（消费路径里想换个技能得先出去开设置页）、**只有资料库是对的**（单一入口）。

E6-1 做角色详情页时的别扭正是这个病的症状：`RoleDetailPage` 不得不同时被 `ExpertPanel` 和设置页 `RolesTab` 共用，
因为两个入口都在。

## 决策

**新建「能力中心」全屏页（会话区侧栏一级入口），四项能力按顶层 tab 切换；设置页对应 tab 按各自归属收敛。**

- 能力中心 tab：专家 / 技能 / 连接器 / 插件
- 资料库保持独立侧栏入口（它本来就是对的样板），不并入
- 自动化保持会话区独立入口，承载下次运行时间与待过目角标等实时状态

### 实现口径：不搬文件，只换挂载点

`SkillsSettings` / `MCPSettings` / `PluginsSettings` 物理上仍在 `features/settings/tabs/`，
只是改由 `CapabilityHubPage` 挂载。一份实现、一个家、零重复，改动面也最小。

`ExpertPanel` 成为能力中心 tab 内容；`CronCenterPanel` 保持自己的全屏壳与关闭行为。

### 深链兼容

`SETTINGS_TAB_IDS` 保留 `roles/automation/skills/mcp/plugins/capabilities` id 作为**深链入口**
（`messageContentParts` 有动态 `openSettingsTab(arg as SettingsTab)`，删 id 会让模型产出的深链静默失效）。
`appStore.openSettingsTab` 是唯一分流点：roles / skills / mcp / plugins 转去能力中心；automation 打开独立自动化面板；capabilities 打开设置页管理组。
设置页搜索索引条目一并保留，搜「mcp / 技能 / 插件」仍能到达能力中心。

### 权限门控随挂载点迁移

- `plugins` tab 门控沿用 `canAccessSettingsTab('plugins', subject)`
- 能力清单留在设置页管理组，沿用 `canAccessSettingsTab('capabilities', subject)`（真 admin 门）
- 当前 tab 落在无权限项上时自动回落到第一个可见 tab

## 规则演进：`feedback_neo_config_in_settings_ia` 被更新，不是被违反

旧规矩「**配置归设置页 · 消费页只选**」的本意是「别在消费流程里塞配置」，不是「配置必须住在设置页」。
技能 / 连接器当初待在设置页，是因为**那时没有别的家**。现在有了。

规则演进为：

> **一个能力只有一个家（能力中心）；消费路径（「请 TA 来」「用这个配方」）只选不配。**

## 后果

- 正面：消除专家的双份实现；技能 / 连接器 / 插件首次拿到会话区入口；自动化保持任务入口；设置页回归「偏好与系统」本分
- 代价：`SettingsModal` 的对应 tab 分支与两个组件（`AutomationSettings` / `RolesTab`）被删，
  删前各自的独有项须先并入去处（见下）
- 已并入的独有项：
  - `AutomationSettings` 的「执行总数 / 失败次数」统计与 `WebModeBanner` → 并入 `CronCenterPanel`
  - `RolesTab` 的「按分类分组」与「+ 新建角色」→ 并入 `ExpertPanel` 的「我的」tab
    （`groupRolesByCategory` 平移到 `features/expert/roleCategoryGroups.ts`，逻辑与单测不变）

## 2026-07-23 dogfood 后收窄

- 自动化因「跑任务 ≠ 能力资产」摘回会话区独立入口，仍只有一个家。
- 能力清单因「管理审计面 ≠ 能力，且不该给普通用户看」搬回设置页管理组，并保留 admin 门。
