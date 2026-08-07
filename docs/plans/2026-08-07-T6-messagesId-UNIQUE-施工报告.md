# T6 · getSnapshot 报 messages.id UNIQUE 约束冲突 — 施工报告

工单：`code-agent-private-archive/docs/plans/tickets/2026-08-07-T6-messagesId-UNIQUE-工单.md`
worktree：`/Users/linchen/Downloads/ai/code-agent/.claude/worktrees/agent-a178cf30b23098983`

## 1. 双写成因

**入口**：`src/host/ipc/surfaceExecution.ipc.ts:352-360` 的 `getSnapshot` action
→ `SurfaceConversationProjectionService.getSnapshot`
（`src/host/services/surfaceExecution/SurfaceConversationProjectionService.ts:615-616`）
→ `requireOwnedConversation`（同文件 752-757）
→ **`SessionManager.getSession()`**（`src/host/services/infra/sessionManager.ts:367`）。

`getSession()` 名义上是读操作，但在以下分支里会写库：

```
src/host/services/infra/sessionManager.ts:400-417
    // 懒加载：只加载最近 N 条消息（性能优化）
    let messages = db.getRecentMessages(sessionId, messageLimit);

    // 如果本地没有消息，尝试从云端拉取
    if (messages.length === 0) {
      const cloudMessages = await this.pullMessagesFromCloud(sessionId);
      if (cloudMessages.length > 0) {
        for (const msg of cloudMessages) {
          db.addMessage(sessionId, msg, {
            skipTimestampUpdate: true,
            syncOrigin: 'remote'
          });
        }
        ...
```

关键点：`getRecentMessages()`（`SessionRepository.ts:862-874`）默认只统计
`visibility = 'active'` 的消息（`activeMessageWhere()`，
`sessionRepositoryParsers.ts:19-21`），**不是"本地是否存在这条消息"，而是
"本地是否存在活跃消息"**。当会话的消息因撤回（rewind/hidden）不计入活跃计数
时，`messages.length === 0` 仍然成立，于是判定"本地没有消息"去云端回填；
云端返回的正是本地已经存在（只是被隐藏）的同 id 消息，随后
`SessionRepository.addMessage`（`SessionRepository.ts:561-569`，改动前）对
`messages` 表做**无条件严格 `INSERT`**，命中 `id TEXT PRIMARY KEY`
（`database/schema.ts:52`，全局唯一，非按 session 复合键）主键冲突，抛出
`UNIQUE constraint failed: messages.id`，未被任何 `catch` 拦截，一路冒泡到
IPC 顶层的通用异常处理器（`surfaceExecution.ipc.ts:443-448`），落成真机日志
里的 `Surface Execution domain action failed action=getSnapshot`。

同一条链路对并发调用同样脆弱：两次几乎同时的 `getSnapshot`
（真机日志 08:11:37.682 / 08:11:39.127）都可能在对方完成回填前读到
`messages.length === 0`，各自发起云端拉取并各自 `addMessage`，第二个必然
撞主键。两种触发方式（隐藏消息 vs 并发回填）根因相同：**读路径的"本地没有
消息"判断与它触发的写路径的"消息是否已存在"判断不是同一个谓词**。

`syncService.ts:396-425` 里结构相同的云端拉取分支已经在写之前做了
`localMessages.find((m) => m.id === remote.id)` 的存在性检查，唯独
`sessionManager.ts` 的懒加载回填分支没有——这是本次要补的那个漏洞。

## 2. 修复方式

没有在调用方加"先查后插"（那只是把同一个漏洞在另一处再犯一次，而且检查和
写入之间仍有竞态窗口），而是把幂等性下沉到所有调用者都要经过的
`SessionRepository.addMessage()`（`SessionRepository.ts:561-639`）：

- 按 `options.syncOrigin` 区分写入语义：
  - `'remote'`（云端回填/水合）→ `INSERT OR IGNORE`。这类写入的语义就是
    "把云端已有的这条消息同步到本地"，本地如果已经有同 id 的行，说明它已经
    被同步过或本地状态更新过（例如被撤回），**必须保留本地状态**，不能用
    `OR REPLACE` 覆盖——工单明确禁止的"无脑 OR REPLACE 盖数据"。
  - 默认（本地写入路径，未传 `syncOrigin` 或 `'local'`）→ 保持严格
    `INSERT`。同 id 冲突在这条路径上意味着真实的 ID 生成 bug，必须继续
    报错，不能被静默吞掉。
- `stmt.run()` 返回值的 `changes === 0` 表示 `OR IGNORE` 命中了冲突（no-op），
  此时跳过后续的账本追加（`conversationBranchRepo.appendMessage`）和
  `sessions.updated_at` 时间戳更新——本地状态没有任何变化，没有东西需要
  记账。

`syncService.ts:423` 也用了 `syncOrigin: 'remote'`，同样获得这条防护（原本
它已经有存在性检查，这次是双保险，关闭了检查和写入之间的竞态窗口）。全仓
`syncOrigin: 'remote'` 的其余出现（`createSessionWithId` / `updateSession` /
`deleteSession` 相关调用）都不经过 `addMessage`，不受影响。

## 3. 测试

新增两份回归测试，均按"构造已存在同 id 消息的库状态"来钉死：

- `tests/unit/services/SessionRepository.remoteMessageIdempotency.test.ts`
  真实内存 SQLite（`applySchema` + `applyConversationBranchSchema`），直接
  测 `addMessage` 契约：
  1. `syncOrigin:'remote'` 对已存在的消息 id 是幂等 no-op——不抛错、
     内容不被覆盖、账本条目不重复。
  2. 不带 `syncOrigin`（本地写入路径）对已存在的 id 依旧严格抛
     `UNIQUE constraint failed`——锁住"真实 ID 冲突不能被静默吞掉"的契约。
- `tests/unit/services/infra/sessionManager.cloudPullMessageIdempotency.test.ts`
  真实文件 SQLite + 打桩 Supabase，端到端跑 `SessionManager.getSession()`：
  1. 本地存在一条 `visibility='hidden'` 的消息（active 计数为 0，触发懒加载
     回填），云端返回同 id、不同内容的"撤回前快照"——断言 `getSession()`
     不抛错，且本地行的内容与隐藏标记原样保留（数据不丢、不被云端覆盖）。
  2. 对照组：本地真的没有消息时，云端回填照常把新消息写入本地——证明幂等
     修复没有误伤正常的云端水合路径。

**fault-injection**：两份测试都手动 `git stash` 掉 `SessionRepository.ts`
的修复后重跑，确认两个用例都变红（分别报出 `SqliteError:
UNIQUE constraint failed…` 和 `promise rejected "SqliteError{…}" instead of
resolving`，与真机症状一致），再 `git stash pop` 复验转绿。

### 证据档位

- **static-contract**：`npm run typecheck`（tsc --noEmit，0 错误）+
  `node scripts/eslint-ratchet.mjs`（errors 0/0、warnings 416/416，两条基线
  均持平未新增）
- **fault-injection**：上述两份新测试，回退修复后真的变红（真实抛出与生产
  日志一致的 `SqliteError: UNIQUE constraint failed: messages.id`），复原后
  转绿
- **hermetic-protocol**：`sessionManager.cloudPullMessageIdempotency.test.ts`
  的 Supabase 打桩部分（协议形状锁定，非真实云端往返）

全量 `vitest run` 计数见下节。

## 4. commit 列表

- `e9f7be54a` `fix(session): getSnapshot 云端回填对已存在的 messages.id 幂等（T6）`
  （`git show --stat` 三个文件：`SessionRepository.ts` +12/-2、两份新测试文件）

只 commit，未 push。

## 5. 全量测试计数

`rtk proxy npx vitest run --reporter=json`（load average 降到 ~43-64 后跑通，
`--outputFile` 落盘完整 JSON）：

- **19354 tests total → 19286 passed / 6 failed / 7 skipped**
- 6725 suites total → 6723 passed，1 个 suite 文件出现失败断言
  （`numFailedTestSuites` 报 2，但逐条扫描 `testResults[].status` 只有
  一个文件的状态不是 `passed`，怀疑是 vitest JSON 聚合的计数口径小
  差异，未继续深挖，不影响结论）
- 6 个失败全部集中在同一个文件
  `tests/unit/services/capabilities/capabilityCenterService.test.ts`
  （MCP 能力注册表信任校验，与本次改动的 session/message 数据层完全
  无关）。`git log` 该文件最后一次改动是 08-03（`fix(test): capabilityCenter
  单测走 remoteCapabili...`），早于本次施工，判定为**已有基线失败，非本
  次改动引入**。
- 本次新增的两份回归测试（4 个用例）在这次全量跑里全部 `passed`。

证据档位：**static-contract**（typecheck 0 错误 + eslint-ratchet errors
0/0、warnings 416/416 两条基线持平）+ **fault-injection**（两份新测试回退
后手动验证真的变红，复原后转绿）+ **hermetic-protocol**（Supabase 打桩部分
协议契约）。全量 vitest 因本机与同会话内多个并行施工 agent 抢占 CPU，前几次
尝试遭遇 rtk 钩子静默吞输出 / harness 超时移入后台 / 无效 reporter 参数 /
`EINTR` 进程级崩溃四种环境故障，最终改用 `rtk proxy` + 显式落盘 JSON 报表在
负载回落后跑通，过程记录在案供复核。

## 6. 遗留项 / 已知风险

- 未做 real-runtime（真机打包点击）验证——改动局限于 host 层 SQLite 写入
  语义，风险面是 IPC 协议之下的纯数据层逻辑，本地 fault-injection +
  hermetic-protocol 组合已覆盖真实失败路径，风险可接受；如需真机复核，
  建议下次批量 dogfood 时用工单描述的"强杀重启后看 getSnapshot 日志"场景
  验证一次。
- `capabilityCenterService.test.ts` 的 6 个基线失败与本工单无关，未顺手修，
  留给对应负责人处理。
