# 原生上下文 + 办公连接之后的下一阶段计划

> 实施进展：桌面活动记忆/理解层 MVP 已继续落地，现已具备
> `desktop raw events -> summary / todo candidate / semantic search / session task sync / planning bridge / lifecycle feedback / plan step metadata / snooze-supersede controls / unified workspace retrieval / session-start workspace context injection / basic relevance-budget gating / office artifacts persisted as workspace_activity memories / workspace_artifact vector index / mail body + attachment + thread enrichment / reminder notes enrichment / calendar description enrichment / retrieval-layer cross-artifact merge`
> 的最小闭环，见
> `docs/analysis/2026-03-14-desktop-activity-memory-mvp.md`

> 新增说明：这意味着“统一落库/统一索引”的最小版已经补上，并且 mail 正文摘要、attachments、thread metadata、reminder notes、calendar description/url 已开始进入索引；检索层也有了最小 cross-artifact merge，但范围仍然只到轻量 artifact 层，还没有文档级索引和更强的实体级 merge。

## 1. 结论

当前阶段的主线不应是先做一轮“大而全”的原生层稳定化，而应按下面顺序推进：

1. 修复仓库基线问题，恢复 `typecheck` 通过。
2. 做真机端到端验收，确认 `collector`、`Mail`、`Calendar`、`Reminders` 在真实 macOS 环境可用。
3. 补齐写操作确认门，尤其是 `send` / `delete`。
4. 直接开启记忆/理解层 MVP，把原始桌面事件转成摘要、待办、搜索结果、日报。
5. 产品/编排层放到最后，基于前面三层已经稳定输出的能力再组织为长期运行助手。

这是“先把可信输入和可信写操作打牢，再把理解层做出来”的路线，而不是继续停留在“只会采集原始事件”的状态。

---

## 2. 当前状态判断

### 2.1 已完成的部分

#### 原生上下文层 MVP

- 已有后台 collector，而不是单次快照。
- 已有前台应用、窗口、浏览器 URL、文档路径、session 状态、电源状态采集。
- 已有 JSONL + SQLite 双落盘。
- 已有去重、截图、截图脱敏、retention 清理。

相关实现：

- `src-tauri/src/native_desktop.rs`
- `src/main/services/nativeDesktopService.ts`
- `src/main/tools/memory/desktopActivity.ts`
- `src/renderer/components/features/settings/sections/NativeDesktopSection.tsx`

#### 办公连接层 MVP

- 已有 Mail / Calendar / Reminders 的 native connector。
- 已有 create / update / delete / draft / send 等工具暴露。

相关实现：

- `src/main/connectors/native/mail.ts`
- `src/main/connectors/native/calendar.ts`
- `src/main/connectors/native/reminders.ts`
- `src/main/tools/connectors/*.ts`

#### 确认门框架

- 已有确认门类型、preview 构建、UI 预览组件、配置恢复。
- 但还没有把“按动作类型精细确认”的策略真正打通到连接器场景。

相关实现：

- `src/main/agent/confirmationGate.ts`
- `src/main/tools/toolExecutor.ts`
- `src/shared/types/confirmation.ts`
- `src/renderer/components/PermissionDialog/RequestDetails.tsx`

#### 记忆基础设施

- 已有 embedding、vector store、hybrid search、session summary、memory service。
- native desktop collector 已接入这套能力，能够产出 summary / todo candidate / semantic search。
- mail / calendar / reminders 也已补上最小统一落库/统一索引：
  - `workspace_activity` memories
  - `workspace_artifact` vector index
  - `workspace_activity_search` / `workspace-activity-context`

相关实现：

- `src/main/memory/embeddingService.ts`
- `src/main/memory/localVectorStore.ts`
- `src/main/memory/hybridSearch.ts`
- `src/main/memory/sessionSummarizer.ts`
- `src/main/memory/memoryService.ts`

### 2.2 还没完成的核心缺口

#### 基线问题

`npm run typecheck` 当前仍有两处阻塞：

1. `src/main/agent/runtime/contextAssembly.ts`
   - `toolError` 被写入消息对象，但 `src/main/agent/loopTypes.ts` 的 `ModelMessage` 没有该字段。
2. `src/main/services/core/secureStorage.ts`
   - `electron-store` 缺失依赖或类型声明。

#### 真机验收缺口

- 还没有针对 `collector`、`mail draft/send`、`calendar create/update/delete`、`reminders create/update/delete` 的系统真机验收记录。
- 仓库里目前也没有对应的 acceptance scripts / checklist。

#### 写操作确认门缺口

- `ConfirmationGate` 的 `shouldConfirm()` / `recordApproval()` 没有接进主决策路径。
- `DANGEROUS_TOOLS` 仍只覆盖 `bash` / `write_file` / `edit_file`，没有覆盖：
  - `mail_send`
  - `calendar_delete_event`
  - `reminders_delete`
- 连接器写操作没有专门的 preview builder。
- `mail_draft` 工具层 schema 还没暴露 `attachments`。

#### 记忆/理解层缺口

native desktop raw events 的最小闭环已经补上，office artifacts 也已有轻量索引层；当前仍然缺的是：

- 文档级索引
- 更强的 desktop + office cross-artifact entity resolution / persistent merge
- daily report / focus trend / 跨天聚合
- 更系统的 prompt budget orchestration
- 真机端到端验收与索引治理

---

## 3. 本阶段的总原则

### 原则 A：先解决“可信性”，再解决“智能性”

理解层输出必须建立在两件事之上：

- 输入可信：collector 和办公连接器在真机环境稳定。
- 写操作可信：send / delete 有统一确认门和审计。

### 原则 B：不先做“大稳定化工程”

原生层目前已经足够作为理解层的 raw input。
稳定化工作只处理真机验收暴露出来、会直接阻塞理解层 MVP 的问题。

### 原则 C：理解层 MVP 只做衍生层，不重写底座

不改造 collector 的主链路来承载复杂理解逻辑。
MVP 应基于现有 raw events 增加 app-side 派生处理层：

- slice
- enrich
- extract
- index
- report

当前这条原则已验证可行：

- desktop 走 `desktop_activity`
- office artifacts 走 `workspace_activity`
- 两者都复用现有 `memories + vectorStore + runtime context` 结构

### 原则 D：所有“会真实发出/删除”的动作一律视为高风险

`send` / `delete` 不应共享当前文件写入工具的默认策略，必须独立分级。

---

## 4. 执行顺序

## Phase 0：修基线

### 目标

恢复代码库最基本的工程健康，让后续验收和实现都建立在可验证基线上。

### 任务

1. 修复 `ModelMessage` 类型不一致。
2. 处理 `electron-store` 依赖问题。
3. 跑通 `npm run typecheck`。
4. 补一个最小 smoke，确保 connector registry / desktop service / permission preview 不会在空环境直接崩。

### 完成标准

- `npm run typecheck` 通过。
- 相关改动无新增 TS 错误。
- 至少有一条最小 smoke 路径可跑。

### 预计时长

0.5 - 1 天

---

## Phase 1：真机端到端验收

### 目标

验证当前 MVP 在真实 macOS 机器上的可用性，避免在未验收的前提下直接叠加理解层。

### 验收范围

#### A. 原生 collector

验收项：

- 权限探测可读。
- collector 可启动、停止、重启。
- 至少连续运行 30 分钟。
- 最近事件可在 UI 看到。
- SQLite 持续写入。
- URL / document path / session state / battery state 有真实采样。
- sensitive context 时截图不落盘或被正确脱敏。
- retention 清理至少验证一次。

建议产物：

- `docs/acceptance/native-desktop-acceptance.md`
- `scripts/acceptance/native-desktop-smoke.ts`

#### B. Mail

验收项：

- 草稿创建成功。
- 草稿附件成功。
- 真实发送成功。
- 发送后在 Mail 的已发送中可见。

建议产物：

- `docs/acceptance/mail-connector-acceptance.md`
- `scripts/acceptance/mail-smoke.ts`

#### C. Calendar

验收项：

- 在测试日历中创建事件。
- 更新事件标题 / 时间 / 地点。
- 删除事件。
- 使用专用测试 calendar，避免污染正式数据。

建议产物：

- `docs/acceptance/calendar-connector-acceptance.md`
- `scripts/acceptance/calendar-smoke.ts`

#### D. Reminders

验收项：

- 在测试 list 中创建 reminder。
- 更新 title / notes / completed / remind time。
- 删除 reminder。

建议产物：

- `docs/acceptance/reminders-connector-acceptance.md`
- `scripts/acceptance/reminders-smoke.ts`

### 完成标准

- 以上 4 条链路均有“真机验收记录”。
- 所有失败项都进入 known issues 列表，而不是口头遗留。
- 对测试数据有隔离策略：
  - 测试邮件收件地址
  - 测试 calendar
  - 测试 reminders list

### 预计时长

2 - 3 天

---

## Phase 2：写操作确认门

### 目标

把“会真实改变外部世界”的动作纳入统一确认门，特别是 `send` / `delete`。

### 当前问题

1. `ConfirmationGate` 已存在，但目前主要只负责 preview 构建。
2. `toolExecutor` 仍是“需要权限就直接 requestPermission”，没有真正走确认门策略决策。
3. 连接器工具没有专门动作分级。
4. `send` / `delete` 没有专用 preview。

### 设计要求

#### A. 动作分级

建议引入 connector action 风险分级：

- `read`: 低风险
- `draft`: 中风险
- `create`: 中风险
- `update`: 中风险
- `send`: 高风险
- `delete`: 高风险

#### B. 默认策略

- `mail_send`: `always_ask`
- `calendar_delete_event`: `always_ask`
- `reminders_delete`: `always_ask`
- `mail_draft`: 可沿用 `ask_if_dangerous` 或 `session_approve`
- `calendar_create_event` / `calendar_update_event`: 中风险，可首轮确认后 session approve
- `reminders_create` / `reminders_update`: 中风险，可首轮确认后 session approve

#### C. 专用 preview

至少补以下 preview builder：

- `mail_draft`
  - subject / to / cc / bcc / attachments
- `mail_send`
  - subject / to / cc / bcc / attachments
- `calendar_create_event`
  - calendar / title / start / end / location
- `calendar_update_event`
  - 原值 vs 新值（如能读取则显示 diff，否则至少显示新值）
- `calendar_delete_event`
  - calendar / title / uid
- `reminders_create`
  - list / title / notes / remind time
- `reminders_update`
  - 原值 vs 新值
- `reminders_delete`
  - list / title / id

#### D. 审计

所有高风险写操作至少记录：

- request summary
- approval result
- approved at
- session id
- tool name
- final execution result

### 明确补丁点

- `src/main/agent/confirmationGate.ts`
- `src/main/tools/toolExecutor.ts`
- `src/shared/types/confirmation.ts`
- `src/renderer/components/PermissionDialog/RequestDetails.tsx`
- `src/main/tools/connectors/*.ts`

### 顺手修复

`mail_draft` 工具层补 `attachments` schema 与输出。

### 完成标准

- `send` / `delete` 必须弹出高质量确认卡片。
- `session_approve` 对中风险写操作生效。
- `send` / `delete` 默认不允许自动 session 放过。
- 审计日志中能看到审批结果。

### 预计时长

2 - 4 天

---

## Phase 3：记忆/理解层 MVP

### 目标

把原始桌面事件变成真正可消费的理解产物，而不是停留在 `recent/timeline/search`。

### MVP 边界

本阶段只做 4 个核心能力：

1. 时间片摘要
2. 待办提取
3. 活动语义搜索
4. 日报

以下内容不进入首版主目标：

- 完整审批中心
- 托盘 / 浮窗
- 全自动工作流建议闭环
- 多办公平台扩展（Feishu / Notion）

### 推荐架构

#### A. Raw events 保持不动

继续由 `src-tauri/src/native_desktop.rs` 负责采集和落盘。

#### B. 新增 app-side 派生层

建议新增以下服务：

- `src/main/memory/desktopActivitySlicer.ts`
  - 把连续 raw events 聚合为 `activity_slice`
- `src/main/memory/desktopActivityEnricher.ts`
  - 处理 screenshot OCR / vision enrichment
- `src/main/memory/desktopActivityUnderstandingService.ts`
  - 生成 slice summary / todo candidates / daily report
- `src/main/memory/desktopActivityIndexer.ts`
  - 将 slice 送入 embedding + hybrid search

#### C. 新增理解产物

建议定义 4 类派生实体：

- `activity_slice`
  - 时间范围内的活动块
- `activity_summary`
  - 对应 slice 的摘要
- `activity_todo_candidate`
  - 从 slice 中提取的待办候选
- `daily_report`
  - 面向“今天做了什么”的日报结果

#### D. 持久化策略

MVP 不建议先改 Rust 侧 schema version / migration 体系。
优先做法：

- raw events 继续落在 native desktop SQLite
- 派生产物存到现有 app-side DB / vector store
- 通过 event id / fingerprint / captured_at_ms 建立引用

这样可以避免 Phase 3 被 Rust schema 演进拖慢。

### 功能拆解

#### 3.1 时间片摘要

输入：

- 某时间窗口内的 desktop raw events

输出：

- 每个 `activity_slice` 的摘要
- slice 内主要 app / url / title / document / duration

规则：

- 连续相同 app / 相近 fingerprint 聚合
- 长 idle / locked 事件切断 slice

#### 3.2 待办提取

输入：

- `activity_slice`
- 可选 OCR / vision 结果

输出：

- todo candidates

提取源：

- Mail 主题 / 正文上下文
- Calendar 标题
- Reminder 内容
- Browser page title / document path / screenshot OCR

首版要求：

- 只做候选提取，不直接写回系统 Reminders
- 先给用户确认或展示在 UI

#### 3.3 活动语义搜索

当前 desktop search 还是关键词匹配。
MVP 需要升级为对 `activity_slice` 做 embedding + hybrid search。

典型查询：

- “我昨天在哪个页面看过某篇文章”
- “我前天什么时候在处理预算表”
- “我最近和招聘相关的活动”

首版做法：

- 索引对象是 `activity_slice.summary + salient fields`
- 复用现有 `embeddingService` + `localVectorStore` + `hybridSearch`

#### 3.4 日报

首版日报输出：

- 今天做了什么
- 主要应用 / 页面 / 文档
- 明显产出
- 待办候选
- 未完成事项

要求：

- 每段日报都能引用回底层 slice / raw event
- 避免纯幻觉总结

### OCR / 视觉理解策略

不要把 OCR/vision 放进 collector 主循环。

建议：

- 只在以下情况异步 enrich：
  - 没有 URL
  - 没有 document path
  - 仅 screenshot 有信息
  - 用户明确请求更深分析
- 优先走低频、异步、可缓存。

### 完成标准

- 给定最近 1 小时或 1 天的原始事件，可生成 slice summary。
- 至少能提取一组 todo candidates。
- 至少有一个 `desktop_activity_semantic_search` 或等价查询路径。
- 可生成一份带引用的日报。

### 预计时长

1 - 2 周

---

## 5. 决策门：Phase 2 后是否插入“原生层稳定化 Sprint”

默认策略：

- Phase 2 完成后，直接进入 Phase 3。

只有满足以下任一条件，才插入“原生稳定化 Sprint”：

1. collector 在 6 - 12 小时真机运行中频繁丢事件。
2. 锁屏 / 唤醒 / 睡眠缺失明显影响 slice 切分质量。
3. sensitive context 误采集风险不可接受。
4. 落盘恢复、重启恢复、路径恢复有明显不稳定问题。

如果这些问题没有显著阻塞理解层 MVP，就不要单独开“稳定化大全套”。

---

## 6. 延后项

以下工作明确延后，不放进下一阶段主线：

### 原生上下文层延后项

- sidecar / LaunchAgent 常驻
- 更完整的睡眠 / 唤醒 / 锁屏事件监听
- 项目 / 工作区级文件上下文增强
- SQLite schema version / migration 体系
- 更完整 retention / 恢复机制

### 办公连接层延后项

- 统一凭据管理
- Feishu
- Notion
- 更多网页登录态办公系统

### 产品/编排层延后项

- 托盘 / 浮窗
- cron / 定时任务
- 事件触发
- 审批中心完整产品化
- 失败重试系统
- 统一活动页 / 搜索页 / 记忆页

---

## 7. 里程碑视图

### M0：基线恢复

- `typecheck` 通过

### M1：真机验收完成

- collector / Mail / Calendar / Reminders 均有验收记录

### M2：写操作确认门完成

- send / delete 已接入高风险确认门

### M3：理解层 MVP 可用

- 时间片摘要 / 待办提取 / 语义搜索 / 日报 跑通

### M4：再评估产品层

- 基于真实使用频率与误报率，决定是否做审批中心、托盘、自动编排

---

## 8. 建议的第一批实际提交顺序

建议按下面顺序拆 commit：

1. `fix: restore typecheck baseline for model message and secure storage`
2. `test: add real-device acceptance checklist for native desktop and connectors`
3. `feat: wire confirmation gate policies into connector write actions`
4. `feat: add connector-specific confirmation previews for send and delete`
5. `feat: add desktop activity slicing and derived summaries`
6. `feat: add desktop activity semantic search and daily report mvp`

---

## 9. 一句话总结

下一阶段不是继续堆原始采集能力，而是按“基线修复 -> 真机验收 -> 写操作确认门 -> 记忆/理解层 MVP”的顺序，把现有原生上下文层和办公连接层变成一个既可信、又开始真正有理解输出的系统。
