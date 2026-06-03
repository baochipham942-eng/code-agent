# 角色主动性（Role Proactivity）设计方案

> 状态：设计定稿，待实现（MVP 范围见 §8）
> 日期：2026-06-03
> 上游：[竞品分析报告](../research/2026-06-02-coze-codeg-cumora-competitive-analysis.md) P0-1 / [持久化角色资产设计](persistent-role-assets.md) §9 接口预留
> 前置依赖：PR #204（持久化角色资产）已于 2026-06-03 合并
> 决策记录：见 §11（2026-06-03 与林晨确认）

---

## 1. 背景与定位

### 1.1 要解决的问题

PR #204 给了角色"户口"（持久记忆 + 履历），但角色仍然是**纯被动**的：只有用户发消息才动。竞品分析指出这是 cowork 和 chatbot 的分水岭——"协作者"和"工具"的区别就在于会不会主动（Cumora："你停止说话，你的团队还在思考"；Slock：agent 给自己设提醒、自己管理时间）。

### 1.2 核心表述（产物中心修正版）

**主动性不是"agent 主动找你聊天"，而是"产物在你不在的时候继续变好，并把变化告诉你"。主动性的载体是产物迭代，不是消息。**

### 1.3 核心循环

```
定时/事件触发 → 角色带记忆醒来 → 检查自己履历里的产物 → 四选一决策 → 写回履历 → 实例销毁
                                                          ├── 继续推进任务
                                                          ├── 汇报发现
                                                          ├── 提出建议
                                                          └── 保持沉默（合法结果，借 Slock 设计）
```

持久的是资产，瞬时的是实例——与 PR #204 的"户口 vs 上班"模型完全一致，cadence 触发只是换了一个打卡方式。

---

## 2. 触发器设计（两个入口，同一循环）

### 2.1 入口 A：cadence 定时触发（本期主体）

**调度层复用 cron 基础设施**（croner + SQLite 持久化 + 已有执行历史/UI），不另造定时器：

```
应用启动 → roleProactivityService.syncCadenceJobs()
         → 扫描所有持久化角色的主动性配置（§4）
         → 为每个非静默角色注册/更新一个 cron job（tag: role-cadence，幂等，参考 memory-consolidation 模式）
         → cron 到点 → 执行 role-wake action → 进入核心循环
```

**新增 cron action 类型 `role-wake`**（与 `memory-consolidation` 同级的内部 action）：

```typescript
export interface RoleWakeAction {
  type: 'role-wake';
  roleId: string;
}
```

不复用 `AgentAction` 的原因：AgentAction 是"拉起 agent 跑一段 prompt"，role-wake 是"完整的醒来循环"（记忆注入 → 检查产物 → 预算护栏 → 四选一 → 写回 → 推送），逻辑应该收在 roleProactivityService 里，cron 层只负责到点调用。

### 2.2 入口 B：长任务跑完触发（复用同一循环）

挂在 **Stop hook**（agent 即将停止响应）：

```
主会话 run 结束 → Stop hook 触发 → 满足条件则 fire-and-forget 调 wakeRole(roleId, 'event')
```

触发条件（全部满足）：
1. 本次 run 中 spawn 过持久化角色子代理（从 run 期间的 spawn 记录判断）
2. run 达到"长任务"门槛：turn 数 ≥ `LONG_TASK_MIN_TURNS`（默认 5，进 constants）
3. 该角色当天醒来次数未超预算（§6）

醒来的角色拿到 run 的最终输出作为额外上下文，产出"总结 + next steps"，走同一条推送链路。

### 2.3 Hook 系统扩展：RoleWake 事件

Hook 事件 union 加 `RoleWake`（experimental）：角色每次醒来时 fire，用户可以在 hooks 配置里挂自己的 command/http hook（例如转发到自己的通知系统）。这是竞品分析说的"Hook 系统加第 5 类触发器"的落点——**调度由 cron 承担，Hook 系统承担的是醒来事件的可扩展性**。

---

## 3. 醒来循环详细设计

`roleProactivityService.wakeRole(roleId, trigger, context?)` 的执行步骤：

| 步骤 | 做什么 | 失败处理 |
|------|--------|---------|
| 1. 预算检查 | 当天该角色醒来次数 ≥ 上限 → 记录 skipped，直接返回 | 不算失败 |
| 2. 实例化 | `instantiateRole(roleId, 'cadence'\|'event', ctx)` → 拿到角色记忆 + 履历注入块 | 角色不存在/非持久化角色 → 记录 error 返回 |
| 3. 创建会话 | `sessionManager.createSession({ type: 'schedule', origin: { kind: 'cron', name: 'role-cadence', metadata: { roleId, trigger } } })`，标题"<角色名> · 主动巡检 MM-DD HH:mm" | 异常向上抛，cron 执行记录标 failed |
| 4. 跑实例 | 双路径（§3.3）跑醒来 prompt（§3.1），maxIterations 上限硬约束 | 超时/异常 → 会话保留（可排查），履历记一条失败 |
| 5. 解析结果 | 从最终输出解析四选一决策标记（§3.2） | 解析不出 → 按"汇报发现"处理（保守） |
| 6. 沉默处理 | 决策=沉默 → 会话归档（不出现在默认列表），履历记一行"巡检无需行动" | — |
| 7. 推送 | 非沉默 → 会话留在列表 + SESSION_LIST_UPDATED 通知 + （实时档）桌面通知 | — |
| 8. 写回 | 调已有 `runRoleWriteBack()`（quick model 判断 + write gate），履历追加本次醒来记录 | 写回失败不影响推送 |

### 3.1 醒来 prompt 结构

```
<role_assets>…（instantiateRole 生成的记忆+履历注入块，现成积木）…</role_assets>

你被定时唤醒（触发方式：cadence/event）。这不是用户发来的消息，用户现在不在。
你的任务：
1. 读你的工作履历（上面注入块里），找出你经手过的产物
2. 逐个检查这些产物的现状（文件还在吗、内容有没有需要跟进的）
3. 四选一决策并执行：
   - 【推进】产物有明确的下一步且你能独立完成 → 直接做，做完汇报
   - 【汇报】发现了值得用户知道的变化/问题 → 写简报
   - 【建议】有改进想法但需要用户拍板 → 列出建议
   - 【沉默】检查完没有值得说的 → 输出 <decision>silence</decision> 结束
4. 输出末尾必须带决策标记：<decision>advance|report|suggest|silence</decision>
预算约束：你最多有 N 轮工具调用，超出会被强制结束，重要的事先做。
```

### 3.2 四选一的判定

从实例最终输出提取 `<decision>` 标记。提取不到时保守处理为"汇报"（宁可多打扰一次，不能把有产出的醒来静默掉）。决策值记入履历和 cron 执行记录，便于后续统计"这个角色醒了 10 次有 8 次沉默"→ 用户调低频率。

### 3.3 执行双路径与 workspace 解析（实现期补充，2026-06-03 E2E 实测）

醒来实例的执行链路按运行环境二选一：

| 环境 | 执行路径 | 说明 |
|------|---------|------|
| Electron main | TaskManager orchestrator（`getOrCreateCurrentOrchestrator`） | 带 UI 事件路由 / 权限弹窗，角色定义通过 agentOverrideId 路由 |
| webServer / headless（**发行版后端**） | cli/bootstrap `createAgentLoop`（与 /api/run 同源） | TaskManager 在此环境拿不到 orchestrator；角色 system prompt + 记忆注入块通过 config.systemPrompt 附加；工具集用默认全集（角色 tools 白名单暂不生效） |

醒来实例的 workspace 解析链（**不能落到 process.cwd()**——那是应用安装目录，角色会跑去巡检应用自己的代码）：

```
显式传入（event 触发带 source session 的）> 当前会话 workingDirectory
> CODE_AGENT_WORKING_DIR > 用户工作区偏好（pinned / recent / default）
```

---

## 4. 配置设计（决策 #4：每角色配置 + 全局兜底）

### 4.1 三级配置优先级

```
settings.json 的 per-role 覆盖   >   角色 frontmatter 的 proactivity 字段   >   全局默认值
（用户在 UI/设置里改，最高优先）      （角色定义自带）                        （settings.defaultLevel > constants）
```

### 4.2 主动等级（决策：默认每日简报）

| 等级 | cadence | 推送行为 |
|------|---------|---------|
| `silent` 静默 | 不注册 cron job，事件触发也跳过 | 无 |
| `daily` 每日简报（**默认**） | 每天 1 次（默认 09:00） | 会话消息 + 履历 |
| `realtime` 实时介入 | 角色自定义 cron 表达式（受预算上限约束） | 会话消息 + 履历 + 桌面通知 |

### 4.3 配置形态

角色 frontmatter（agents/<id>.md，PR #204 已有解析链路；扁平 key 适配现有 simple YAML parser，与 `max-iterations` 同风格）：

```yaml
---
name: 研究员
description: …
proactivity-level: daily            # silent | daily | realtime
proactivity-cadence: "0 0 9 * * *"  # 可选，不填用等级默认
---
```

settings.json 覆盖（用户级，UI 后续接）：

```json
{
  "roleAssets": {
    "proactivity": {
      "defaultLevel": "daily",
      "roles": { "研究员": { "level": "realtime", "cadence": "0 0 */6 * * *" } }
    }
  }
}
```

---

## 5. 结果推送设计（决策 #3：会话消息 + 履历）

1. **会话列表**：每次非沉默醒来产生一个 `type: 'schedule'` 会话，出现在会话列表（cron agent 会话的现成机制），用户可点开看全过程、可直接回复继续对话
2. **角色履历**：每次醒来（含沉默）在 `roles/<id>/history.md` 追加一条：时间 + 触发方式 + 决策 + 产出摘要（现成积木 appendRoleHistory）
3. **桌面通知**：仅 `realtime` 档，用 Electron Notification，点击跳转对应会话
4. **会话列表刷新**：复用 `notifySessionListUpdated()`（desktop IPC 已有）；web 路径的 SSE 通知缺口是存量 bug（memory 已记录），本期 E2E 用轮询会话列表验证，不阻塞

---

## 6. 预算护栏（决策 #5：15 轮/次 + 4 次/天）

全部进 `src/shared/constants/memory.ts` 的新 `ROLE_PROACTIVITY` 块，禁止散落硬编码：

```typescript
export const ROLE_PROACTIVITY = {
  /** 单次醒来最大工具调用轮数（硬约束，传给 orchestrator maxIterations） */
  WAKE_MAX_ITERATIONS: 15,
  /** 每角色每天最多醒来次数（cadence + event 合计） */
  MAX_WAKES_PER_DAY: 4,
  /** 长任务门槛：run 达到这个 turn 数才触发事件醒来 */
  LONG_TASK_MIN_TURNS: 5,
  /** 默认每日简报的 cron 表达式（09:00） */
  DAILY_BRIEF_CRON: '0 0 9 * * *',
  /** cadence cron job 的幂等 tag */
  CADENCE_JOB_TAG: 'role-cadence',
  /** 醒来会话标题前缀等 */
  ...
} as const;
```

当天醒来次数的统计来源：cron 执行记录（cadence 触发）+ 履历条目（event 触发），按角色 + 当天日期过滤。

---

## 7. 技术接入点清单

| 模块 | 改动 | 文件 | 新建/修改 |
|------|------|------|----------|
| 主动性服务 | **新建** roleProactivityService：syncCadenceJobs / wakeRole / 预算检查 / 决策解析 | `src/main/services/roleAssets/roleProactivity.ts` | 新建 |
| 实例化入口 | `instantiateRole()` 实现 'cadence' / 'event' 路径（去掉 throw） | `src/main/services/roleAssets/roleAssetService.ts` | 修改 |
| cron action | 加 `RoleWakeAction` 类型 + cronService 执行分支 | `src/shared/contract/cron.ts` + `src/main/cron/cronService.ts` | 修改 |
| cron 注册 | 应用启动时 syncCadenceJobs（参考 memory-consolidation 注册模式） | `src/main/app/initBackgroundServices.ts` | 修改 |
| Hook 事件 | HookEvent union 加 `RoleWake`（experimental）+ hookManager.triggerRoleWake() | `src/main/protocol/events/hookTypes.ts` + `src/main/hooks/hookManager.ts` + `configParser.ts` | 修改 |
| 长任务触发 | Stop hook 链路里判断长任务 + 角色参与 → fire wakeRole('event') | Stop hook 触发点（messageProcessor / runFinalizer，实现时定位） | 修改 |
| 角色配置 | frontmatter 解析 proactivity-level / proactivity-cadence（扁平 key） | `src/main/agent/hybrid/agentMdLoader.ts` + `types.ts` | 修改 |
| settings | AppSettings.roleAssets.proactivity 类型 | `src/shared/contract/settings.ts` + `roleAssets.ts` | 修改 |
| 常量 | ROLE_PROACTIVITY 块 | `src/shared/constants/memory.ts` | 修改 |
| 桌面通知 | realtime 档的 Electron Notification（headless 环境静默跳过） | roleProactivity.ts 内部 | — |
| **webServer 路径** | 步骤 7：initCronService + syncCadenceJobs（发行版后端必须，§3.3） | `src/web/webServer.ts` | 修改 |
| **headless 执行** | CLIConfig.maxIterations 透传 + createAgentLoop 接线（§3.3 双路径） | `src/cli/types.ts` + `src/cli/bootstrap.ts` | 修改 |
| **event 触发接线** | recordRoleParticipation（子代理结束）+ triggerEventWakes（run 收尾） | `src/main/agent/subagentExecutor.ts` + `runtime/runFinalizer.ts` | 修改 |
| **运行选项** | AgentRunOptions.maxIterations → AgentLoop | `src/main/research/types.ts` + `agentOrchestrator.ts` | 修改 |

注：以上为实际实现的接入点清单（2026-06-03 实现完成后回填）。

---

## 8. MVP 范围（本期实现）

**做**：
1. roleProactivityService：wakeRole 完整循环（§3 八步）
2. cadence 入口：role-wake cron action + 启动时同步注册
3. event 入口：长任务跑完触发同一循环
4. 配置三级优先级 + 默认每日简报档
5. 预算护栏（轮数 + 次数）
6. 结果推送：会话 + 履历 + realtime 档桌面通知
7. RoleWake hook 事件（fire 即可，不做 UI）

**不做（明确边界）**：
- 飞书等外部 channel 推送（P1-1 的事）
- 主动等级的设置 UI（settings.json 手改 + frontmatter 即可用，UI 下期）
- 扫整个 workspace 的变化检查（P0-2 项目空间落地后升级为项目维度）
- 多角色协同醒来（A 角色醒来叫醒 B 角色）
- web 路径 SSE 会话通知补齐（存量 bug，单独修）

---

## 9. E2E 验收标准与结果（2026-06-03 验收完成）

脚本：`scripts/acceptance/role-proactivity-e2e.ts`（假 HOME 隔离 + webServer headless，模型 xiaomi/mimo-v2.5-pro）
单测：`tests/unit/services/roleAssets/roleProactivity.test.ts`（14 条确定性覆盖）

| # | 场景 | E2E 结果 | 备注 |
|---|------|---------|------|
| AC1 | 启动同步注册：每个持久化角色一个 [Cadence] cron job | ✅ PASS | 确定性，零模型成本 |
| AC2 | cadence 醒来闭环：预埋产物 → 触发 → 决策标记 → 履历 → 会话落地可见 | ✅ PASS（两轮） | 真实模型全链路 |
| AC3 | 沉默路径：空履历 → 空产物守卫确定性静默 → 履历"巡检无需行动" → 不建会话 | ✅ PASS | 确定性，零模型成本 |
| AC4 | 预算护栏：当天 4 次上限 → 第 5 次 skipped | ✅ PASS | 确定性，零模型成本 |
| AC5 | event 触发：长任务跑完 → 参与角色自动醒来 | ⚠ E2E 未过 → **单测覆盖** | 见下 |

**AC5 说明**：全链路 E2E 依赖模型 spawn compliance（要求模型把任务委派给"研究员"角色），mimo 实测 3 轮中 2 轮自作主张换成内置 explore 类型、1 轮迭代数未达长任务门槛——失败都来自模型行为而非代码。event 链路的各组件验证：
- `wakeRole('event')` 与 AC2 验证过的是同一函数 ✅
- `runFinalizer → triggerEventWakes` 调用链在 E2E 日志中确认执行 ✅
- `recordRoleParticipation → 过滤 → 唤醒` 胶水逻辑由单测确定性覆盖（含持久化过滤/防递归/门槛清理）✅

---

## 10. 风险与开放问题

| 风险 | 应对 |
|------|------|
| 醒来实例烧 token 但产出全是沉默 → 用户觉得浪费 | 履历记录决策分布；默认每日 1 次上限低；后续按沉默率自动建议调频 |
| 角色"推进"时改坏产物（无人监督的写操作） | MVP 限制：推进路径只允许在角色自己 workspace 产物上工作；写文件类工具走现有权限体系 |
| cron 到点时应用没开着（Electron 不在线） | croner 仅进程内调度，错过就错过；下次启动 syncCadenceJobs 不补跑（避免开机风暴）。文档明确这是桌面应用的合理边界 |
| 醒来会话堆积污染会话列表 | 沉默自动归档；标题带角色名+日期可识别；后续可加"主动会话"过滤器 |
| 决策标记解析失败 | 保守处理为"汇报"；prompt 中强约束输出格式 |
| Stop hook 触发 event 醒来形成递归（醒来会话自己又触发 Stop） | wakeRole 创建的会话标记 origin=role-cadence，Stop hook 链路对此类会话不再触发 event 醒来 |

---

## 11. 决策记录（2026-06-03，与林晨确认）

| # | 决策点 | 结论 | 备注 |
|---|--------|------|------|
| 1 | 代码基座 | PR #204 先合并，从合并后 origin/main 开工 | 已执行，merge commit 4c8df85a |
| 2 | MVP 切口 | cadence 定时 + 长任务跑完，两个入口都做 | 共用同一核心循环，边际成本低 |
| 3 | 结果推送 | 会话新消息为主 + 角色履历自动记录；桌面通知仅 realtime 档 | 飞书通道等 P1-1 |
| 4 | 配置粒度 | 每角色独立配置 + 全局默认兜底 | 默认每日简报档 |
| 5 | 检查范围 | 只看自己履历里的产物 | 与 Cumora/Slock"只看自己参与的容器"边界一致；P0-2 后升级项目维度 |
| 6 | 预算上限 | 单次 15 轮工具调用 + 每角色每天 4 次 | 数值进 constants，可调 |
