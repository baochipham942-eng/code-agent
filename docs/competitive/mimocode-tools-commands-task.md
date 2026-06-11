# MiMoCode vs Neo：工具设计 / 命令系统 / Task 系统逐项裁决

> 日期：2026-06-11
> 系列第三篇：六项核心能力见 `mimocode-vs-neo.md`，UX/CLI/runtime 见 `mimocode-design-learnings.md`
> 方法：mimo-tools / neo-tools 两个探索 agent 对照调查，本篇只回答"MiMo 哪里做得更好"

## 裁决总表

| 维度 | MiMoCode | Neo | 裁决 |
|------|----------|-----|------|
| Edit 多级 replacer 链 | 9 级降级链 | 2 级（智能引号+anchor hint） | **MiMo 明显更好** ★P0 |
| /命令系统（协议层） | 统一注册表+模板+MCP 集成 | 仅 UI 约定，无协议层 | **MiMo 明显更好** ★P0 |
| 会话历史搜索（history 工具） | FTS5 BM25 全文检索 | 缺失（只能列会话） | **MiMo 更好** ★P1 |
| task 语义（树/owner/审计） | 树状 ID+owner+事件日志+gate | 扁平+依赖+队列，无 gate | **MiMo 语义更好**，Neo 执行控制更好 |
| bash-interactive 用户接管 | 终端移交用户，不计超时 | PTY 有但无中途交互移交 | **MiMo 更好** |
| shell invocation 模式 | per-tool shell 语法+recover 降级 | 无 | **MiMo 更好**（小模型友好） |
| snapshot git 隔离 | 独立 gitdir，零污染用户 git | SQLite 内容快照（1MB 上限） | **MiMo 更好**（扩展性） |
| 输出截断 | 错误感知头尾 70/30+全文落盘 | 截中间+spill 落盘+guidance | 打平（各有亮点） |
| 工具 description prompt 工程 | 约束完整 | 约束完整（完整性检测更强） | 打平 |
| instructions 加载 | AGENTS.md 稀疏回退规则 | 递归发现 depth 5 | 打平（MiMo 缺 watch Neo 也缺） |
| Auth / Telemetry | 多账户 Record / OTel | Supabase+SecureStorage / OTel 兼容 | 打平 |

---

## 一、Edit 工具的 9 级 replacer 链 —— 差距最大的单点 ★

**MiMoCode**（tool/edit.ts:655-664，逐级降级直到命中）：

1. SimpleReplacer — 精确匹配
2. LineTrimmedReplacer — 行级 trim（行内空白差异容错）
3. BlockAnchorReplacer — 首尾行锚点 + Levenshtein 中间行相似度（阈值 0.3）
4. WhitespaceNormalizedReplacer — 连续空白折叠
5. IndentationFlexibleReplacer — 整体缩进偏移容错
6. EscapeNormalizedReplacer — 转义字符规范化（\n、\t、\"）
7. TrimmedBoundaryReplacer — 全文行级 trim 后匹配
8. ContextAwareReplacer — 函数/类作用域边界感知（MiMo 在 OpenCode 链上新增）
9. MultiOccurrenceReplacer — 最后手段，配合 replaceAll

**Neo**（multiEdit.ts:170-190）：精确匹配 → 智能引号标准化 → 失败后只给最近邻 anchor hint（报错给模型重试，不自动修复）。

**为什么是 P0**：edit 失败 → 模型重读文件重试 → 多烧一轮 token 还可能死循环。这条链直接抬升一次成功率，**对 SWE-bench 类评测分数是直接增益**，且是纯函数实现、可单测、可逐级移植。建议从 2/3/5 三级抄起（行 trim、块锚点、缩进容错覆盖最常见失败）。

## 二、/命令系统 —— Neo 的协议层空白 ★

**MiMoCode**（command/index.ts）的 Command 是一等公民：

```typescript
{ name, description, agent?, model?, source: "command"|"mcp"|"skill",
  template, subtask?, hints: ["$1", "$ARGUMENTS"] }
```

- 模板支持 `$1/$2` 位置参数和 `$ARGUMENTS` 全量参数
- `agent` 字段让命令直接路由到专用子 agent（/dream → dream agent，/review → subtask 运行）
- `model` 字段支持按命令覆盖模型（用 model_groups 的 "ultra"）
- **MCP prompts 自动变成命令**：MCP server 暴露的 prompt 直接进命令注册表
- 自定义命令：config.command 配置即得，`.mimocode/command/<name>.md` 文件式定义（distill 自动产出的就是这种）

**Neo**：/plan、/goal、/workflow 等是渲染层 UI 约定（SlashCommandPopover 预填），后端无统一注册表、无 dispatcher、无模板参数、无自定义命令。skill 体系与命令体系平行不集成。

**连锁影响**：没有命令协议层，distill 式自进化就少了一个最自然的产出形态（"把重复工作流固化成带参数的命令"），用户也无法沉淀自己的工作流入口。这是 Neo 工具/skill 两强之间缺的一块桥。

## 三、history 工具 —— 模型可以查自己的过去 ★

**MiMoCode**（tool/history.ts）：模型可主动调用——
- `search`：FTS5 BM25 检索全部会话记录，可按 kind（tool_input/tool_output/user_text/assistant_text/reasoning）、tool_name、时间范围、session/scope 过滤
- `around`：取某条命中消息的前后 ±5 条上下文

与 memory 工具双轨：**history = 逐字原始日志（精确回忆），memory = 策展后的 markdown（抽象知识）**。dream/distill 的"SQLite 轨迹库为权威来源"也踩在这套索引上。

**Neo**：SessionManager 只有 list/get/archive/rename；记忆侧有 embedding 检索（MemoryRead），但**原始转录无全文索引**，模型无法回答"上次我们怎么解决这个报错的"。补一个 SQLite FTS5 表 + 检索工具即可，顺便为 Neo 未来的 dream/distill 打地基——和第一篇报告的建议 2/3 是同一条基建。

## 四、Task 系统 —— 各赢一半

**MiMo 赢在语义层**：
- 树状 ID（T1 → T1.1 → T1.1.2，nextChildId 自增，无深度上限）
- `owner = actorID` 所有权语义：subagent 的任务归 subagent，orphan 任务（subagent 死了）由主 session 接管
- 完整事件日志（created/started/unstarted/blocked/unblocked/done/abandoned/renamed）可审计可回放
- **taskGate**（task/gate.ts）：想 stop 时查 open/in_progress 任务，注入 "`task done <id>` or `task abandon <id> <reason>`" 重入；subagent 上限 2 次、main 上限 3 次重入——防跑飞
- cleanup_after 7 天自动归档

**Neo 赢在执行控制层**：blocks/blockedBy 双向依赖、优先级、3 并发 semaphore + 等待队列 + 5 分钟队列超时、soft→hard 两级取消、DAG 可视化（SwarmDependencyMap）。这些 MiMo 都没有。

**Neo 缺的三件**：taskGate（数据现成，是第二篇报告建议 #5）、树状子任务分解、任务→agent 自动路由（现在必须手工指定 owner）。

## 五、值得单独点名的散点

**bash-interactive 的用户接管**（tool/bash-interactive.ts）：命令需要密码/确认（sudo、ssh、git push 认证）时 `interactive: true`，**终端直接移交用户操作，等待期间不计超时**，事件对（bash.interactive.asked/replied）驱动 UI。Neo 的 PTY 只能等完成后拿最终输出，中途交互场景（确认提示、密码）会卡死或超时——桌面产品补这个体验收益明显。

**shell invocation 模式**（tool/invocation-style.ts）：工具可声明 `shell.parse(script)`，让模型用 shell 语法调工具而非 JSON，带 `recover()` 降级回 JSON。对 shell 语料训练充分、JSON 模式弱的模型（包括很多国产模型）能显著降低参数格式错误率——Neo 接 DeepSeek/Kimi 等多 provider，这个选项有实际价值。

**snapshot 的 git 隔离**（snapshot/index.ts:86）：`--git-dir ~/.mimocode/snapshot/<project_id>/<worktree_hash> --work-tree <用户目录>`——借 git 的对象存储和 diff 能力做快照，但 gitdir 完全在自己数据目录下，零污染用户仓库，天然去重、支持大文件、diff 免费。Neo 的 SQLite 内容快照实现简单但有 1MB 文件上限 + 每 session 50 个的天花板，且不带 diff 能力。

**截断的错误感知**（tool/truncate.ts:75-115）：截断前扫描输出末尾 2048 字符找 error/exception/traceback/panic 模式，有错误则头 70% 尾 30% 分配预算（保住报错信息），没错误才纯 head 截断；全文落盘 + `metadata.truncated/outputPath` 给模型回查信号；且截断在 Tool.define 框架层自动包裹，工具作者无感。Neo 的截断（截中间+spill+guidance）已经不错，差距只在错误感知这一个细节。

**instructions 稀疏回退**（session/instruction.ts:23-25）：项目 AGENTS.md < 500 字符时自动补充加载 CLAUDE.md——"主文件太薄就拉备份"的小聪明，迁移期产品（兼容 Claude Code 生态）很实用。

## 六、汇总到 Neo 的行动清单（合并三篇报告，工具侧增量）

**P0（直接抬评测分/补协议空白）**
1. Edit replacer 链：先抄 LineTrimmed / BlockAnchor+Levenshtein / IndentationFlexible 三级
2. /命令协议层：注册表 + frontmatter（agent/model/subtask）+ $ARGUMENTS 模板 + 文件式自定义命令——同时是 distill 自进化的产出载体

**P1（基建复用度高）**
3. 会话转录 FTS5 索引 + history 工具（兼为 dream/distill 打地基）
4. taskGate（TaskManager 数据现成，加 stop 前检查 + 重入 nudge + 上限）

**P2（体验/稳健性）**
5. bash-interactive 用户接管模式
6. snapshot 迁移到隔离 gitdir 方案（或至少解除 1MB/50 个限制）
7. 截断加错误模式感知的头尾分配
8. shell invocation 作为可配置项（针对 JSON 弱的 provider）
