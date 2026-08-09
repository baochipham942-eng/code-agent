# ADR-056：指挥台前台放开只读工具——「非斜杠即只能派活」判据的修正

- 状态：accepted（2026-08-08 产品负责人拍板取丙案）
- 日期：2026-08-08
- 关联：[ADR-054 会话=指挥台](./ADR-054-session-as-command-center.md)（本 ADR 不推翻它，是按它自己写的原则收窄实现的过宽处）
- 排查依据：`code-agent-private-archive/docs/plans/2026-08-07-T3-工具坍缩排查报告.md`
- **后续（2026-08-09，本 ADR 决策不变，工具面有两处变更）**：① `spawn_task` 已改名
  **`delegate_task`**（#1055，路由契约从系统提示词搬进工具 description）；② 前台元组补登记
  **`spawn_agent`** 作为角色委派入口（#1056，此前用户点名角色时模型只能让通用任务扮演）。
  **正文以下保留决策当时的原文与命名，不作回溯改写**；当前形态以
  `docs/plans/2026-08-07-neo-post-v0.30-as-built-spec.md` §2.1 为准。

## 背景：一个判据，两次真机体验伤害

ADR-054 落地后，前台 turn 的工具表由这条判据决定：

> **本轮消息不以 `/` 开头，且没有 goal ⇒ 套用指挥台 brain，工具表硬收窄为 5 个**
> （`spawn_task` / `steer_task` / `cancel_task` / `task_status` / `AskUserQuestion`）

判据实现在两处，语义相同：

| 通道 | 位置 |
|---|---|
| 桌面（Tauri IPC） | `src/host/app/agentAppService.ts:707-709` → `withSessionCommandCenterBrain()` |
| Web（独立 HTTP 路由） | `src/web/routes/agent.ts:776-786`（**同一判据的第二份手写实现**，不复用共享函数） |

两次真机伤害都是同一形态——**用户要读一个文件，前台却只能派活**：

1. **2026-08-06 首轮验收 FAIL**：会话指挥台批次真机验收。
2. **2026-08-07 Windows 测试者**：首条消息是自然语言的「看一下这个项目待提交的内容」。
   模型手里只有 5 个工具，却被 system prompt 告知「延迟工具可用 ToolSearch 取」，
   于是连问 5 轮 `AskUserQuestion`、3 次 300s 超时，最后才走 `spawn_task`。
   用户看到的是「工具越用越少」（实际工具表从第 1 轮起就恒为 5，是模型逐轮撞墙的叙述叠加）。

### 判据实际上是「永远」

真库统计（`~/.code-agent-dev/code-agent.db`，Dev 槽 dogfood 流量，全量用户消息）：

| 用户消息总数 | 以 `/` 开头 | 走指挥台收窄的比例 |
|---|---|---|
| 1364 | 12 | **99.1%** |

也就是说这不是一条「特定场景收窄」的判据，而是**默认档**。「斜杠命令」是极少数派，
用它当「用户想直接干活」的信号，与真实输入分布不符。

### ADR-054 的原文比实现更宽

`docs/architecture/workbench.md:204` 记录 ADR-054 的原则是：

> 当前 turn 的前台工具策略只允许**短时、低副作用**操作，耗时工作通过 `SessionTaskService` 进入后台槽位。

`Read` / `Grep` / `Glob` / `ListDirectory` 恰恰是短时、低副作用（毫秒级、零写入）。
**5 元组实现比它所实现的 ADR 更窄**——本 ADR 修的是这个落差，不是推翻 ADR-054。

## 候选方案

### 甲：意图分类放行

在选工具表之前跑一次意图分类，判定「轻量读写请求」就给宽表。

- 优点：理论上最贴合用户当轮意图。
- 缺点：**把确定性行为换成概率性行为**。分类错的那一次，用户撞的是同一堵墙，而且这次
  不可预测——今天能读、明天不能读。仓内意图分类已有 3s 超时预算，误判/超时都要有兜底档，
  而兜底档只能是「宽」或「窄」二选一，等于绕回本题。
- 判决：**不取**。用一个新的概率性失败源去修一个确定性设计过宽，是净负。

### 乙：首轮宽表，后续收窄

- 缺点：**与伤害形态不符**。两次伤害都发生在第 1 轮（Windows 测试者的首条消息就是读请求）。
  且同一会话内工具面中途变化，正是 2026-07-21 粘滞 strict skill 那次故障的形态。
- 判决：**不取**。

### 丙：前台内嵌只读工具（推荐）

把指挥台 brain 的 allowlist 从 5 个扩到 5 + 只读工具：
`Read` / `Grep` / `Glob` / `ListDirectory`。

写入、命令执行、联网、需要审批的工作**照旧只能 `spawn_task`**——那本来就是指挥台的价值所在，
不动。

- 确定性：一句话能讲清的规则——**前台能看，不能动**。用户学一次就懂，不会有「这次行不行」的猜测。
- 覆盖伤害：两次真机伤害全部是读请求，丙案全覆盖。
- 不新增机制：改一个常量 + 同步一句提示词。`maxIterations` 已被钳到 8，前台跑不飞。
- 权限不打折：`Read`/`Grep` 照旧过 folder-trust 与权限档，前台放开的是「模型能不能发起」，
  不是「能不能绕过审批」。
- 不覆盖的场景：「改一下这个文件」仍然只能派活。这是设计意图，且模型现在会**如实说明**
  （T3b 已补的那句「这是流程设计，不是权限问题或环境故障」），不再编造「环境禁用了」。

## 决策

**取丙案**（2026-08-08 拍板）。

### 实施要点（拍板后执行，不在本 ADR 内改码）

1. **常量单点扩容**：`src/shared/constants/sessionCommandCenter.ts` 的
   `SESSION_COMMAND_CENTER_BRAIN_TOOL_NAMES` 加入四个只读工具。
2. **判据收口到单一真源**：落地时发现两侧装配的是**不同形状**的配置对象
   （桌面 `AppServiceRunOptions` 的 `turnSystemContext: string[]` vs web `AgentConfig` 的
   `systemPrompt: string`），装配代码共用不了，所以不是「复用 `withSessionCommandCenterBrain()`」
   那么简单。真正会漂移的是**判据**，抽成 `isSessionCommandCenterTurn()` 放进
   `shared/constants/sessionCommandCenter.ts`，两侧各自装配但共用同一个判据。
   另：全仓 grep 发现桌面侧其实有**两个**调用点（`agentAppService.ts` 的 startTask 与
   interruptAndContinue），T3 报告只列了一个——手工枚举必漏，本仓第 N 次。
3. **提示词同步**：`sessionCommandCenterBrain.ts` 里那句「你本轮只看得到这 5 个工具，
   Read/Bash/Grep/ToolSearch 等其他工具都不在这里」**逐字点了 Read/Grep**，必须同步改写为
   「你能读（Read/Grep/Glob/ListDirectory），但不能写、不能跑命令、不能联网——那些交给
   `spawn_task`」。改提示词有 pre-commit 门，需 bump `PROMPT_VERSION`。
4. ~~**顺带补上收窄的可观测性**~~ —— **落地时发现已由 T3b（#1026）做掉**，本 ADR 不重复：
   `filterToolsByRunPolicyObserved`（`toolRunPolicy.ts:62`）已打日志 + 发
   `TOOL_SCOPE_NARROWED`（`narrowedBy: 'run_policy'`），`emitToolSchemaSnapshot` 的
   `tools.length === 0` 早退也已删除。T3 报告写于该 PR 之前，此条已过期。
5. **验收判据（真机，不接受 hermetic 代跑）**：桌面新开会话，首条消息发
   「只读检查 <某个文件>，告诉我它多少行」。预期：模型直接调 `Read` 并给出答案，
   不派活、不问反问、不提「环境受限」。对照组：同一会话再发「把这个文件改成 X」，
   预期仍走 `spawn_task`。

## 影响与风险

- **前台可能被一次大范围 `Grep` 占住**：`maxIterations=8` 是现成上限；只读工具自身有结果
  截断预算。判断不需要额外护栏，若真机出现前台卡顿再单独收。
- **回滚**：改动是一个常量数组 + 一句提示词，`git revert` 即可，不留兼容分支
  （研发期禁兼容分支纪律）。
- **不改的东西**：判据本身（仍是「非斜杠即指挥台」）、`maxIterations` 上限、
  后台任务槽的反向 denylist、`spawn_task` 派活纪律。本 ADR 只改「前台看得见哪些工具」。
