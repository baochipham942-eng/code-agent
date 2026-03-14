# 桌面活动记忆/理解层 MVP 实施记录

日期：2026-03-14

## 1. 这次实际补了什么

这次没有继续扩 connector/approval 主线，而是在现有 native desktop collector 之上补了一条最小可交付的记忆/理解链路：

1. `desktop activity raw events -> 30 分钟时间片`
2. `时间片 -> 可落库的 activity_summary`
3. `时间片 -> 可落库的 activity_todo_candidate`
4. `activity_summary -> vectorStore 检索入口`
5. `activity_summary / activity_todo_candidate -> agent session context`
6. `activity_todo_candidate -> session task store`
7. `desktop-derived tasks -> PlanningService 最小桥接`
8. `task/plan 完成或忽略 -> activity_todo_feedback`
9. `planning step metadata -> desktopTodoKey`
10. `desktop todo -> accepted / snoozed / superseded / reopened`
11. `desktop summary + mail/calendar/reminders -> workspace_activity_search`
12. `workspace_activity_search -> session-start workspace-activity-context`
13. `workspace-activity-context -> relevance + token budget gating`
14. `mail/calendar/reminders -> workspace_activity memories`
15. `workspace_activity memories -> vectorStore workspace_artifact index`
16. `mail read_message(content) / reminder notes -> content-level artifact enrichment`
17. `calendar description/url -> content-level artifact enrichment`
18. `mail attachments + thread metadata -> content-level artifact enrichment`
19. `workspace retrieval -> cross-artifact dedupe / merge`

落库位置：

- SQLite `memories` 表
  - `type = desktop_activity`
  - `category = activity_summary`
  - `category = activity_todo_candidate`
  - `type = workspace_activity`
  - `category = mail_message`
  - `category = calendar_event`
  - `category = reminder_item`
- 向量索引：
  - `vectorStore` 中 `source = knowledge`
  - `category = activity_summary`
  - `vectorStore` 中 `source = knowledge`
  - `category = workspace_artifact`

## 2. 当前推进到哪一层

### 已补到：记忆/理解层 MVP

已经从“只能读 raw desktop events”推进到“能产出派生理解结果”：

- 有时间片摘要
- 有待办候选
- 有语义检索入口
- 有后台定时刷新
- 有工具读取入口
- 有 agent 启动时的上下文注入和待办合并
- 有 desktop-derived follow-up 自动同步到 session task store
- 有 desktop-derived task 到 `PlanningService` 的最小 phase/step 桥接
- 有最小 lifecycle feedback，`accepted / snoozed / superseded / completed / dismissed / reopened` 已接通
- plan step 已携带 `desktopTodoKey`，后续 plan 反馈不再只靠标题匹配
- 有一个最小统一检索入口，可在单一工具中读取 desktop summaries + 本地 mail/calendar/reminders
- agent 在复杂任务启动时，会按当前用户请求自动注入一段 `workspace-activity-context`，把相关 desktop + office 线索带进上下文
- `workspace-activity-context` 已增加最小 relevance / diversity / token budget gating，避免把弱相关线索整段塞进 prompt
- office artifacts 已有最小统一落库/统一索引链路，可按后台刷新写入 `workspace_activity` memories，并同步进入 `vectorStore` 供统一检索复用
- mail artifacts 已开始读取 `read_message` 正文并写入截断后的 `bodyPreview`；reminder artifacts 已开始读取 `notes/body` 并写入 `notesPreview`，统一检索已不再只依赖标题层字段
- calendar artifacts 已开始读取 `description` / `url` 并写入截断后的 `notesPreview`，统一索引不再只停留在 title/time/location
- mail artifacts 已开始写入 `attachmentCount / attachmentNames / threadKey / threadSubject`，为后续按邮件线程和附件线索做 merge / dedupe 留出最小结构
- `workspaceActivitySearchService` 已开始在检索层对相关 office artifacts 做最小 `cross-artifact dedupe / merge`，把同一 query / thread 下的 mail、calendar、reminder 线索压成单条结果，同时保留底层来源统计

### 已开始触到：产品/编排层输入

这次仍然不是完整产品编排层，但已经不只是“理解产物可读”：

- desktop 推断待办可以进入 `taskStore`
- 并且能继续落到 `PlanningService` 的恢复 phase/steps
- 现有 plan context 注入链路可以直接消费这批恢复步骤

### 还没补：产品/编排层

本次没有做：

- 把 desktop-derived tasks 进一步并入完整的 plan DAG / 生命周期管理
- 日报/周报生成
- 跨 desktop + office connector 的统一工作流编排

## 3. 和记忆/理解层还差什么

当前仍然缺这些能力：

1. 摘要还是规则派生，不是 LLM-enhanced understanding。
2. todo candidates 已能进 session todo / task store / planning service，也有 `accepted / snoozed / superseded / completed / dismissed / reopened` 的最小反馈，但还没有更强的确认策略、长期优先级衰减、跨 artifact 合并。
3. office artifacts 已补最小 `workspace_activity -> workspace_artifact index`，并开始支持 mail 正文摘要 / attachments / thread metadata / reminder notes / calendar description；检索层也已有最小 cross-artifact merge，但还没有更强的 cross-artifact entity resolution / persistent merge。
4. 没有 daily report、focus trend、跨天聚合。
5. 现在已经有最小会话注入、统一 workspace context 注入和基础 relevance/budget gating，但还没有更系统的全局 prompt budgeting，也没有统一索引治理策略。

## 4. 和阶跃 app 对比，这次真正补上的能力

这次补的不是“再加一个 skill”，而是把 native context 变成了可以被记忆层消费的结构化派生产物：

- 之前：只能查 raw timeline / keyword search
- 现在：能查时间片摘要、待办候选、语义检索，并把候选事项同步成 session task 和 planning steps；同时能把 mail/calendar/reminders 以 `workspace_activity` 形式统一落库、写入最小向量索引，通过统一入口检索 desktop + office artifacts，并在 session start 按用户请求自动注入相关工作线索

也就是说，能力从“采集层 MVP”推进到了“理解层 MVP 的第一条真实链路”。

## 5. 相关代码

- `src/main/memory/desktopActivityUnderstandingService.ts`
- `src/main/tools/memory/desktopActivityDerived.ts`
- `src/main/tools/memory/workspaceActivitySearch.ts`
- `src/main/memory/workspaceActivitySearchService.ts`
- `src/main/memory/workspaceArtifactIndexService.ts`
- `src/main/agent/runtime/conversationRuntime.ts`
- `src/shared/types/desktop.ts`
- `src/main/app/initBackgroundServices.ts`
- `src/main/tools/toolRegistry.ts`
- `src/main/tools/search/deferredTools.ts`

## 6. 结论

当前仓库的状态从：

- 原生上下文层：MVP 已有
- 办公连接层：MVP 已有
- 记忆/理解层：大部分没做

推进为：

- 原生上下文层：MVP 已有
- 办公连接层：MVP 已有
- 记忆/理解层：已补上一条 desktop activity -> summary/todo/search/task-sync 的 MVP 闭环
- 产品/编排层：已接入最小 planning 输入桥接，但完整编排仍待后续接入
