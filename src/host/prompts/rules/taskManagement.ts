// ============================================================================
// Task Management Rules - 任务动态管理指导
// TaskManager API guidance
// ----------------------------------------------------------------------------
// ⚠️ 本文件**不进运行时提示词**（2026-08-14 L8 N-L8-SLIM2 查明）。
//
// `TASK_MANAGEMENT_RULES` 全仓只被 promptIndex.ts import 一次，那是为了把它登记进
// 提示词覆盖注册表（设置页可查看/覆盖），组装系统提示的 builder.ts 从不消费它——同目录
// 16 个规则块里有 4 个是这个状态，builder.ts:93 的注释也承认了同类事实。
//
// 后果曾经是：TaskManager 的 schema 每轮全额下发（2249 token / ÷3 口径），而这份"什么时候
// 该用它"的指导一次都没发出去过。真库 4748 次工具调用里 TaskManager 零使用，session_tasks
// 的任务创建时间停在 2026-06-11。
//
// **模型实际读到的任务管理引导现在在 `tools/modules/planning/taskManager.schema.ts` 的
// description 里**（对标 Claude Code / Roo Code / OpenHands：判据写进工具 description，
// 随工具按需到达，而不是常驻系统提示）。改引导请改那里，改这里不生效。
//
// 本文件保留是因为设置页仍列出它；"设置页里有一批改了不生效的提示词"是独立的一张单。
// ============================================================================

import { applyOverride } from '../registry';

export const TASK_MANAGEMENT_RULES = applyOverride(
  { id: 'rules.taskManagement', category: '规则', name: '任务管理', description: 'TaskManager 使用时机与列表管理' },
  `
## 任务动态管理

优先使用 TaskManager 工具（action: create / update / list / get）维护任务分解。复杂任务不要只在回复里写 checklist；右侧任务面板以该工具写入的 SessionTask 为事实源。

### 何时使用任务管理

**需要使用：**
- 复杂任务（3+ 步骤）
- 多阶段工作
- 需要跟踪进度的任务
- 用户提供任务列表时

**可以跳过：**
- 简单的单步操作
- 快速问答
- 纯信息查询

### 任务生命周期

\`\`\`
create → update(status="in_progress") → update(status="completed") + completionEvidence
                                      → update(status="blocked")   + blockedReason # 卡在外部障碍
                                      → update(status="cancelled") # 主动放弃但保留可见记录
                                      → update(status="deleted")   # 误建/不该存在，物理删除
\`\`\`

以上均为 TaskManager 的 action/status 组合。

### 证据门（强制）

任务账本记录的是"你声称做了什么"，它是 advisory 的：**绝不能用任务状态去覆盖真实的文件/git/测试结果**。真实结果说没过，任务就不是 completed。

- \`status="completed"\` **必须**带 \`completionEvidence\`：一句话写你实际核过什么——跑了什么命令、结果如何；重读了哪个文件；看到了哪个页面。写不出来说明还没验证，先去验证。
- **子代理报成功不算证据**：派出去的子代理回报"做完了"时，不要直接把任务标 completed。自己核实产物，然后由你写证据。子代理结束时它名下没收口的任务会自动转成 blocked 交还给你，等你核实。
- \`status="blocked"\` **必须**带 \`blockedReason\`：用人话说清楚卡在哪（"这个报表页要公司账号登录，我们没有"），**不要贴 raw 报错日志或 API 响应体**——看任务面板的是不懂技术的协作者。
- \`status="cancelled"\` 建议带 \`cancelReason\`。
- \`replace\` / \`patch\` 批量改计划时同样要带：把某条改成 completed/blocked 的那一项上写 completionEvidence / blockedReason。

blocked 和依赖等待是两回事：等前置任务用 \`addBlockedBy\`（任务仍是 pending），\`status="blocked"\` 专指外部障碍。

### 任务标题语义

SessionTask 表示用户能理解的工作单元，不是工具调用日志。subject/activeForm 要写“正在推进的目标”或“要完成的结果”，不要写底层工具动作。

**好的任务标题：**
- 梳理验收口径
- 接通 SessionTask 数据流
- 修复任务面板状态聚合
- 验证任务面板生命周期

**不要这样写：**
- 读取文件
- 写入文件
- 运行测试
- 调用 API
- 使用 Bash

文件读写、命令执行、浏览器点击这类动作会进入工具活动/Trace，不要重复塞进 SessionTask。

### 用户意图识别（重要）

用户不一定会直白地说"再加一个XXX功能"，需要从上下文和语义分析识别任务变化：

**新增任务的信号：**
- 直接请求："另外还需要..."、"顺便..."、"再加一个..."
- 隐含请求："对了，XX功能..."、"还有一个问题..."
- 条件触发："如果XXX的话，还要..."
- 扩展需求："能不能也支持..."、"最好也能..."
- 澄清后扩展：回答问题后发现的新需求

**修改任务的信号：**
- 范围变化："不用做XX了"、"只需要做YY"
- 优先级变化："先做这个"、"这个更重要"
- 需求澄清："我的意思是..."、"更准确地说..."

**取消/删除任务的信号：**
- 明确取消："不用做了"、"跳过这个"
- 方案变更："换个方式"、"改成用..."
- 已不需要："这个已经有了"、"别人已经做了"

### 响应用户补充

当识别到用户的意图变化时：

\`\`\`typescript
// 1. 先确认理解
"我理解您希望增加/修改/取消XXX任务"

// 2. 更新任务列表
TaskManager({ action: "create", subject: "补齐任务面板生命周期验收", description: "验证拆分、执行、阻塞、取消和完成状态" })
// 或：不再执行但仍应留痕
TaskManager({ action: "update", taskId: "X", status: "cancelled" })

// 3. 继续执行
"现在开始处理..."
\`\`\`

### 任务状态管理

| TaskManager 调用 | 使用场景 |
|------|----------|
| action="create" | 创建新任务 |
| action="update", status="in_progress" | 开始执行任务前 |
| action="update", status="completed" + completionEvidence | 任务完成**且已核实**后 |
| action="update", status="blocked" + blockedReason | 卡在外部障碍（缺权限/站点拒绝/缺信息）上推不动 |
| action="update", status="cancelled" | 任务主动放弃但仍需保留给用户看 |
| action="update", status="deleted" | 误建或不该存在的任务 |

### 依赖关系

使用 addBlockedBy/addBlocks 管理任务依赖：

\`\`\`typescript
// 任务 B 依赖任务 A
TaskManager({
  action: "update",
  taskId: "B",
  addBlockedBy: ["A"]
})
\`\`\`

### 最佳实践

1. **即时响应**：识别到意图变化后立即更新任务列表
2. **保持同步**：任务列表应反映当前实际工作状态
3. **声明依赖**：后置任务等待前置任务时，用 addBlockedBy/addBlocks 表达依赖，不要只写在自然语言里
4. **保留取消记录**：任务范围变化导致不做时用 cancelled；只有误建任务才 deleted
5. **透明沟通**：更新任务后简要告知用户
`,
);
