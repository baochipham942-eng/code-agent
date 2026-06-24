# 设计 Surface 会话化改造 — 一期实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 逐 Task 实施。Steps 用 `- [ ]`。
> 配套 spec：`design-surface-conversational-redesign.md`

**Goal:** 给设计 surface 接上「常驻 agent 会话 + 画布预览 tab」这条腿，让基线已含的 ADR-026/027 第一次有真实用户入口。

**Architecture:** 加法式重新接线，不造新 agent loop、不动表单覆盖层。复用 `useAgentIPC`（模式无关）+ 既有 `proposeCanvasOps`/`RequestDesignAutonomy` 工具 + workbench tab 体系。一期新增「会话驱动设计画布」路径与旧表单覆盖层并存；二期再退役表单 + 收口布局。

**Tech Stack:** Tauri+React18+Zustand+TS，konva，vitest，headless E2E（chrome-headless-shell）。

**基线：** `d93e26f93`（origin/main，已含 ADR-026+027）。无 #281 rebase 顾虑。

**锁定决策：** ①表单彻底退役(二期) ②会话主轴+画布预览列(二期目标) ③注入闸=按session设计激活 ④分期 ⑤一期切会话布局托画布。

---

## File Structure（一期）
- `src/renderer/stores/sessionStore.ts` — 加 per-session `designActiveSessions:Set<string>` + `markSessionDesignActive`/`clearSessionDesignActive`/`isSessionDesignActive`
- `src/renderer/hooks/agent/useAgentIPC.ts` — `withCanvasSnapshotContext` 注入闸改按 session
- `src/renderer/stores/appStore.ts` — `WorkbenchTabId` 加 `'design-canvas'`
- `src/renderer/App.tsx` — tab switch 加分支
- `src/renderer/components/design/DesignCanvasTab.tsx`（新）— standalone host：`DesignCanvas` + loadCanvasDoc 加载 effect
- chat composer 工具条组件 — 加「打开设计画布」入口 + i18n
- tests + E2E

---

## Task 1：per-session 设计激活标记
**Files:** Modify `sessionStore.ts`；Test `tests/renderer/stores/sessionStore.designActive.test.ts`
- [ ] 1.1 写失败测试：`markSessionDesignActive(s1)` → `isSessionDesignActive(s1)===true`、`(s2)===false`、`clear` 后转 false、重复 mark 幂等
- [ ] 1.2 跑测试确认失败（方法未定义）
- [ ] 1.3 实现：state 加 `designActiveSessions:Set<string>`（运行态不持久化），3 action（不可变 new Set）
- [ ] 1.4 跑测试通过
- [ ] 1.5 commit `feat(design): per-session design-active flag`

## Task 2：放宽画布注入闸（R1）
**Files:** Modify `useAgentIPC.ts:75-84`；Test `tests/renderer/hooks/useAgentIPC.canvasGate.test.ts`
- [ ] 2.1 写失败测试：设计激活 session + 画布有节点 → 注入 canvasSnapshot；非设计激活 session（哪怕有节点）→ 不注入；设计激活但画布空 → 不注入；断言不再依赖 workspaceMode
- [ ] 2.2 跑测试确认失败
- [ ] 2.3 实现：第 78 行条件改 `if (!useSessionStore.getState().isSessionDesignActive(useSessionStore.getState().currentSessionId)) return context;`，保留 `nodes.length===0` 兜底
- [ ] 2.4 跑测试 + `npm run typecheck`
- [ ] 2.5 commit `feat(design): gate canvas injection on per-session design-active`

## Task 3：DesignCanvas 进专属 workbench tab（R2）
**Files:** Modify `appStore.ts`、`App.tsx`；Create `DesignCanvasTab.tsx`；Test 路由测试 + appStore tab 测试
- [ ] 3.1 写失败测试：`WorkbenchTabId` 含 `'design-canvas'`；`openWorkbenchTab('design-canvas')` → `activeWorkbenchTab==='design-canvas'`；`DesignCanvasTab` 挂载触发 `loadCanvasDoc(runDir)`（mock）当 runDir 非空且 nodes 空
- [ ] 3.2 跑测试确认失败
- [ ] 3.3 实现：① `WorkbenchTabId` 加 `'design-canvas'` ② `DesignCanvasTab.tsx`=包 `<DesignCanvas/>` + 搬 `DesignWorkspace.tsx:1015-1026` loadCanvasDoc effect ③ App.tsx switch 加 `{activeWorkbenchTab==='design-canvas' && <DesignCanvasTab/>}`
- [ ] 3.4 跑测试 + typecheck
- [ ] 3.5 commit `feat(design): host DesignCanvas in dedicated workbench tab`

## Task 4：聊天内「打开设计画布」入口（会话布局托画布）
**Files:** Modify chat composer/workbench bar 组件；i18n `zh.ts`/`en.ts`；Test 组件测试
- [ ] 4.1 写失败测试：点入口 → `markSessionDesignActive(currentSessionId)` + `openWorkbenchTab('design-canvas')` 均被调用；无 currentSessionId 时禁用
- [ ] 4.2 跑测试确认失败
- [ ] 4.3 实现：composer 工具条加按钮（文案 i18n zh/en 对齐），onClick 串两 action
- [ ] 4.4 跑测试 + typecheck
- [ ] 4.5 commit `feat(design): chat composer entry to open design canvas`

## Task 5：端到端打通 + 审批条验证（ADR-026 + 027）
**Files:** Test `tests/e2e/designCanvasConversation.*`（headless）
- [ ] 5.1 写 E2E：开设计画布入口 → 会话发"加一个标题节点" → agent 调 `proposeCanvasOps` → `CanvasProposalReviewBar` 在画布 tab 弹出 → 采纳 → 节点落画布。补一条："你自己出 N 个变体我来挑" → `RequestDesignAutonomy` → `CanvasAutonomyReviewBar` 信封审批弹出
- [ ] 5.2 跑 E2E（独立 chrome-headless-shell + 临时 profile，按 infra 记忆，不用 MCP chrome）
- [ ] 5.3 修打通缺口（DesignCanvas standalone 挂载缺的 props/context）
- [ ] 5.4 commit `test(design): e2e chat-driven canvas ops + autonomy envelope`

## Task 6：对抗审计 + 文档
- [ ] 6.1 `/codex-audit` 独立 context 当反方扫一期 diff，修 HIGH/MED，Round N 查对称应用
- [ ] 6.2 更新 spec + `design-roadmap.md` 进度
- [ ] 6.3 全量 typecheck + 受影响模块测试绿；PR（CI 全绿不擅自合）；付费 dogfood（真出图验 proposeCanvasOps）前向林晨确认

## 风险
- DesignCanvas standalone 挂载缺隐式上下文（T5 兜）
- 一期 workspaceMode 与 isSessionDesignActive 双信号并存（过渡态）
- 付费 dogfood 默认只跑一次、付费前确认
