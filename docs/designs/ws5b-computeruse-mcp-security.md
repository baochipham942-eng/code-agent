# WS5b — 把 computer-use（控屏）暴露成 MCP 工具的权限门设计

> 状态：Draft · **设计文档，未落地任何代码**。供 owner 签字后再分阶段实现。
> 分支：`feat/capability-mcp`（与 WS5a 同分支；WS5a 已实现，WS5b 仅本文档）
> 关联：[alma-inspired-renovation.md §WS5](./alma-inspired-renovation.md)、WS5a commit `e281196c`
> 范围：仅讨论 **Neo 作为 MCP server**、把 **控屏类危险能力**（`computer` / `execute_command` / `clear_logs`）暴露给外部 agent 的授权门。不涉及 Neo 作为 MCP client。

---

## 0. 一句话

外部 agent 通过 MCP 调用 `computer` 工具 = **拿到了对本机的完整鼠标/键盘/无障碍控制权**。这是 Neo 能暴露的最危险能力，必须有"谁能调 / 如何授权 / 怎么审计 / 何时拒绝 / 二次确认"的完整门，而不是一个布尔开关。本文档设计这道门；落地前需 owner 逐阶段签字。

---

## 1. 背景与动机（基于真实代码，不是假设）

设计文档 §1 与 memory 都记载"Neo 的 MCP server 只暴露 logs/status"。**这是错的。** 审 `src/main/mcp/mcpServer.ts` 发现：

- `computer`（完整控屏：click/type/key/scroll/drag/open_application/computer_batch…）和 `execute_command`（转发命令到运行中 app）**早已在 listTools 暴露**。
- `CallTool` 执行 `computer` 时构造的上下文是 `{ workingDirectory, requestPermission: async () => true }` —— **无条件放行**，把 `ComputerTool` 自己声明的 `requiresPermission: true` / `permissionLevel: 'execute'` 直接架空。

也就是说：**WS5b 本该"门控先行"的控屏能力，在 main 上一直是活的、且对任何连上的 MCP client 零门控开放。** 唯一的"门"是隐式的——Neo 没有自注册到任何外部 `mcp.json`，用户得手动把 `code-agent mcp-server` 加进自己的 client 配置才会启动。但这只是"是否启动 server"的粗粒度开关，一旦启动，**安全读能力和危险控屏没有任何分层**。

### WS5a 已做的止血（Phase 0）

WS5a 把暴露改成 **默认安全**：

- 默认 listTools 只给只读/安全工具（`get_logs`/`get_status`/`screenshot`/`eval-query`/`appshots-query`）。
- `computer`/`execute_command`/`clear_logs` 收到 `DANGEROUS_TOOL_NAMES`，由 `enableComputerControl` 门控（构造参数 → 环境变量 `MCP_ENABLE_COMPUTER_CONTROL=true` 兜底）。关闭时**既不在 listTools 出现，被点名调用也在 CallTool 里拒绝**。

> Phase 0 把"裸奔"降级为"显式 opt-in 的全开/全关"。但**全开仍然太粗**：一旦 `MCP_ENABLE_COMPUTER_CONTROL=true`，连上的 client 就拿到完整控屏，没有 caller 区分、没有目标 app 限定、没有人确认、没有审计。本文档设计的是 Phase 0 之上的**细粒度授权门**。

---

## 2. 威胁模型

**资产**：用户本机的桌面会话——任意 app 的内容（邮件/IM/银行/密码管理器）、文件、可执行的破坏性操作（删文件、转账、发消息、改设置）。

**攻击者 / 风险来源**（不假设恶意，多数是"能力被误用/越权"）：

| 来源 | 场景 |
|---|---|
| 被诱导的外部 agent | 远端 prompt-injection 让某个连到 Neo 的 agent 调 `computer` 干用户没授权的事（在 IM 里发消息、读屏上的敏感信息回传） |
| 配置宽松 | 用户为了某个自动化把 `MCP_ENABLE_COMPUTER_CONTROL=true` 长期开着，忘了它等于常开控屏后门 |
| 多 client 混用 | 用户给可信 client A 配了 Neo，但同一 server 进程/配置被不可信 client B 复用 |
| 焦点劫持 | `type`/`key` 在焦点漂移时把按键打到错误窗口（ComputerTool 文档自己警告过的 foregroundFallback），危险动作落到非预期 app |
| 无痕 | 当前控屏调用**不留任何审计**，事后无法追"谁在什么时候控了什么" |

**威胁结论**：控屏能力的真正风险不是"能不能控"，而是 **(a) 谁让它控、(b) 控什么/控哪、(c) 用户当时知不知情、(d) 事后查不查得到**。授权门必须同时回答这四点。

---

## 3. 设计原则

1. **默认拒绝**（default-deny）：任何不满足全部授权条件的控屏调用一律拒绝并给出 next-action，不"猜着放行"。沿用 ComputerTool 既有 routing contract（缺 permission/foreground/snapshot/坐标证据就 blocked）。
2. **人在回路**（human-in-the-loop）：危险动作默认需要运行中的 Neo 向用户**二次确认**；无人确认通道时不降级为放行。
3. **最小权限**：能力分级 + 目标 app allowlist + 动作子集，能只给"读屏"就不给"控屏"，能只给某个 app 就不放开全机。
4. **可审计**：每次控屏调用 append-only 落审计日志，UI 可见。
5. **可一键熔断**：随时能 kill-switch 关掉控屏暴露，且默认就是关。
6. **能力分离**：`screenshot`/`appshots-query`（读屏，敏感但不可控机）与 `computer`（控机）走不同的门——读屏属 WS5a 安全集，控机属本文档。

---

## 4. 授权门：分层模型

一个控屏调用必须**顺序通过全部 5 层**才执行；任一层不过即 default-deny。

```
外部 agent ──MCP──> Neo MCP server
  L0 server 暴露开关         (MCP_ENABLE_COMPUTER_CONTROL=true，WS5a 已实现)
  L1 caller 身份 + allowlist  (这个 client 是否被允许调控屏)
  L2 能力 / 范围 scoping       (允许的 action 子集 + 目标 app allow/deny + 坐标范围)
  L3 逐次人确认 (二次确认)      (运行中 Neo 弹确认；default-deny on timeout)
  L4 速率 / 时窗 / 熔断        (频率上限、时间盒、随时 kill-switch)
        │ 全通过
        ▼
  执行 ComputerTool（带真实 permission 上下文，不再是 ()=>true 桩）
        │
        ▼
  L5 审计落盘 + UI 可见（无论允许/拒绝都记）
```

### L0 — Server 暴露开关（✅ WS5a 已实现）
`enableComputerControl`（env `MCP_ENABLE_COMPUTER_CONTROL`）。关 = 控屏工具不存在。这是总闸，默认关。

### L1 — Caller 身份与 allowlist（待实现）
- **问题**：stdio MCP 下，server 由 client **作为子进程拉起**，server 进程本身**无法从协议层强认证 caller 身份**（没有 TLS/mTLS/OAuth，谁拉起就是谁）。
- **现实约束**：因此 L1 的"身份"实质是 **"用户在哪个 client 的配置里、用什么参数启动了这个 server"**。可行做法：
  - 为受信场景发一个 **per-client token**：用户在 client 的 `mcp.json` 里以 env 注入 `MCP_COMPUTER_CONTROL_TOKEN=<随机串>`，server 侧比对；token 同时编码"这是哪个 client"。token 缺失/不符 → 拒绝。
  - token 由 **运行中的 Neo UI 生成并展示**（一次性、可吊销、带 label），而不是用户手抄魔法值。吊销 = 改 token，旧配置立即失效。
- **取舍**：token 不是强密码学认证（能拿到配置文件的进程都能读），但它把"启动了 server"和"获得控屏授权"**解耦**——保证控屏授权是用户在 Neo 里**显式签发**的，而非配置 server 的副作用。

### L2 — 能力 / 范围 scoping（待实现）
授权不是布尔，是一个 **scope**：
- **动作分级**：`read`（observe/get_state/get_ax_elements/get_windows/cursor_position/screenshot——其实属 WS5a 安全集）/ `interact`（click/type/scroll/drag/key）/ `launch`（open_application）/ `system`（write_clipboard、execute_command）。授权按级开，默认只到 `read`。
- **目标 app allowlist / denylist**：scope 指定可控 app（`targetApp`/`bundleId`）。**敏感 app 强制 denylist**（密码管理器 1Password/Keychain、银行类、系统设置、终端、Neo 自身——防自我提权）。命中 denylist 直接拒。
- **坐标/窗口约束**：可选限定到某窗口区域，超界拒绝。
- scope 随 L1 token 绑定（不同 token 不同 scope），由 Neo UI 配置。

### L3 — 逐次人确认 / 二次确认（待实现，门的核心）
- **机制**：CallTool 收到 `interact`/`launch`/`system` 级调用时，**不直接执行**，而是经 `logBridge`（已有 `http://127.0.0.1:51820/execute` 反向通道）/ IPC 通知**运行中的 Neo**，由 Neo 在 UI 弹**确认卡片**：展示 caller label、action、目标 app/窗口、关键参数（要点的坐标/要输入的文本预览）。
- **复用 WS3 PiP**：确认卡片可借 WS3 的 computer-use PiP 实时小窗呈现"即将操作的窗口"，让用户所见即所控。
- **决策回传**：用户 Approve/Deny（可"本会话内记住此 app+动作"做有限放行，但默认每次问）。**超时（如 20s）= Deny**。Neo 未运行/无 UI 通道 = **直接拒绝，不降级放行**（对照 WS5a 的 default-deny 哲学）。
- **read 级**（observe/screenshot 等）可配置免确认（属安全集），但仍受 L5 审计。

### L4 — 速率 / 时窗 / 熔断（待实现）
- 频率上限（如每分钟 N 次 interact），超限降级为"必须逐次确认"或拒绝。
- **时间盒授权**：一次 Approve 只在窗口期（如 5min）内有效，过期回到默认拒绝；杜绝"开一次常开"。
- **Kill-switch**：Neo UI 一个显眼开关 / 全局热键，立即切断所有控屏暴露（等价把 L0 拉回关）。

### L5 — 审计（待实现）
- 每次控屏调用（**无论 allow/deny**）append-only 落审计日志：时间、caller label/token id、tool、action、targetApp/bundleId、关键参数摘要、L1-L4 各层结论、最终 result。
- 可复用 `logCollector`（已有 `tool` source）但**单列 `computer-control-audit` 通道**，UI 提供"控屏审计"视图。append-only、不被 `clear_logs` 清（`clear_logs` 本身也是危险工具，受同门控）。

---

## 5. 拒绝用例（落地时即 acceptance 反例）

| # | 场景 | 期望结果 |
|---|---|---|
| D1 | `MCP_ENABLE_COMPUTER_CONTROL` 未开 | listTools 无 `computer`；点名调用被拒（✅ WS5a 已验） |
| D2 | 开了 L0 但无 / 错 token | 拒绝："control not authorized for this client" |
| D3 | scope 只到 `read`，却调 `click` | 拒绝："action 'click' exceeds granted scope (read)" |
| D4 | 目标 app 命中敏感 denylist（如 1Password） | 拒绝："target app is on the protected denylist"，且**记审计** |
| D5 | `interact` 调用但 Neo 未运行/无确认通道 | 拒绝（不放行）："no human-confirmation channel available" |
| D6 | 弹了确认，用户 Deny 或 20s 超时 | 拒绝："denied by user" / "confirmation timed out" |
| D7 | 时间盒过期后复用旧 Approve | 拒绝："authorization window expired, re-confirm" |
| D8 | 超过速率上限 | 降级为强制逐次确认或拒绝 |
| D9 | Kill-switch 已拉 | 全部控屏拒绝，等价 D1 |
| D10 | `type` 触发 foregroundFallback（焦点漂移） | 按 ComputerTool 既有契约 blocked + 要求重走 targetApp+axPath 配方，不盲打 |

---

## 6. 分阶段落地（每阶段 owner 签字门控）

| Phase | 内容 | 状态 |
|---|---|---|
| **0** | 默认安全 + 全开/全关 env 门（`enableComputerControl`） | ✅ WS5a 已实现并验证 |
| **1** | L5 审计先行（控屏调用全量落 append-only 日志 + UI 视图）+ L1 token + L2 敏感 app denylist | 待签字 |
| **2** | L3 逐次人确认（logBridge→Neo UI 确认卡片，复用 WS3 PiP）+ L4 时间盒/熔断 | 待签字 |
| **3** | L2 完整 scoping（动作分级 + app allowlist + 坐标约束）+ 速率治理 | 待签字 |

**排序理由**：先审计（看得见才管得住，且不改放行逻辑、零风险）→ 再人确认（最大安全增益）→ 最后精细 scope。每阶段独立分支、E2E 实证（含拒绝用例）、owner live 验后再合。

---

## 7. Open Questions（需 owner 拍板）

- [ ] L1 token 方案是否够用，还是干脆**不开 stdio 控屏**、只允许"运行中的 Neo 自身发起、外部 agent 不可调"？（最保守：控屏永不 MCP 化，外部 agent 要控屏必须走 Neo 的 agentEngine 由 Neo 主导）
- [ ] 二次确认的默认超时与"本会话记住"的粒度（每次问 vs 每 app 记住 vs 每 action 记住）。
- [ ] 敏感 app denylist 的初始名单（密码管理器、银行、系统设置、终端、Neo 自身——还要加什么？）。
- [ ] 是否需要把 `execute_command` 也纳入同一套门（建议是——它能转发命令到运行中 app，危险等级等同控屏）。
- [ ] 审计日志的留存期与脱敏（输入文本预览是否记全文、是否对密码框输入做掩码）。

---

## 附录 A — 现有代码锚点（实现时对照）

- `src/main/mcp/mcpServer.ts`：`CallTool` 的 `computer`/`screenshot` 分支用 `{ requestPermission: async () => true }` 桩执行——**Phase 1+ 要把它换成接 L1-L4 决策的真实上下文**。WS5a 已加 `DANGEROUS_TOOL_NAMES` 门 + `enableComputerControl`。
- `src/main/tools/vision/ComputerTool.ts`：`requiresPermission: true` / `permissionLevel: 'execute'`，自带 routing contract（缺证据即 blocked）——L3 的 blocked 语义可复用。
- `src/main/mcp/logBridge.ts`：`http://127.0.0.1:51820`，已有 `/execute` 反向通道（标准 server → 运行中 app 转发）——L3 人确认走它。
- `src/shared/constants/misc.ts`：`MCP_CAPABILITY_GATE.DANGEROUS_ENV_FLAG`（WS5a 加）——后续 token/scope 常量同处扩展。
- WS3 PiP（`src-tauri/src/pip.rs` + `useComputerUsePip.ts`）：L3 确认卡片的"所见即所控"小窗可复用。

## 附录 B — 延后的 memory-query 工具（WS5a 本轮不做的目标 API）

WS5a 因 `lightMemory` 正被 WS4 改动而**暂不做 memory-query**（避免合并耦合）。WS4 落地后，按 main 当前只读 API 补一个**只读** memory-query MCP 工具（属 WS5a 安全集，**不受本控屏门约束**）：

- `src/main/lightMemory/indexLoader.ts`：`loadMemoryIndex()` → `INDEX.md` 内容；`getMemoryDir()` → `~/.code-agent/memory/`。
- `src/main/lightMemory/recentConversations.ts`：`buildRecentConversationsBlock()` → 最近会话摘要 markdown。
- `src/main/lightMemory/sessionMetadata.ts`：`buildSessionMetadataBlock()` → 活跃天数/会话数/模型分布。
- 全部纯文件读、standalone 可跑、无敏感控机风险。合并 WS4 后需按其改动后的 API 重验函数名/返回结构。
