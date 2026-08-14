// Schema-only file (P1 Wave 3 — planning native migration)
import type { ToolSchema } from '../../../protocol/tools';
import { TASK_EVIDENCE_PROPERTIES, TASK_STATUS_DESCRIPTION } from './taskUpdate.schema';

export const taskManagerSchema: ToolSchema = {
  name: 'TaskManager',
  description: `维护本次会话的任务清单。写进去的 SessionTask 就是用户右侧任务面板看到的内容，也是你自己跨轮次的执行状态。

## 什么时候该用

- 复杂任务：3 步以上，或有明显阶段/依赖顺序
- 用户一次给了多件事（列表式、逗号分隔、"顺便再…"）
- 需要让用户看见进度的长活
- 收到新指令时：先把要求落成任务，再开工
- 开始做某一项前把它标 in_progress；做完立刻标 completed

## 什么时候不该用

- 只有一件简单的事
- 两三步就能做完，记账的开销比干活还大
- 纯问答、纯查询、纯聊天

只有一件小事时直接做，别先建任务——记账本身要花轮次和 token。

## 证据门（强制，与其他产品最大的不同）

任务账本记的是"你声称做了什么"，**绝不能用它去覆盖真实的文件/git/测试结果**。真实结果说没过，任务就不是 completed。

- \`status="completed"\` **必须**带 \`completionEvidence\`：一句话写你实际核过什么（跑了什么命令、结果如何／重读了哪个文件／看到了哪个页面）。**写不出来就说明还没验证，先去验证。**
- **子代理报成功不算证据**：自己核实产物后再由你写证据。
- \`status="blocked"\` **必须**带 \`blockedReason\`，用人话讲清卡在哪（"这个页面要公司账号登录，我们没有"），不要贴 raw 报错——看面板的是不懂技术的协作者。
- \`blocked\` 专指外部障碍；等前置任务用 \`addBlockedBy\`（任务仍是 pending）。
- \`replace\` / \`patch\` 批量改计划时同样要带。

## 任务标题写法

写"要完成的结果"，不是工具调用日志。文件读写、命令执行、点击这些会自动进 Trace，别重复塞进任务。

- 好：梳理验收口径／接通数据流／修复状态聚合
- 差：读取文件／运行测试／调用 API／使用 Bash

## Actions

- create: 建一个任务（需 subject、description；可选 activeForm、priority、parentTaskId、metadata）
- get: 按 ID 取任务详情（需 taskId）
- list: 列出本会话全部任务（无参数）
- update: 改状态/详情/依赖（需 taskId）。status="cancelled" 主动放弃但保留可见，status="deleted" 物理删除
- replace: 用 tasks[] 整体替换计划；开放任务中恰好一条会被归一为 in_progress
- patch: 用 tasks[] 批量更新/新建；同样归一为恰好一条 in_progress

## Examples

- 建任务: { "action": "create", "subject": "接通登录流程", "description": "补 OAuth 回调与失败态" }
- 开工: { "action": "update", "taskId": "1", "status": "in_progress" }
- 完成（必须带证据）: { "action": "update", "taskId": "1", "status": "completed", "completionEvidence": "跑了 npm test，42 passed；页面能正常跳转回首页" }
- 卡住: { "action": "update", "taskId": "2", "status": "blocked", "blockedReason": "这个报表页要公司账号登录，我们拿不到" }
- 批量推进: { "action": "patch", "tasks": [{ "taskId": "1", "status": "completed", "completionEvidence": "…" }, { "taskId": "2", "status": "in_progress" }] }`,
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'get', 'list', 'update', 'replace', 'patch'],
        description: 'The task management action to perform',
      },
      // --- get / update params ---
      taskId: {
        type: 'string',
        description: '[get, update] The ID of the task',
      },
      // --- create / update params ---
      subject: {
        type: 'string',
        description: '[create, update] Brief task title in imperative form',
      },
      description: {
        type: 'string',
        description: '[create, update] Detailed description of what needs to be done',
      },
      activeForm: {
        type: 'string',
        description: '[create, update] Present continuous form shown while in progress (e.g., "Implementing login")',
      },
      // --- create only ---
      priority: {
        type: 'string',
        enum: ['low', 'normal', 'high'],
        description: '[create] Task priority (default: normal)',
      },
      parentTaskId: {
        type: 'string',
        description:
          '[create] Parent task id for hierarchical breakdown (child ids become "1.1", "1.2", ...). Parent must exist.',
      },
      // --- update only ---
      status: {
        type: 'string',
        enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled', 'deleted'],
        description: `[update] ${TASK_STATUS_DESCRIPTION}`,
      },
      ...TASK_EVIDENCE_PROPERTIES,
      owner: {
        type: 'string',
        description: '[create, update] Task owner (agent id). Tasks created inside a subagent default to that subagent; open tasks are handed back to the main session when the subagent finishes.',
      },
      addBlockedBy: {
        type: 'array',
        items: { type: 'string' },
        description: '[update] Task IDs that block this task (must complete first)',
      },
      addBlocks: {
        type: 'array',
        items: { type: 'string' },
        description: '[update] Task IDs that this task blocks',
      },
      // --- create / update ---
      metadata: {
        type: 'object',
        description: '[create, update] Arbitrary metadata. On update, keys are merged; set a key to null to delete it.',
      },
      desktopAction: {
        type: 'string',
        enum: ['accept', 'dismiss', 'snooze', 'reopen', 'supersede'],
        description: '[update] Optional lifecycle action for desktop-derived tasks.',
      },
      desktopSnoozeHours: {
        type: 'number',
        description: '[update] When desktopAction="snooze", suppress recovery for this many hours.',
      },
      tasks: {
        type: 'array',
        description: '[replace, patch] Batch task plan items. replace requires subject/content for each item; patch accepts taskId/id for updates or subject/content for new tasks.',
        items: {
          type: 'object',
          properties: {
            taskId: { type: 'string', description: '[patch] Existing task id to update' },
            id: { type: 'string', description: '[patch] Existing task id alias' },
            subject: { type: 'string', description: 'Task title' },
            content: { type: 'string', description: 'Task title alias' },
            description: { type: 'string', description: 'Task detail' },
            activeForm: { type: 'string', description: 'Present continuous active form' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'blocked', 'cancelled'],
              description:
                'Task status; batch operations normalize open tasks to exactly one in_progress. '
                + '"completed" requires completionEvidence and "blocked" requires blockedReason on the same item.',
            },
            ...TASK_EVIDENCE_PROPERTIES,
            priority: {
              type: 'string',
              enum: ['low', 'normal', 'high'],
              description: 'Task priority for newly created tasks',
            },
            owner: { type: 'string', description: 'Task owner' },
            metadata: { type: 'object', description: 'Task metadata' },
          },
        },
      },
    },
    required: ['action'],
  },
  category: 'planning',
  permissionLevel: 'write',
  allowInPlanMode: true,
};
