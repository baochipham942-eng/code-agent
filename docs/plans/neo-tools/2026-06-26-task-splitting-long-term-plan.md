# Task Splitting 长期方案

> 🔗 **集成修订（2026-06-26 审计回写）** — 统一排期与证据契约见 [`2026-06-26-00-INTEGRATION-evidence-and-resequencing.md`](./2026-06-26-00-INTEGRATION-evidence-and-resequencing.md)。本篇归 **WP-E**，推荐优先级 **2（先摘，性价比最高）**。两处现状已核实纠正：
> - ❌ 原文"没有 model-facing 计划工具"**不准**：`TaskManager` + `task_create/update/list` 已注册为对模型暴露的工具（`modules/index.ts:415-432`），schema 已含 status/priority/依赖/owner，直写 SessionTask。**不要新建 `task_plan_update`**，在 `TaskManager` 上加 batch（replace/patch + exactly-one-in_progress 不变量）语义即可，否则两个职责重叠工具模型不知调哪个。
> - ✅ `autoAdvanceTodos`（`runFinalizer.ts:506`）确把 `name === 'bash'` 无条件当修改类 → 任意成功 Bash 误标当前任务完成，**真 bug**，同 PR 修。
> - `evidenceRefs` 字段改为消费统一 `EvidenceRef`（见 WP-A），不自立证据结构。
> 下文 P0/P1/P2 保留作 depth 参考，**实际开工以集成文档 WP-E 为准**。

日期：2026-06-26

范围：Agent Neo coding agent 的任务拆分、待办推进、SessionTask 持久化、右侧任务面板、子任务/多 agent 协作边界。本文不覆盖完整 project management，也不把 Jira/外部 issue tracker 纳入 P0。

## 判断

Neo 当前的 task 拆分已经有一条可用链路：模型输出中的显式 checkbox plan 可以被解析成 session todos，再同步成 `SessionTask`，最后通过 `todo_update` / `task_update` 推到右侧任务面板。更底层的 `SessionTask` store 也已经支持持久化、依赖关系、子任务 ID 和 cancelled 状态。

真正要改的是入口层。Codex CLI 和 OpenCode 的共同点很清楚：任务拆分不是靠自然语言猜，而是由模型调用一个显式结构化工具，把计划状态写进 runtime。Codex CLI 是 `update_plan`，OpenCode 是 `todowrite`，OpenCode 还把更重的子任务拆成 child session，并给 subagent 默认权限边界。

Neo 应该保留现有 `SessionTask` 作为主数据模型，把 task split 的主入口升级成 model-facing structured tool。当前 `todoParser` 可以继续保留，但位置应降级为兼容导入层，用于吸收 markdown checklist，而不是承担主计划协议。

## 借鉴对象

| 对象 | 当前实现 | 值得借的点 | Neo 不照搬的点 |
| --- | --- | --- | --- |
| Codex CLI | `update_plan` 工具，参数是完整 plan array，每项只有 `step/status`，只允许一个 `in_progress`，调用后发送 `PlanUpdate` 事件。 | 计划更新是显式 tool call，不靠解析 assistant 文本；schema 很小，模型负担低；UI 消费事件。 | Codex plan 没有依赖、owner、parentTask、cancelled，Neo 的 `SessionTask` 语义更厚，不能退回纯 checklist。 |
| OpenCode | `todowrite` 整体替换当前 session todo list，DB 保存 ordered todo rows，发布 `SessionTodo.Event.Updated`；复杂任务用 `task` 创建或恢复 subagent session。 | TodoWrite 是一等工具；实时更新；完成必须等验证；subagent 默认不能乱用 `todowrite/task`。 | Neo 不应把子任务都等同于独立 session。轻量步骤仍应留在同一 `SessionTask` plan。 |
| Neo 当前实现 | `todoParser` 从显式 checkbox 解析，`runFinalizer` 推进状态，`taskStore` 持久化 `SessionTask`，renderer 投影 checklist。 | `SessionTask` 已经是更接近长期形态的底盘，UI 和 E2E 已经能证明它可用。 | 主入口仍偏 heuristic，自动完成逻辑太宽，缺 model-facing plan update contract。 |

参考代码：

- Codex CLI: `codex-rs/protocol/src/plan_tool.rs`, `codex-rs/core/src/tools/handlers/plan_spec.rs`, `codex-rs/core/src/tools/handlers/plan.rs`
- OpenCode: `packages/opencode/src/tool/todo.ts`, `packages/opencode/src/session/todo.ts`, `packages/opencode/src/tool/task.ts`, `packages/opencode/src/agent/subagent-permissions.ts`

本次对照快照：

- `openai/codex`: `25f50de6ed95627e1ffe7f11ca30d3d62c6e20e6`
- `sst/opencode`: `28a00ad6afaa3f96f561ad3aeb62f8b2aea170bb`

## Neo 当前状态

### 已经可用

| 领域 | 文件 | 现状 |
| --- | --- | --- |
| Markdown todo 解析 | `src/main/agent/todoParser.ts` | 只在显式任务意图下解析 checkbox，已移除编号列表解析，避免把普通回答 checklist 误提升为待办。 |
| Todo 持久化 | `src/main/agent/todoParser.ts` | `getSessionTodos/setSessionTodos/clearSessionTodos` 会从 DB hydrate，并保存 session todos。 |
| Todo 到 SessionTask 同步 | `src/main/agent/todoParser.ts` | `syncTodosToSessionTasks()` 会创建或更新 canonical `SessionTask`，并标记 `metadata.source = 'todo_parser'`。 |
| Plan bootstrap | `src/main/agent/runtime/conversationRuntime.ts`, `src/main/agent/runtime/conversationRuntimePlanning.ts` | 非 simple task 且当前 session 没 active todos 时，可以从 session-scoped planning service seed todos。 |
| 状态推进 | `src/main/agent/runtime/runFinalizer.ts` | 解析 response 后自动保证一个 `in_progress`；工具成功后自动完成当前 task 并推进下一个。 |
| Canonical task store | `src/main/services/planning/taskStore.ts` | 支持 `SessionTask` 创建、更新、依赖、子任务 ID、事件记录、DB hydrate/persist。 |
| Renderer 投影 | `src/renderer/utils/runWorkbenchProjection.ts` | 优先用 `sessionTasks` 构建 task record，再 fallback 到 todos。 |
| Task rail 呈现 | `src/renderer/utils/taskRailPresentation.ts` | 对 session scoped 多步骤任务渲染 checklist，进度分母剔除 cancelled。 |
| Task panel | `src/renderer/components/TaskPanel/TaskMonitor.tsx`, `src/renderer/components/TaskPanel/RunWorkbenchCards.tsx` | 展示 plan title、进度、依赖文案、step status。 |
| Event effect | `src/renderer/hooks/agent/effects/useTaskProgressEffects.ts` | 消费 `todo_update` 和 `task_update` 事件，更新 session store。 |

### 已验证行为

本次验证通过：

```bash
npx vitest run \
  tests/unit/agent/todoParser.persistence.test.ts \
  tests/renderer/hooks/useStatusRailModel.todos.test.ts \
  tests/renderer/utils/runWorkbenchProjection.test.ts
```

结果：3 个文件，27 个用例通过。

本地 Neo web host + system Chrome E2E 通过：

```bash
E2E_WEB_PORT=8180 npx playwright test \
  --config tests/e2e/playwright.system-chrome.config.ts \
  tests/e2e/task-panel-session-tasks.spec.ts
```

结果：2 passed，1 个需要 `CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1` 的 nightly/manual 用例按条件跳过。覆盖点包括：

- `task_update` 事件能让 task panel 渲染 `SessionTask` lifecycle。
- 依赖状态能显示 `等待 ...` / `解锁 ...`。
- 进度能从 `1/3` 更新到 `2/3`。
- cancelled task 保留在 checklist，但不计入进度分母。
- 通过 `task_create` 创建的持久化 task 能在 reload 后重新显示。

未完成验证：

- in-app browser 控制连接在初始化/选择 browser 阶段连续超时，因此本次没有拿到 in-app browser 视角的实测证据。当前证据只证明产品链路在本地 web host + system Chrome 下可用。

## 当前风险

1. 主入口依赖文本解析
   - `parseTodos()` 要求显式 checkbox 和任务意图，误判风险已经降下来了。
   - 但只要模型没按格式输出，右侧任务拆分就不会出现。
   - 这和 Codex/OpenCode 的显式 tool state 相比仍然不稳。

2. 自动推进过宽
   - `autoAdvanceTodos()` 把成功的 `Bash` 也视为修改类操作。
   - 这会把“跑了一条命令”误当成“当前 task 完成”，尤其当 Bash 是探索、读取、安装、失败重试前置动作时。

3. Todo 和 SessionTask 双轨
   - Renderer 已经优先 `sessionTasks`，这是对的。
   - 但 runtime 里仍有 todos 和 canonical tasks 两套更新逻辑。
   - 长期如果继续双轨，容易出现 parser 认为完成、task store 未完成，或反向不同步。

4. 缺少计划更新协议
   - 当前没有一个 model-facing 的 `task_plan_update` / `todo_write` 等价工具。
   - agent 只能通过自然语言或已有 dev/protocol task tools 间接影响任务面板。

5. 子任务权限边界还不够产品化
   - `SessionTask` 有 owner、parentTaskId 等基础字段。
   - 但如果后续加入多 agent/subagent 写任务，必须防止子 agent 改坏 parent plan。

## 目标形态

Neo 的长期目标是把 task split 做成 runtime 一等对象：

```text
user goal / agent intent
  -> TaskPlanUpdate tool call
  -> SessionTask store
  -> task_update event
  -> renderer task panel
  -> verification evidence
  -> final completion audit
```

核心原则：

1. `SessionTask` 是唯一 canonical state。
2. 文本 parser 只做 fallback/import，不做主协议。
3. 每次计划变化都走结构化 event，可持久化、可 replay、可审计。
4. 一次 session 里最多一个 top-level task 处于 `in_progress`，除非显式进入 parallel/multi-agent mode。
5. `completed` 只能由明确完成信号或 verification evidence 推进，不能只靠有工具调用成功。
6. 子 agent 默认只能写自己的 task scope，不能改 parent plan，除非显式授权。

建议核心对象：

```ts
type TaskPlanUpdateInput = {
  title?: string;
  mode: 'replace' | 'patch';
  explanation?: string;
  tasks: TaskPlanItemInput[];
};

type TaskPlanItemInput = {
  id?: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'blocked' | 'cancelled';
  priority?: 'low' | 'normal' | 'high';
  parentTaskId?: string;
  blockedBy?: string[];
  owner?: string;
  evidenceRefs?: Array<{
    kind: 'tool' | 'file' | 'test' | 'browser' | 'ci' | 'artifact';
    ref: string;
  }>;
};
```

第一版可以比这个更薄，只保留 `subject/status/blockedBy`，但工具名和事件流要先定下来。

## 长期路线

### P0：显式计划工具接入 SessionTask

目标：让 task split 从文本解析升级成结构化工具调用，同时保持现有 UI 不大改。

任务 1：新增 model-facing `task_plan_update`

- 作为 agent 可调用工具，类似 Codex `update_plan` 和 OpenCode `todowrite`。
- 参数支持 `mode: replace | patch`。
- P0 字段先保守：`title`、`tasks[].subject`、`tasks[].status`、`tasks[].blockedBy`。
- 后端直接写 `SessionTask`，并发 `task_update`。
- 校验 exactly one `in_progress`，无 in_progress 时可自动把第一个 actionable pending 设为 in_progress。

任务 2：把 `SessionTask` 设成主状态

- renderer 当前已经优先 `sessionTasks`，保持这个方向。
- runtime 内部新增 helper：`syncTaskPlanUpdateToSessionTasks()`。
- `todoParser.syncTodosToSessionTasks()` 继续存在，但作为 fallback 调同一个 lower-level task sync helper。

任务 3：收紧 `autoAdvanceTodos()`

- 不再把任意成功 `Bash` 视为当前 task 完成。
- P0 可先改成：
  - `Edit/Write/NotebookEdit` 可触发 candidate completion。
  - `Bash` 只有命令被标记为 verification 或 task-linked command 时才推进。
- 更理想是 tool result 带 `taskId` 或 `completesTaskId`。

任务 4：plan title 走显式字段

- 当前 `extractPlanTitle()` 从 markdown 里解析 `Plan:` / `计划:`。
- 新工具里 `title` 应直接持久化到 session plan title。
- markdown title parser 保留 fallback。

任务 5：新增测试

- `taskPlanUpdate.tool.test.ts`: schema 校验、replace/patch、exactly one in_progress。
- `taskPlanUpdate.sessionTasks.test.ts`: 写入 `SessionTask`、依赖关系、cancelled 分母。
- `runFinalizer.autoAdvance.test.ts`: Bash 不再无条件完成当前 task。
- `taskPanel.taskPlanUpdate.e2e.ts`: 通过真实事件或工具调用看到 task panel 更新。

P0 验收：

- 模型调用 `task_plan_update` 后，右侧任务面板出现拆分步骤。
- 刷新 session 后任务仍在。
- 依赖关系能渲染。
- parser 输出 checklist 仍能工作，但 source 标为 `todo_parser`。
- 成功执行普通探索 Bash 不会误把当前任务标完成。

### P1：任务完成和验证证据绑定

目标：把 task status 从“工具跑过了”升级成“有完成证据”。

任务 1：为 `SessionTask` 增加 evidence refs

- 不一定马上改 contract，可先放在 `metadata.evidenceRefs`。
- evidence 类型包括 tool result、file diff、test command、browser screenshot、CI log、artifact verifier。

任务 2：引入 `task_status_update`

- 区分 plan 结构更新和单个 task 状态更新。
- 支持 `reason`、`evidenceRefs`、`blockedReason`。
- `completed` 如果没有 evidenceRefs，runtime 可接受但标记为 weak completion。

任务 3：接 Verification Loop

- verification 通过后可自动把 linked task 标为 completed。
- verification 失败后 linked task 保持 `in_progress` 或 `blocked`，并写入 failure evidence。
- final answer 引用 task plan 和 verification evidence，而不是只说“已完成”。

任务 4：UI 增强

- task row 显示 evidence hint，例如 `验证通过`、`等待测试`、`缺凭证`。
- completed task 可展开看到完成证据。
- blocked task 显示 blocker 来源。

P1 验收：

- 一个任务只有在 linked verification 通过后才稳定标 completed。
- verification failed 会让 task panel 明确显示 blocked/in_progress，而不是偷偷推进。
- final answer 可以说清楚哪些 task 有证据，哪些只是实现完成但未验证。

### P2：子任务和多 agent 权限边界

目标：支持更复杂任务拆分，但不让 subagent 破坏主计划。

任务 1：Task ownership policy

- `owner` 字段明确谁能写 task。
- main agent 可创建和改所有 task。
- subagent 默认只能更新自己 owner scope 下的 task。
- subagent 要改 parent task 必须显式授权。

任务 2：Child session mapping

- 重任务可以创建 child session。
- parent `SessionTask` 记录 `childSessionId`。
- child session 完成后只回写自己的 task status 和 evidence summary。

任务 3：Parallel mode

- 默认仍只允许一个 top-level `in_progress`。
- 用户或 planner 显式进入 parallel mode 后，允许多个不同 owner 的 task 同时 in_progress。
- UI 要能区分“并行执行中”和“状态冲突”。

任务 4：Subagent safety tests

- subagent 没权限时，无法 patch parent plan。
- child session 完成不会覆盖 parent plan title。
- cancelled parent task 会让 child task 进入 cancelled 或 detached 状态。

P2 验收：

- 一个 parent task 可派发给 child session，并在完成后回写 evidence。
- subagent 默认不能调用 parent `task_plan_update replace`。
- parallel mode 下多个 owner 的 in_progress 能正常显示。

### Later：任务拆分产品化

1. Task Plan Debug View
   - 展示 task update trace、source、actor、event time、evidence refs。
   - 便于判断 plan 是模型工具写的、parser 导入的，还是用户手动创建的。

2. Task Split Evaluation
   - 固定一组任务，评估拆分粒度、顺序、依赖、验证绑定、是否过度拆分。
   - 比较不同 prompt/tool schema 的 plan 质量。

3. Cross-session Task Memory
   - 只保存可复用 pattern，不保存普通 session 的临时 todo。
   - 例如 repo release checklist、design mode QA checklist、web search evidence checklist。

4. External tracker bridge
   - Jira/GitHub Issues 只做同步层。
   - Neo 内部仍以 `SessionTask` 为 runtime truth source。

## 推荐落地顺序

1. 定 `task_plan_update` schema 和 tool registration。
2. 实现 schema validation 和 `SessionTask` replace/patch sync。
3. 让 `runFinalizer.tryParseTodosFromResponse()` 的 parser fallback 复用同一条 sync helper。
4. 收紧 `autoAdvanceTodos()` 的 Bash 推进规则。
5. 补 unit tests 和 task panel E2E。
6. 接 plan title 显式持久化。
7. P1 再接 evidence refs 和 verification link。

最小可合并切片应该控制在 P0 的前四项。UI 侧大概率不用大改，因为 task panel 已经消费 `sessionTasks`。

## 验收计划

P0 必跑：

```bash
npm run typecheck
npx vitest run \
  tests/unit/agent/todoParser.persistence.test.ts \
  tests/renderer/hooks/useStatusRailModel.todos.test.ts \
  tests/renderer/utils/runWorkbenchProjection.test.ts
npx playwright test \
  --config tests/e2e/playwright.system-chrome.config.ts \
  tests/e2e/task-panel-session-tasks.spec.ts
```

新增后建议补：

```bash
npx vitest run tests/unit/agent/taskPlanUpdate.test.ts
npx vitest run tests/unit/agent/runtime/runFinalizer.autoAdvance.test.ts
npx playwright test \
  --config tests/e2e/playwright.system-chrome.config.ts \
  tests/e2e/task-panel-task-plan-update.spec.ts
```

行为验收：

| 场景 | 预期 |
| --- | --- |
| 模型调用 `task_plan_update replace` 写 3 步计划 | 面板显示 3 步，第一步 in_progress，刷新后仍在。 |
| 模型调用 `task_plan_update patch` 完成第 1 步 | 面板更新为 1/3，第二步进入 in_progress。 |
| 计划包含依赖 | 被阻塞任务显示等待前置任务。 |
| checklist fallback | markdown checklist 仍能导入，但 source 是 `todo_parser`。 |
| 普通 Bash 成功 | 不自动完成当前 task。 |
| verification Bash 成功 | linked task 可完成，并写 evidence。 |
| in-app browser 不可用 | 不影响 task state 本身，但 browser 验证项标 `not_run` 或 `blocked`。 |

## 不做清单

| 不做 | 原因 |
| --- | --- |
| 推倒 `SessionTask` 重做 todo store | 现有底盘已经支持持久化、依赖、UI 投影和 E2E。 |
| 继续扩大 markdown parser 识别范围 | 编号列表、普通 checklist 很容易误伤回答内容。 |
| 把所有 task 都变成 child session | 轻量步骤没必要拆 session，成本和状态复杂度会过高。 |
| 用工具调用成功替代完成证据 | 成功执行工具不等于任务完成。 |
| 让 subagent 默认改 parent plan | 多 agent 写同一计划会制造不可审计的状态冲突。 |
| 为了漂亮 UI 先重做 TaskPanel | 当前 UI 主链路可用，P0 应先修计划协议。 |

## 关键文件

- `src/main/agent/todoParser.ts`
- `src/main/agent/runtime/runFinalizer.ts`
- `src/main/agent/runtime/conversationRuntime.ts`
- `src/main/agent/runtime/conversationRuntimePlanning.ts`
- `src/main/services/planning/taskStore.ts`
- `src/renderer/hooks/agent/effects/useTaskProgressEffects.ts`
- `src/renderer/hooks/useStatusRailModel.ts`
- `src/renderer/utils/runWorkbenchProjection.ts`
- `src/renderer/utils/taskRailPresentation.ts`
- `src/renderer/components/TaskPanel/TaskMonitor.tsx`
- `src/renderer/components/TaskPanel/RunWorkbenchCards.tsx`
- `tests/unit/agent/todoParser.persistence.test.ts`
- `tests/renderer/hooks/useStatusRailModel.todos.test.ts`
- `tests/renderer/utils/runWorkbenchProjection.test.ts`
- `tests/e2e/task-panel-session-tasks.spec.ts`
