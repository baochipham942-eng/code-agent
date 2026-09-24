# ADR-073：工具资源声明与保序并行分段

- 状态：**提议，等待产品负责人拍板**
- 单号：N-TOOL-RESOURCE-ADR（本 ADR 只定合同，不施工）
- 范围：`ToolSchema` 的资源语义、同一模型响应内的工具排程、现有写隔离锁、工具级死代码
- 基线：`origin/main@158bb32492f3d5930e2effa9bfefe6b0c3765769`
- 证据：`code-agent-private-archive/docs/evidence/N-TOOL-RESOURCE-ADR-2026-09-24.md`
- 相关：`ADR-022`（工具执行账本）、`ADR-059`（前台写工具）、`N-PARALLEL-BATCHPOLICY`、`N-PARALLEL-SAFELIST`；竞争审计为 `code-agent-private-archive/docs/competitive/2026-09-02-Neo-agent架构对照SOTA六家-通盘体检.md` §D03-02 / D02-04。

## 背景和问题

`classifyToolCalls` 目前按工具名/并行白名单把一次模型响应分成 `parallelGroup` 与 `sequentialGroup`，执行器先跑整个并行组，再跑串行组。即使结果数组按原 index 回填，副作用已经发生在错误的时间顺序：模型给出 `[Write(a), Read(a)]` 时，`Read(a)` 会先于 `Write(a)` 执行。名字白名单也不能表达「两个读不冲突、同一路径的读写冲突、不同路径的两个写可以并行」。

仓内已经有路径归一和冲突判断：`getWriteIsolationScope` 将 Bash/执行类工具映射到 workspace 锁，将文件写工具映射到 `file_path` 等参数归一后的文件锁，`scopeConflicts` 判断同根路径的包含关系。它现在只在工具真正执行前拿运行时锁，排程器没有消费这份资源事实。

## 决策

### 1. `ToolSchema.accesses` 是显式资源合同

给 `ToolSchema` 增加可选字段：

```ts
export type ToolAccessKind = 'read' | 'write' | 'readwrite';

export interface ToolAccessDeclaration {
  readonly kind: ToolAccessKind;
  /** 传入调用参数中承载路径/资源键的字段；可多个字段组成同一资源。 */
  readonly argumentNames?: readonly string[];
  /** 目标不是普通路径时的稳定表达式，例如 `mcp(server, tool, args.target)`。 */
  readonly expression?: string;
}

interface ToolSchema {
  // ...existing fields
  readonly accesses?: readonly ToolAccessDeclaration[];
}
```

`argumentNames` 与 `expression` 二选一；两者都省略表示工具声明的是一个固定、非路径资源（例如会话计划或审批槽），实现时必须给它稳定的资源域名。一个工具可以声明多个访问项。`kind` 描述该调用对目标的最低语义：`read` 只观察，`write` 改变，`readwrite` 先读后改或无法拆分。声明的是资源域，不是权限等级；`permissionLevel` 仍由权限系统使用。

调度器先解析调用参数得到规范化访问域：相对路径相对当前工作目录解析、真实路径归一；没有可解析路径、表达式不可信或声明缺失时使用该工具的保守未知域。未知域与任意写域冲突，与另一个未知域也冲突。只读域之间不因同路径而冲突。

#### 缺省折叠顺序

显式 `accesses` 优先。工具没有声明时，按以下顺序折叠现有标记：

| 现有标记 | 折叠值 | 说明 |
|---|---|---|
| `sideEffect === true`（旧 ToolDefinition / durable operation 元数据） | `readwrite`，目标为已有 effect/path 声明；没有目标则未知 workspace/external 域 | 有副作用不能当成只读；不从工具名猜路径 |
| `sideEffect === false` 或 `sideEffect in {'none','read_only'}` | `read` | 只在该标记来自同一调用合同且没有 destructive hint 时采用 |
| `ToolSchema.readOnly === true` | `read` | 这是当前内置工具的主要旧标记 |
| `ToolSchema.readOnly === false` | `write`，目标由 `pathAuthority`、`emission` 或未知域决定 | 这是保守折叠；实际只读的工具必须补显式 `accesses` |
| MCP `readOnlyHint === true` 且 `destructiveHint !== true` | `read` | 仅作未声明 MCP 工具的默认折叠；本地安全策略仍可不信任该 hint |
| MCP hint 缺失、冲突或 `destructiveHint === true` | `readwrite` / 未知域 | fail-closed，不能进入无冲突并行段 |
| 以上都没有 | `readwrite` / 未知域 | 不因为名字含 `read`、`search`、`get` 而放行 |

`pathAuthority` / `emission` 只用于补出目标参数，不改变 `kind`。若旧标记互相矛盾，取更严格的 `readwrite`；声明与实际运行时 scope 不一致时按 §3 的 fail-closed 处理。

#### 当前 123 个内置工具的折叠清单

下表是写作时从 `src/host/tools/modules/**/*.schema.ts` 的注册 schema 逐项读取的结果。`read` / `write` 是当前 `readOnly` 标记折叠出的值；`readwrite?` 表示旧合同没有足够信息，只能保守地当未知资源处理。`⚠️` 表示已知行为与折叠值不符，必须在实现票中补显式声明；没有 `⚠️` 的条目仍要在资源有路径/外部目标时补参数名。

| 类别 | 工具（当前折叠值） |
|---|---|
| command center | `delegate_task` → **read ⚠️**（实际登记/派发任务）；`wake_noop` → read |
| connectors | `calendar` / `mail` / `reminders` / `tmeetMeetingList` / `tmeetMeetingSearch` → read；`calendar_create_event` / `calendar_delete_event` / `calendar_update_event` / `mail_draft` / `mail_send` / `reminders_create` / `reminders_delete` / `reminders_update` / `tmeetMeetingCreate` → write |
| design / document / excel | `ProposeCanvasOps` / `ProposeSlidesOps` / `ProposeVideoOps` / `RequestDesignAutonomy` → **readwrite?**；`DocEdit` / `ExcelAutomate` → write |
| file | `Read` / `Glob` / `ListDirectory` / `read_clipboard` / `read_tool_result_archive` / `Blob` → read；`Append` / `Edit` / `notebook_edit` / `request_directory` / `Write` → write |
| memory | `EpisodicRecall` / `History` / `MemoryRead` / `memory_search` → read；`memory_amend` / `MemoryWrite` → write |
| lsp | `diagnostics` / `lsp` → read |
| MCP | `mcp_add_server` / `mcp` / `MCPUnified` → **readwrite?**（未声明，按未知域） |
| multi-agent | `collect_agent` / `plan_review` / `wait_agent` → read；`agent_message` / `close_agent` / `send_input` / `spawn_agent` / `Task` / `teammate` / `workflow` / `workflow_orchestrate` → **readwrite?** |
| network reads | `academic_search` / `ExternalSearch` / `image_analyze` / `local_speech_to_text` / `ReadDocument` / `read_docx` / `read_pdf` / `read_xlsx` / `twitter_fetch` / `web_fetch` / `WebFetch` / `youtube_transcript` → read |
| network writes / unknown | `chart_generate` / `docx_generate` / `excel_generate` / `mermaid_export` / `PdfAutomate` / `pdf_compress` / `pdf_generate` / `ppt_edit` / `qrcode_generate` / `xlwings_execute` → write；`github_pr` / `http_request` / `jira` / `ppt_generate` / `screenshot_page` / `WebSearch` → **write ⚠️**（其中部分是读外部世界，不能继续沿用 false/unknown 作为资源合同） |
| planning | `attempt_completion` / `declare_deliverables` / `recommend_capability` / `plan_read` / `plan_recover_recent_work` / `space_list` / `space_query` / `task_get` / `task_list` / `ToolSearch` → read；`AskUserQuestion` / `confirm_action` / `enter_plan_mode` / `exit_plan_mode` / `findings_write` / `Plan` / `PlanMode` / `plan_update` / `space_create` / `task_create` / `TaskManager` / `task_update` / `Explore` → **readwrite?**；`attempt_completion`、`declare_deliverables`、`recommend_capability` 的当前 `readOnly=true` 还会登记完成/交付/推荐状态，均标 `⚠️`，并且是终止/边界工具 |
| role / skill / self-wake / session | `propose_role` / `Skill` / `sleep_until` / `SessionManager` → **write ⚠️**（schema 标记与读权限/行为不一致）；`SkillCreate` / `propose_team_recipe` / `visual_edit` → write；`list_experts` → read |
| shell | `git_diff` / `Grep` / `task_output` → read；`Bash` / `git_commit` / `git_worktree` / `kill_shell` / `Process` → write |
| terminal | `terminal_list` / `terminal_read` → **read ⚠️**（当前没有 `readOnly: true`）；`terminal_open` / `terminal_wait` / `terminal_write` → **readwrite? / write**（pty 生命周期或输入会变更状态） |

这张表是迁移清单，不把错误折叠值继续当成安全事实：第一批显式声明应覆盖所有 `readwrite?` 与 `⚠️`，然后逐工具补路径/资源参数。MCP 工具每次发现时保存其 annotations 快照，运行时仍按本 ADR 的未知域规则处理缺失/冲突声明。

### 2. 保序并行分段

把现在的两组二分替换为一次从左到右的分段：

1. 从模型响应的第一个调用开始，建立当前段。
2. 对下一个调用解析 `accesses`，与当前段内每个调用的规范化访问域做冲突判断；没有冲突就并入当前段，有冲突就关闭当前段并新开一段。
3. 每段内部最多按 `MAX_PARALLEL_TOOLS` 切成连续小批；小批之间仍按段的先后顺序执行。
4. 所有结果以原始 `toolCalls` index 回填，并按 index 组成返回数组；执行完成顺序不能成为返回顺序。
5. `AskUserQuestion`、`confirm_action`、`exit_plan_mode`、`PlanMode({action:'exit'})`、`attempt_completion` 等终止/交互边界调用先关闭前段，自己成为屏障段；屏障后的调用不在本批执行，返回结构化 `BATCH_TERMINATED`/deferred 结果，等待下一轮或用户审批。这样不会在审批前偷跑写工具。

可测试的一句话不变量：**对一次模型响应，任意调用只会与它之前同一无冲突段的调用并发；段与段按模型原顺序执行；结果数组严格按原始调用 index 返回，且屏障后的调用不执行。**

例子：

| 模型调用顺序 | 分段与结果 |
|---|---|
| `Read(a)`，`Read(a)`，`Read(b)` | 一个读段，三者并发；返回 `[r1,r2,r3]`。 |
| `Write(a)`，`Read(a)` | `Write(a)` 段 → `Read(a)` 段；不会把读提前。 |
| `Write(a)`，`Write(b)` | 两个不同文件域不冲突，同一段并发；返回顺序仍是 a、b。 |
| 无 annotations 的 MCP 调用，`Read(a)` | MCP 折叠为未知 `readwrite` 域，先单独成段；`Read(a)` 不越过它并发。 |
| `Read(a)`，`exit_plan_mode(plan)`，`Write(b)` | 读段 → 退出规划屏障；`Write(b)` 延后/阻断，不在审批前执行。 |

### 3. 与写隔离锁的分工：一套冲突模型

`accesses` 是模型调用进入排程前的静态意图；`writeIsolation.ts` 是真正执行前的动态保护。两者不各自发明冲突规则：

- **唯一冲突真源**：规范化资源域和 `scopeConflicts` 的语义。实现时把 `getWriteIsolationScope` 的路径归一/文件与 workspace 包含关系抽成共享 resolver；静态检查复用它，并为只读域加同构的 read scope。`scopeConflicts` 仍负责“同根、workspace 或父子路径”判定。
- **排程前**：用声明/折叠结果解析所有访问域，先做保守分段；静态阶段没有调用运行时 lock，不等待、不占锁。
- **执行时**：每个真正进入 `ToolExecutor` 的写/执行调用继续调用 `getWriteIsolationScope` 并由 `WriteIsolationManager.acquire` 等待/拒绝；这是对运行时参数、外部修改和跨轮并发的最后防线。
- **不一致处理**：声明解析出的 scope 比运行时 scope 更窄、解析失败或两者版本不一致时，静态调度按冲突处理并串行；执行层仍按运行时 scope 拿锁并记录 `resource_scope_mismatch`，不以静态“安全”绕过锁。不能通过改名、漏填参数或只改 accesses 获得并行。

因此“静态分段”和“运行时锁”是同一个 conflict oracle 的两个时点：前者减少可安全等待，后者保护真实副作用。

### 4. 删除工具级死代码

提议删除 `src/host/agent/toolExecution/dagScheduler.ts`。以精确 import/require/dynamic-import grep 复核后，它在 `src` 与 `tests` 没有消费者；现有文本只出现在该文件自身、历史 changelog/knip 基线和 ADR-072 的说明。保留并不改动任务级 `src/host/scheduler/DAGScheduler.ts`：它有 `parallelAgentCoordinator`、`dagEventBridge`、`webStartupServices` 和 scheduler 单测等真实消费方。删除票需要同步移除死文件对应的 knip baseline 条目，并修订历史文档链接为“已删除工具级草稿”，不能删除任务级调度器。

## 拟拆施工单（只提议，不创建）

| 顺序 | 提议范围 | 触及文件 | 判断标准 |
|---|---|---|---|
| **1（第一刀）** | 增加 `ToolAccessDeclaration`、默认折叠器、规范化 scope resolver；补齐上表的 `⚠️`/未知内置工具声明和 MCP 缺省策略。 | `src/host/protocol/tools.ts`、内置 `*.schema.ts`、`src/host/mcp/mcpToolSafety.ts`、`src/host/security/writeIsolation.ts`、`src/host/tools/dispatch/toolDefinitions.ts` | hermetic schema/折叠表测试；缺字段或 hint 冲突必须落 unknown/readwrite，反向变异把一个显式 `read` 删除后测试变红。 |
| 2 | 用左到右分段替换二分分组，保留并行上限、原 index 回填和终止屏障。 | `src/host/agent/toolExecution/parallelStrategy.ts`、`src/host/agent/runtime/toolExecutionEngine.ts`、相关 loop types | hermetic cases 覆盖读后写、不同路径双写、MCP 无 annotation、终止工具；反向变异恢复“parallel first”后必须红。 |
| 3 | 让静态分段和运行时写锁消费同一 resolver/conflict oracle，补运行时 mismatch trace。 | `src/host/security/writeIsolation.ts`、`src/host/tools/toolExecutor.ts`、`src/host/agent/toolExecution/parallelStrategy.ts` | 同一组 path/workspace fixture 在静态与运行时得到相同 conflict；反向变异让其中一处重新按名字判断必须红。 |
| 4 | 删除零消费的工具级 DAG，清理死基线/历史索引；任务级 DAG 不动。 | `src/host/agent/toolExecution/dagScheduler.ts`、knip baseline、相关 changelog/索引 | `git grep` 无 import/require；任务级 `DAGScheduler` targeted tests 仍绿；反向恢复一个死文件不能让生产消费数变为正。 |

## Decision needed

1. **是否接受 `accesses` 的表达式字段**：建议接受。没有它，MCP、session、terminal、外部连接器只能全部落 unknown，无法逐步收窄并行面；表达式必须是宿主解析的受限 DSL，不能执行任意代码。
2. **未知域是否一律串行**：建议接受 fail-closed。放行的收益只是并发墙钟，误放行会改变模型要求的因果顺序。
3. **终止屏障后的调用如何呈现**：建议返回结构化 deferred/skipped 结果并留在原 index，让下一轮重新生成；绝不在审批前执行。若产品希望把“屏障后的模型调用”视为模型错误，也应保持同一安全边界。
4. **是否删除工具级 DAG**：建议删除。它零生产消费，继续保留只会让未来维护者误以为工具排程已有第二条实现；任务级 `src/host/scheduler/DAGScheduler.ts` 明确保留。

验收状态：本 ADR 停在拍板槽；上述施工单只是提议，未创建。
