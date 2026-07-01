# ADR-031 — @Neo 运行时安全护栏（approved Neo run 的 fail-closed 工具边界）

- 状态: accepted
- 日期: 2026-07-01
- 相关: [[ADR-029]]（统一 Evidence / Provenance 契约）、`neoTagRuntimeService`、`toolExecutor.neoTagWriteScope`

## 背景：可见的工作卡流不是真正的 P0 阻塞

`@neo` 提及触发「工作卡草稿 → 审批 → 运行 → 结果复核」链路。把它当作可以放行的产品能力之前，真正的 P0 缺口不在可见的工作卡 UI，而在于——**一个被审批的 Neo 运行，可以经非文件类工具在工作卡复核面之外突变状态**。

Neo 运行的信任模型是「人批一次预算 → AI 自主执行 → 人在结果复核面看产物」。这个模型只有在「AI 自主段能造成的副作用被约束在可复核的产物内」时才成立。但普通工具权限/分类路径并不区分「这是一次被审批的 Neo 自主运行」还是「用户逐步手动操作」——于是 Neo 运行期间，`git push` / `MemoryWrite` / 多 agent 派生 / MCP 写工具等都能直接改变世界状态，且不进工作卡复核账本。

净效果：**审批语义（人批预算、事后复核产物）与工具能力（运行期可任意突变状态）错配。** 这不是 UI 问题，是运行时缺一道 fail-closed 的边界。

## 决策：以 `neoTag` 运行时上下文为范围的 fail-closed 护栏

给 approved Neo Tag 运行时调用（由 `neoTag` 运行时上下文标记）加一道**默认拒绝状态突变、只放行只读观察**的护栏。普通非 Neo 工具调用**保持原有权限/分类路径不变**——护栏只作用于 Neo 运行段，不影响手动操作。

### 运行期阻断（Neo run 内）

- 直接 git/shell 状态突变：`git_commit` add/commit/push、`git_worktree` add/remove/prune、`kill_shell`
- 多 agent、workflow、teammate 的写动作
- planning / findings / task / plan-mode 的突变动作
- `MemoryWrite` 写/删路径（已审批的记忆仍可作为结果复核候选）
- `SkillCreate`、技能创建别名、`propose_role`
- calendar / reminders / mail 连接器的写动作
- MCP `add_server` 与工具调用路径（含不明确只读的直接 MCP 工具调用）
- process submit/write/kill 动作及别名

### 运行期放行（Neo run 内）

- git 观察：status / log / diff / worktree list
- 多 agent / workflow / teammate 观察：collect / wait / status / result / inbox / history
- planning / task 读：read / list / get / status
- `MemoryRead`
- calendar / reminders / mail 的 read/list/search/get/status/history
- MCP status、list tools/resources、read resource
- process list/poll/log/status/read

## 为什么是 fail-closed（默认拒绝）而非白名单放行

工具面持续增长，新工具默认应被 Neo 运行视为「不明确即拒绝」，而非「未显式禁止即放行」。对不明确只读性的 MCP 直接调用尤其如此——把「不确定」归到拒绝侧，才能保证审批语义不被新增工具悄悄绕过。

## 后果

- **收益**：approved Neo 自主运行能造成的副作用被约束在可复核产物内；审批预算语义（[[ADR-029]] 证据链）与运行期工具能力重新对齐。
- **代价 / 风险**：
  - 护栏范围严格绑定 `neoTag` 运行时上下文——普通工具调用零回归（守卫测 `toolExecutor.neoTagWriteScope` 断言）。
  - 被阻断的非文件工具尝试当前只返回工具错误；结构化风险呈现（作为 result review 的 risk delta）列入 backlog。

## 验证口径

- focused guard 套件（`neoTagRuntime` + `toolExecutor.neoTagWriteScope`）、Neo main focused 套件、typecheck、diff check 全过 → P0/P1 安全护栏门视为通过。

## Deferred / Open

- 给 MCP 与连接器工具加能力元数据，使未来 Neo 运行仅在工作卡显式批准该外部目标时才放行特定可写工具。
- 把被阻断的非文件工具尝试在结果复核面呈现为结构化 risk delta，而非仅返回工具错误。
- 补一个 P2 UI 冒烟，覆盖完整 `@neo → draft → approve → run → result review → memory candidate` 路径。
