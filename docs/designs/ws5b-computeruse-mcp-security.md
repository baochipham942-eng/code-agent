# WS5b — computer-use（控屏）与 MCP 的边界：决策记录

> 状态：**决策已定**（owner 2026-05-27 拍板）· 本文档是决策记录，不是待实现的方案。
> 分支：`feat/capability-mcp`（WS5a 已据此把 MCP server 改为纯只读）
> 关联：[alma-inspired-renovation.md §WS5](./alma-inspired-renovation.md)

---

## 0. 决策（一句话）

**控屏（computer-use）不 MCP 化。** Neo 的 MCP server 只暴露**只读/安全**能力。外部 agent（Claude Code / Codex 等）若需要桌面操作，**必须由 Neo 主导**（走 Neo 自己的 agentEngine / ComputerTool），**不能反向通过 MCP 直接控制本机**。

> 这否决了本文档早先草拟的"给控屏设计一道 MCP 授权门、将来按需开放"的方向。理由见 §3。

---

## 1. 背景：从"裸奔"到"只读"

设计文档 §1 与 memory 记载"Neo 的 MCP server 只暴露 logs/status"——**与代码不符**。审 `src/main/mcp/mcpServer.ts` 发现：

- `computer`（完整控屏：click/type/key/scroll/drag/open_application/computer_batch…）和 `execute_command`（把命令转发到运行中 app）**早已在 MCP 暴露**；
- 执行时上下文是 `{ requestPermission: async () => true }`——**无条件放行**，把 `ComputerTool` 自身 `requiresPermission: true` 的声明架空。

即：本该"门控先行"的控屏能力，在 main 上一直裸奔，对任何连上的 MCP client 零门控。

**演进**：
- WS5a 第一版（commit `e281196c`）先把暴露改为**默认安全**，控屏类工具收到一个 opt-in env flag 后面（默认关）作为止血。
- owner 拍板（本决策）：控屏**永不** MCP 化，opt-in flag 没有存在意义。于是把 `computer` / `execute_command` / `clear_logs`（控屏 / 反向命令执行 / 日志写）**从 MCP surface 彻底移除**，删掉 flag 机制，MCP server 变为**纯只读**。

---

## 2. 威胁模型（决策依据）

**资产**：用户本机桌面会话——任意 app 内容（邮件 / IM / 银行 / 密码管理器）、文件、可执行的破坏性操作。

| 风险来源 | 场景 |
|---|---|
| 被诱导的外部 agent | 远端 prompt-injection 让连到 Neo 的 agent 调控屏，干用户没授权的事（IM 发消息、读屏上敏感信息回传） |
| 配置宽松 | 为某次自动化把控屏长期开着 = 常开控屏后门 |
| stdio 无法强认证 | MCP stdio 下 server 由 client 作为子进程拉起，**协议层拿不到可信 caller 身份**（无 mTLS/OAuth，谁拉起就是谁）——无法在 server 侧区分"可信 client"与"被劫持的 client" |
| 焦点劫持 | `type`/`key` 在焦点漂移时把按键打到错误窗口，危险动作落到非预期 app |
| 无痕 | 控屏调用此前不留审计 |

**关键结论**：控屏的真正风险是 **(a) 谁让它控、(b) 控什么 / 控哪、(c) 用户当时知不知情、(d) 事后查不查得到**。其中 (a) 在 stdio MCP 模型下**根本无法可靠回答**——这是把控屏 MCP 化的死结。

---

## 3. 为什么"不 MCP 化"而不是"加一道门"

早先草拟过一套 5 层授权门（server flag → caller token → 能力 scoping → 逐次人确认 → 审计）。否决它的理由：

1. **caller 身份认证是死结**：stdio MCP 无法可靠认证调用方。token 注入到 client 配置 env 里，能读配置的进程都能拿——它只能证明"启动了 server"，不能证明"这是可信的调用方"。一道认不准调用方的控屏门，是假的安全感。
2. **复杂度 vs 收益失衡**：要做到"安全到可以开放控屏"，至少要人确认 + scoping + 审计 + 熔断四件套，工程量大、长期维护成本高，而真实收益（外部 agent 直接控屏）Neo 自己就能替代（见 §4）。
3. **有更干净的替代**：外部 agent 要的是"让桌面做某件事"，不是"我亲自拿鼠标"。让 **Neo 作为主导方**去做这件事，既满足需求，又把控屏权牢牢留在用户自己的 app 里。
4. **默认安全的最强形式是"不存在"**：能力不暴露 = 不可能被误用。一个不存在的攻击面不需要门。

---

## 4. 正确的控屏路径：Neo 主导，外部 agent 协作

```
外部 agent ──MCP（只读）──> Neo            外部 agent 只能：读日志/状态、截屏、查 eval、查 appshots
                                            —— 看得到，控不了。

需要桌面操作时：
用户 / 外部 agent ──请求──> Neo（agentEngine 主导）──> Neo 的 ComputerTool（带真实 permission 上下文）──> 控屏
                                            —— 控屏权始终在 Neo / 用户这一侧，由 Neo 决策与确认，
                                               不是外部 agent 反向驱动本机。
```

- Neo 的 `services/agentEngine/`（claudeCode / codex adapter）本就是"Neo 编排外部 agent"的方向：**Neo 是 orchestrator，外部 agent 是被调用方**，而不是反过来。
- 控屏继续走 Neo 进程内的 `ComputerTool`，保留其 routing contract（缺 permission/foreground/snapshot/坐标证据即 blocked）与未来可加的人确认（可复用 WS3 PiP 做"所见即所控"）。这些都在 **Neo 自己的信任边界内**，不经过 MCP。

---

## 5. WS5a 现在强制的只读不变量

`src/main/mcp/mcpServer.ts` 暴露的工具集（已 E2E 实证）：

| 工具 | 性质 |
|---|---|
| `get_logs` / `get_status` | 只读（日志 / 状态） |
| `screenshot` | 读屏内容（截屏，敏感但只读、不可控机） |
| `eval-query` | 只读（评测基线 + 趋势） |
| `appshots-query` | 只读（历史抓窗，带路径穿越防护） |

**已移除、且不可通过任何 flag 复活**：`computer`（控屏）、`execute_command`（反向命令执行）、`clear_logs`（日志写）。点名调用返回 `Unknown tool`。

> 不变量：**Neo 的 MCP server 永远只读。任何"让外部 agent 通过 MCP 改 / 控本机"的需求，一律走 Neo 主导，不在此扩展。** 新增 MCP 工具前对照此不变量。

---

## 6. 什么情况下才重启这个讨论

仅当以下**全部**成立时，才值得重新评估（默认不重启）：

- [ ] MCP 传输层支持可信 caller 认证（如带身份的 HTTP + OAuth/mTLS），解决 §2 的 (a) 死结；
- [ ] 有明确产品场景证明"外部 agent 直接控屏"是 Neo 主导路径无法替代的；
- [ ] owner 显式签字接受控屏暴露的剩余风险。

---

## 附录 — 延后的 memory-query 工具（只读，不受本决策约束）

WS5a 因 `lightMemory` 正被 WS4 改动而暂不做 memory-query（避免合并耦合）。WS4 落地后补一个**只读** memory-query MCP 工具（属只读集，与控屏无关）：

- `src/main/lightMemory/indexLoader.ts`：`loadMemoryIndex()` → `INDEX.md`；`getMemoryDir()` → `~/.code-agent/memory/`。
- `src/main/lightMemory/recentConversations.ts`：`buildRecentConversationsBlock()` → 最近会话摘要。
- `src/main/lightMemory/sessionMetadata.ts`：`buildSessionMetadataBlock()` → 活跃天数 / 会话数 / 模型分布。
- 纯文件读、standalone 可跑。合并 WS4 后按其改动后的 API 重验函数名 / 返回结构。
