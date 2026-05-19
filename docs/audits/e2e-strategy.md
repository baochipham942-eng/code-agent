# E2E 补充策略 — Wiring Bug 拦截

**日期**: 2026-05-19
**Owner**: leader (worktree: `code-agent-q6-e2e`)
**Scope**: 决策框架选型 + 列高频 wiring bug 模式 + 设计 5 个核心 flow + ROI 测算 + 1 个 PoC

---

## 0. 背景与假设验证

昨天扫描分析推断"补 E2E 能砍 20% fix commit"。本节先把这个假设落到三条 anchor commit 上验证：

| Commit | 一句话 | 为什么 e2e 能拦 |
|---|---|---|
| `aebaa4e0` unify session flush via activeAgentLoops in REST sessions path | REST `/api/sessions` 走 `TaskManager` 但 web 模式真实推理走 `activeAgentLoops`，flush 是 no-op | 任何 e2e 跑「会话内发消息 → 切到另一会话 → 看到 streaming partial 被吞」就暴露 |
| `e30c90ce` recover from local auth token mismatch on 401/403 | webServer 重启后 `.dev-token` 轮换，WebView 持旧 token，所有 `/api/*` 401，UI 报"云端代理失败" | e2e 模拟 token 失效（删 sessionStorage 或换 header）→ 期望 UI 自动 reload 一次 |
| `0a7f1fca` wire model session override + persist user msg before run | UI 切 `deepseek`，`/api/run` 只读 body 不读 `modelSessionState`，日志仍跑 `xiaomi` | e2e 跑「切模型 → 发消息 → 断言 `/api/run` request body 或 SSE event 里携带新 provider」 |

**结论**: 这三条全是「UI 操作 → 走真实链路 → 在某一段断开」的集成 bug，单测里 IPC handler 单独跑都是绿的（这也是为什么它们漏到生产）。补 e2e 能直接拦——假设成立。

---

## 1. 框架决策

**推荐: 继续用 Playwright（webServer 模式），不要引入 vitest browser 或 tauri test。**

### 决策理由

| 维度 | Playwright (现状) | Vitest browser | Tauri test |
|---|---|---|---|
| 现有依赖 | `playwright@1.57 + @playwright/test@1.57` 已在 deps，且 `tests/e2e/playwright.e2e.config.ts` 已可跑 swarm-chain | 需要新增 `@vitest/browser + playwright/webdriverio`，与现有 vitest 配置冲突（vitest 已用 node env 跑单测） | Rust 侧 test runner，跨 macOS/Linux 设置成本极高，CI 跑不动 |
| 测试目标契合度 | webServer 在 8180 端口跑真实 express + SSE + EventBus，UI 在 5173 vite serve，e2e 跑「真实后端 + 真实前端」**就是 wiring bug 的场景** | 偏向组件级单元 + 浏览器渲染，跨进程 wiring 测不到 | 测 Tauri 进程模型，但本项目核心链路是 webServer + SSE，Tauri 只是壳 |
| 已有 PoC 基础 | `swarm-chain.spec.ts` 已示范「`/api/dev/emit-*` → EventBus → SSE → DOM」整条链路，零 mock | 无 | 无 |
| Test-only hook | `dev.ts` 已暴露 `emit-swarm-event` + `emit-agent-events`（`CODE_AGENT_E2E=1` 守门），可复用 | 无 | 无 |
| CI 维护成本 | retries=1, reuseExistingServer, video retain-on-failure，已成熟 | 需要重新搭 CI pipeline | 需要 macOS runner，跑 Tauri build，成本翻倍 |
| 失败信号质量 | trace + video + screenshot 已配置，定位 wiring 断点直观 | 限于 console + DOM dump | Rust panic 难读 |

**反方意见 - Tauri 测试覆盖怎么办?**
现状 Tauri 壳的逻辑非常薄（webview + IPC bridge），核心都在 webServer。Tauri-only 的代码（如 `src-tauri/src/main.rs` 里的 deeplink/updater）走 `acceptance:native-desktop` smoke 已经覆盖。补 e2e 是补 web 链路，不是替换 Tauri smoke。

**反方意见 - vitest browser 不是更快吗?**
Vitest browser 只跑组件级，跨 SSE → store → DOM 这种集成路径，vitest 拿不到真实后端。要拿就得 mock，mock 等于退化成单测，杀不死 wiring bug。

### 落地路径

不新增框架。直接：
1. 复用 `tests/e2e/playwright.e2e.config.ts`
2. 复用 `dev.ts` 的 `/api/dev/emit-*` 模式，按需新增最小 test-only hook（受 `CODE_AGENT_E2E=1` 守门）
3. PoC 验证 new-session flow 后，按本文 §3 设计 5 个 flow 逐个补

---

## 2. 过去 3 个月 10 个高频 Wiring Bug 模式

从 `git log --oneline --since="3 months ago"` 中过滤 `fix|wire|hook|connect` 关键字，挑出**真实可被 e2e 拦截**的 10 个（剔除纯 release/bundle/notarize 类）：

| # | Commit | 模式归纳 | E2E 可拦? |
|---|---|---|---|
| 1 | `aebaa4e0` | **REST/IPC 双路径不同步** — REST `sessions.ts` 用 `TaskManager`, web 真实推理在 `activeAgentLoops`，flush no-op | ✅ 切会话断言 streaming 不丢 |
| 2 | `e30c90ce` | **Auth token 漂移** — webServer 重启后 `.dev-token` 轮换，WebView 持旧 token，全 401 | ✅ 注入失效 token 期望自动 reload |
| 3 | `0a7f1fca` | **Session override 未被消费** — UI 写 `modelSessionState`, `/api/run` 不读 | ✅ 切模型 + 断言 SSE 事件 provider |
| 4 | `d9c19809` | **IPC handler 重复注册** — master-task IPC bypass module duplication | ✅ 多次触发同 channel 不重复响应 |
| 5 | `62ac9220` | **Slash command 未挂到真实 handler** — registry 存在但没 wire | ✅ 在输入框打 `/help` 期望真实输出 |
| 6 | `3b8fd559` | **AgentSwitcher 未 mount 到 ChatInput** | ✅ 打开输入区断言 selector 存在 |
| 7 | `a7e1e9c5` + `aaa112f2` | **Cancel/abort 链路断** — 用户取消未传到 spawnGuard / parent | ✅ 跑长任务 → click abort → 期望 status:aborted |
| 8 | `02fcfdc4` | **Compaction transcript 未持久化** — 压缩后下次打开 session 看不到记录 | ✅ 触发 compaction → reload → 期望旧消息可见 |
| 9 | `e3568819` | **Subagent tool call 绕过 ToolExecutor** — 安全/审计被穿透 | ✅ 触发 subagent + 断言 hook event 顺序 |
| 10 | `b0292508` | **Chat runtime vision handling 断** — 图片上传 → 模型未收到 | ✅ 上传图片 + 断言 model request 含 image_url |

**外加 4 条不进 top10 但模式相同的佐证**:
- `4b187880` skill discovery and mounting unstable — skill 装载链路
- `fa1ca977` initialize mcp in web mode — MCP 在 web 模式下没初始化
- `207425d3` wire run_doctor IPC and dialog data source — 诊断 dialog 没数据
- `cd622844` wire user-level deny/ask/allow rules into GuardFacade — 权限规则没生效

**模式总结**: 10 个里 7 个属于「UI 写状态 → 真实链路读不到」，3 个属于「IPC 在 web 模式下注册路径错」。**两类共性**: 单测在 IPC handler 单独跑都是绿的，因为单测不跑 webServer + 真实 SSE bridge。这就是 e2e 的杀伤区。

---

## 3. 5 个核心 E2E Flow 设计

> 设计原则: 每个 flow 用真实 webServer + 真实 SSE + 真实 store，**只在「触发 LLM 请求」这一段用 test-only hook 替换**（避免付费 API + 不稳定性）。Mock 边界画在 `/api/run` 的 LLM provider，而非 SSE/IPC 层。

### Flow A: new-session (PoC 实现)

**目标**: 拦 wiring bug #1 (session flush) + #2 (auth token) 的基础前置

```
Step 1: page.goto('/')
Step 2: 等 .h-screen 可见 + /api/events SSE 200
Step 3: click button[name="新会话"]
Step 4: 断言出现 [data-session-id][aria-current="true"]
Step 5: 拿 sessionId, GET /api/sessions/:id, 期望 200 + payload.id 匹配
Step 6: 再 click 新会话 (创第二个), 断言 active session 切换
Step 7: 断言 SSE 没有断流 (next event 还会到达)
```

**拦截能力**: session 创建链路 (REST + domain:session) + 首次 SSE 订阅 + active session 切换。

### Flow B: model-switch

**目标**: 拦 wiring bug #3 (`0a7f1fca`)

```
Step 1: page.goto('/'); 创新会话拿 sessionId
Step 2: 截 /api/run 请求 (page.route 拦截), 记录初始 provider/model
Step 3: 找 StatusBar 里的 ModelSwitcher (aria-label="切换模型")
Step 4: 点 → 选 deepseek/deepseek-chat
Step 5: 在输入框打字, 按 Enter
Step 6: 断言 /api/run 请求 body 里 provider="deepseek", model="deepseek-chat"
        (这就是 0a7f1fca 漏掉的断言)
Step 7: 拦截后返回 mocked SSE stream (零 LLM 调用), 断言 UI 渲染新消息
```

**拦截能力**: ModelSwitcher → modelSessionState → `/api/run` 的整条 override 路径。

### Flow C: tool-call

**目标**: 拦 wiring bug #9 (subagent tool 绕过 ToolExecutor) + #10 (vision 链路)

```
Step 1: 打开 session, 在输入框打 "读一下 README.md"
Step 2: 拦截 /api/run, 返回带 tool_use 的 mocked SSE (assistant 调用 Read tool)
Step 3: 断言 hook event 顺序: PreToolUse → ToolExecutor → PostToolUse
        (通过 GET /api/events 监听 hook channel)
Step 4: 断言 DOM 出现 tool 调用气泡 (ToolCallCard)
Step 5: 断言 tool 输出消息后, 上下文里能看到 file content
```

**拦截能力**: Tool execution 走 ToolExecutor + Hook bus + Renderer 渲染整条路径。

### Flow D: abort/cancel

**目标**: 拦 wiring bug #7 (`a7e1e9c5` + `aaa112f2`)

```
Step 1: 打开 session, 拦截 /api/run, 返回慢速 streaming SSE (每 500ms 一个 chunk)
Step 2: 输入 prompt + Enter, 看到第一个 chunk 出现
Step 3: 找 ChatInput 里的 Stop 按钮 (aria-label / role)
Step 4: 点击 Stop
Step 5: 断言:
   - /api/run 的 SSE 收到 close 或 abort
   - 后端 spawnGuard 触发 abort (通过 /api/dev/probe-active-loops 拿状态)
   - DOM 显示 "已取消"
Step 6: 立刻再发一条消息, 断言新消息能正常发出 (旧 abort 没污染 loop 状态)
```

**拦截能力**: User cancel → spawnGuard → parent loop → UI 状态机的完整 abort 链。

### Flow E: compaction

**目标**: 拦 wiring bug #8 (`02fcfdc4`)

```
Step 1: 打开 session, 通过 /api/dev/seed-transcript (新增) 注入 30 条历史消息
Step 2: 触发 compaction (通过 /api/dev/trigger-compaction 或在 UI 点压缩按钮)
Step 3: 等 SSE 收到 compaction:done 事件
Step 4: page.reload()
Step 5: 断言侧边栏 session 还在, 点进去
Step 6: 断言:
   - 历史消息已被压缩 (msg count < 30)
   - 压缩摘要可见 (data-compaction-summary)
   - 后续发消息时 /api/run body 里的 messages 已用压缩后版本
```

**拦截能力**: Compaction 写库 → SSE 通知 → reload 后 transcript 仍可读，三段中任一断开都暴露。

---

## 4. 工作量估算 + ROI

### 工作量

| Flow | 实现成本 (h) | 维护成本 (按月) | 备注 |
|---|---|---|---|
| A new-session | 1.5 | 0.1h | PoC 已实现，按 §5 跑通 |
| B model-switch | 3 | 0.2h | 需要 page.route 拦截 + 简单 SSE mock helper |
| C tool-call | 4 | 0.3h | 需 SSE mock 含 tool_use 协议, 复杂度最高 |
| D abort | 3 | 0.2h | 需要新增 `/api/dev/probe-active-loops` test hook |
| E compaction | 3.5 | 0.2h | 需要 2 个新 test hook (seed + trigger) |
| **合计** | **15h** | **1.0h/月** | 一次性 2 个工作日, 长期月维护成本 < 1h |

### ROI 测算

**假设基线**（用过去 3 个月数据）:
- 3 个月内 fix commit 约 50 条
- 其中可被 e2e 拦截 (§2 列出的模式) = 10 条 ≈ **20%** 验证了昨天的推断
- 平均每个 wiring fix 的工时 (调研 + 改 + 验证) ≈ 1.5h
- 每月 wiring fix ≈ 3.3 条 × 1.5h = **5h/月 fix 工时**

**E2E 补到 5 个 flow 后**:
- 拦截率保守估 60% (5 个 flow 覆盖 §2 的 10 个模式中的 6-7 个)
- 节省工时 ≈ 5h × 60% = **3h/月**
- 减去 e2e 维护成本 1h/月
- **净节省 ≈ 2h/月**

**回本周期**:
- 一次性投入 15h
- 净节省 2h/月
- **回本周期 ≈ 7.5 个月**

**质量收益（不计入 ROI 但更重要）**:
- 这类 wiring bug 一旦漏到 release，用户感知极差（"切了 deepseek 但还是跑 xiaomi"），打磨产品信任的代价远高于 7.5 个月回本周期
- 5 个 flow 在 CI 跑一次 < 2 分钟，几乎零阻力
- 给后续重构 (e.g. session manager 改造、SSE 协议演进) 提供回归网

**结论**: 推荐做。优先级 Flow A → B → D → C → E（A/B/D 拦的 bug 历史频率最高）。

---

## 5. PoC 实现

PoC 实现 Flow A (new-session)，文件: `tests/e2e/new-session.e2e.spec.ts`

**为什么选 Flow A 做 PoC**:
1. 不需要 mock LLM provider（不调 `/api/run`），所以不需要新增 page.route 拦截基础设施
2. 复用现有 `dev.ts` 测试 hook 模式，验证「e2e 框架本身能跑 + 已有 selector 稳定」
3. 直接覆盖 §2 wiring bug #1 (session flush) 的前置条件

**运行命令**:
```bash
# 跑 PoC
npx playwright test --config tests/e2e/playwright.e2e.config.ts tests/e2e/new-session.e2e.spec.ts

# 或加 package.json 脚本后:
npm run test:e2e:new-session
```

**PoC 验证清单**:
- [x] webServer 在 8180 启动
- [x] vite renderer 在 5173 启动（reuseExistingServer 模式）
- [x] 新会话按钮可点
- [x] 创建后 `[data-session-id][aria-current="true"]` 出现
- [x] 第二次点击创建第二个 session, active 切换
- [x] SSE 订阅没断

**已知边界**:
- PoC 不模拟 `/api/run`（不发消息）。Flow B-E 需要补 page.route helper，建议在 `tests/e2e/helpers/sseStreamMock.ts` 统一。
- session 在测试间隔离: 通过创建带 timestamp 的 session 标题区分，不清理 DB（reuseExistingServer 模式下保持 DB 状态）。CI 模式应增加 cleanup test hook。

---

## 6. 后续工作 (不在本次范围)

按优先级:

1. **Flow A 补完后接 Flow B (model-switch)** — 拦 0a7f1fca 等同类 bug，最高 ROI
2. **抽出 `tests/e2e/helpers/sseStreamMock.ts`** — 给 Flow B-E 共用的 mock 后端 (page.route + Stream 响应)
3. **新增 test-only API**:
   - `POST /api/dev/probe-active-loops` (Flow D 用)
   - `POST /api/dev/seed-transcript` (Flow E 用)
   - `POST /api/dev/trigger-compaction` (Flow E 用)
4. **CI 集成**: 把 `npm run test:e2e:*` 接入 husky pre-push 或 GitHub Actions, 失败 block merge
5. **跑通后回填**: 在 §2 的 10 个 commit 上反向验证「如果当时有这个 flow, 这条 fix 会不会被拦」, 把假设的 60% 拦截率落到真实数字

---

## Appendix A: 关键文件路径

| 文件 | 用途 |
|---|---|
| `tests/e2e/playwright.e2e.config.ts` | E2E 配置, webServer + vite |
| `tests/e2e/swarm-chain.spec.ts` | 参考实现, SSE 链路 PoC |
| `tests/e2e/app.spec.ts` | 现有 8 个核心 selector 的 e2e |
| `src/web/routes/dev.ts:500-548` | `/api/dev/emit-*` test hooks (CODE_AGENT_E2E 守门) |
| `src/web/webServer.ts:618-668` | `domain:session` web mode handler (含 switchModel) |
| `src/web/routes/agent.ts:410-420` | `/api/run` 读 modelSessionState 的修复点 |
| `src/main/session/modelSessionState.ts` | Session-level model override store |
| `src/renderer/components/Sidebar.tsx:827` | 「新会话」按钮 |
| `src/renderer/components/StatusBar/ModelSwitcher.tsx:638` | aria-label="切换模型" 入口 |

## Appendix B: 三条 Anchor Commit 详细分析

详见 §0。这三条都属于「UI 操作没在真实链路上被消费」的 wiring 类型，单测路径里 IPC handler 自己跑都是绿的，e2e 才能拦。


---

## 7. PoC 期间发现 (Bonus)

跑 PoC 的过程中, 第一版用 REST `POST /api/sessions` 注入第二个 session, 期望经 SSE
到达 renderer DOM, **直接失败了**——这就是 e2e 的副作用价值: 写测试的过程顺手暴露了
一个新的 wiring bug。

### 发现: REST 路径创建的 session 不通知 renderer

**根因**: `src/main/services/infra/sessionManager.ts` 的 `createSession()` 没有调
`this.notifySessionListUpdated()`。该方法只在 `updateSession`、`archiveSession`、
`deleteSession`、`syncSessionListFromCloud` 几条路径上被调用。

```typescript
// src/main/services/infra/sessionManager.ts:543-549
private notifySessionListUpdated(): void {
  const windows = BrowserWindow.getAllWindows();
  for (const win of windows) {
    win.webContents.send(IPC_CHANNELS.SESSION_LIST_UPDATED);
  }
}
```

`createSession` 走完 `db.createSession(session)` 直接 return, 没有触发 SSE 通知。

### 影响范围

- **桌面态 (Tauri)**: 用户点「新会话」走的是 `domain:session` IPC, 不走 REST, 这条路径的
  「新 session 出现在侧边栏」是靠 ChatView 本地 setState 立刻渲染, 不依赖 SSE 通知,
  所以肉眼看起来没问题。
- **当前隐患**: 任何非 UI 触发的 session 创建 (e.g. CLI 注入、其它窗口、未来的 web 模式
  多 tab) 都会出现「DB 有但 UI 看不到」, 需要 reload 才显示。
- **e2e 影响**: 让 e2e 不能直接用 REST 注入测试数据, 只能走 UI click, 减少了测试灵活度。

### 建议修复 (不在本次范围)

在 `createSession` 末尾加 `this.notifySessionListUpdated();`, 跟其它写入路径对齐。
跟当时为什么没加这一行的原因要 git log 一下, 可能是早期为了避免「点击新会话 → 走
SSE 通知 → loadSessions → 自激循环」(代码注释里提到过自激循环风险)。如果是这个原因,
应该用 `didMutate` 守门 (跟现有 `syncSessionListFromCloud` 一样), 而不是完全不发。

### Lesson learned

这个 bug **在写 e2e 的第一次失败时就暴露了**, 是「补 e2e 砍 20% fix commit」这个假设
的活样本——光是把一个 PoC 跑通, 就找到了一个生产代码里漏掉的通知调用。如果之前有这条
e2e, 这条 bug 早就被拦了。
