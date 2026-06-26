# Neo Tools 长期方案 · 集成与重排（统领文档）

日期：2026-06-26

状态：待林晨拍板

## 这份文档解决什么

`docs/plans/neo-tools/` 下有 8 份长期方案（task-splitting / shell / codebase-navigation / edit-patch-checkpoint / verification-loop / browser-computer-visual-proof / tool-platform-agents / primitive-tool-design）。逐篇质量很高，但它们是同一作者的 8 个独立深潜，**缺一遍总集成**。横过来看有三个结构性问题，如果按 8 篇各自的 P0 直接开工，会重复造轮子、改同一批文件互相打架、并把深度 coding-agent 基建错排到 cowork 用户价值之前。

本文不替代那 8 篇（它们保留作每条线的 depth 参考），而是在它们之上立三件事：

1. **统一 Evidence/Provenance 契约**——收敛 7 篇各自发明的"证据账本"。
2. **跨篇去重的工作包（WP）划分**——把重叠的 P0 合并成可独立排期的包。
3. **以 cowork 用户价值重排的优先级与依赖顺序**。

> 定位锚点：Neo 是 **cowork 人机协作产品**，用户默认非程序员，产物为主轴。这 8 篇全程以 "coding agent" 框架书写、对标 Cursor/Aider/Codex/Gemini CLI/OpenCode。工具层该硬化没错，但优先级必须按"产物可信 / 完成可证明"对非程序员的增益来排，不能按编程框架的完备度来排。

---

## 一、统一 Evidence/Provenance 契约（最高优先，地基）

### 问题

"证据 / 账本 / provenance" 这个概念在 8 篇里被**独立发明了七次**：

| 文档 | 各自发明的证据结构 |
|------|------|
| task-splitting | `evidenceRefs`（挂 SessionTask） |
| codebase-navigation | `context fidelity ledger`（candidate/read/stale） |
| verification-loop | `VerificationEvidence` + `verification_evidence` 事件 |
| browser/computer | `BrowserComputerProofBundle` |
| edit/patch/checkpoint | 统一"变更账本"（changedFiles/diffId/checkpointId） |
| primitive-tool | Read `evidenceToken` + output archive |
| tool-platform | `durable subagent ledger` |

七套并行 = 七套持久化 schema、七套脱敏规则、七处 UI 卡片、七份导出逻辑。它们回答的其实是**同一个问题**：「这条结论/这次完成，凭什么证据、证据新鲜吗、跑没跑、脱敏了没」。这与刚在 web search 那条线收口的 provenance 主缺口同类——别在工具层再裂一次。

### 契约草案（待拍板字段）

立一个 `EvidenceRef` 基类，七个域各自扩展，全部消费同一底座：

```ts
// src/shared/contract/evidence.ts （新增，作为唯一证据底座）
type EvidenceRef = {
  id: string;                 // 稳定证据 id，供 trajectory / UI / 导出 / reviewer 引用
  kind:
    | 'read' | 'file' | 'diff' | 'patch'        // 文件类
    | 'tool' | 'test' | 'typecheck' | 'build' | 'ci'  // 验证类
    | 'browser_dom' | 'browser_a11y' | 'screenshot'   // 浏览器/视觉类
    | 'computer_ax' | 'artifact' | 'trace';           // 桌面/产物/轨迹类
  ref: string;                // 真实落点：路径#L区间 / archive id / trace id / screenshot path / ci log url
  source: string;             // 产出动作：Read / Grep / VerificationRunner / browserAction / ComputerSurface ...
  freshness: {
    capturedAtMs: number;
    digest?: string;          // sha256 短前缀，判 stale 用
    state: 'fresh' | 'candidate' | 'read' | 'stale' | 'needs_re_read' | 'not_run';
  };
  redactionStatus: 'clean' | 'redacted' | 'contains_secret_blocked';
};
```

各域只在其上加领域字段，不再自立证据底座：

- **codebase-navigation** 的 candidate/read/stale → 直接是 `freshness.state`；"候选不能进结论，必须经 Read 绑定" = 结论只接受 `state === 'read'` 的 ref。
- **primitive-tool** 的 `evidenceToken` → 一条 `kind: 'read'` 且带 `digest` 的 EvidenceRef；Edit/Write 的前置条件 = "目标路径存在 state=read 且 digest 匹配的 ref"。
- **verification-loop** 的 `VerificationEvidence` → `{ status, failureType, ...} & { evidenceRefs: EvidenceRef[] }`，runner 产出的每条命令结果挂 `kind:'test'|'typecheck'|'build'|'ci'`。
- **browser/computer** 的 proof bundle → 不再是独立大对象，而是"一组 EvidenceRef（dom/a11y/screenshot/ax）+ 少量领域字段（targetRef/approval/manualTakeover）"。
- **edit/patch** 的变更账本 → diff/patch 各是一条 EvidenceRef，`checkpointId` 进领域字段。
- **task-splitting** 的 `evidenceRefs` → 直接 `EvidenceRef[]`。
- **tool-platform** 的 durable ledger → 持久化层，存的就是 EvidenceRef + agent 元数据，不另发明证据形状。

### 这件事必须先做的理由

它是 WP-B/C/D/E 的共同底座。先立契约再开工，七条线天然对齐；后立则要七处返工。**这是唯一一件应该在所有功能线之前落地的事。**

---

## 二、跨篇去重 → 工作包（WP）

把 8 篇的 P0 重叠项合并成可独立排期、改文件不打架的工作包。

| WP | 来源篇 | 内容 | 关键文件（合并后唯一归属） |
|----|--------|------|------|
| **WP-A 证据契约** | 本文 | `EvidenceRef` 基类 + 各域适配 stub | `src/shared/contract/evidence.ts`（新增） |
| **WP-B Primitive 证据链** | edit-patch + primitive-tool + codebase-nav 的 candidate/read 规则 | Read evidenceToken(=EvidenceRef)、Write 覆盖 pre-read gate、mtime+size+digest 冲突检测、search-to-read guard、Glob/List 分页排序、output archive UX | `read.ts` `write.ts` `multiEdit.ts` `fileReadTracker.ts` `externalModificationDetector.ts` `glob.ts` `listDirectory.ts` `grep.ts` `toolResultBudget.ts` |
| **WP-C Verification Loop** | verification-loop P0 | VerificationPlan + related test selector v0 + VerificationRunner + 失败归因 + 写回 evidence + 三态(passed/failed/not_run) | `goalVerifyGate.ts` `goalCompletionGate.ts` `turnTrace.ts` `changeDetector.ts` |
| **WP-D Browser/Computer Proof** | browser-computer P0 | proof = EvidenceRef 集合 + 统一证据卡 + 截图 analyzed 规则 + manual takeover 状态机 | `browserAction.ts` `computerUse.ts` `screenshot.ts` `browserComputerRedaction.ts` |
| **WP-E Task plan 语义修复** | task-splitting P0（**收窄**） | 在现有 TaskManager 上加 batch-plan(replace/patch + exactly-one-in_progress) 语义 + 修 autoAdvance 的 Bash 误判 | `taskManager.ts` `runFinalizer.ts` |
| **WP-F Shell 控制面** | shell P0 + tool-platform 的重启恢复 | 命令级权限 DSL + Process 读写权限拆分 + 后台任务/子 agent 重启恢复（**两篇的重启恢复合并**） | `commandPolicy.ts` `permissionClassifier.ts` `process.ts` `backgroundTaskStore.ts` `spawnGuard.ts` |
| **WP-G code_search 修复** | codebase-nav P0（**收窄**） | code_search 改 lexical/FTS+symbol（**不引 embedding**），结果标 candidate | `codeIndexServer.ts` |

**已核实的现状纠正（写工作包时必须按真值，不按原文）**：

1. **WP-E**：task-splitting 原文称"没有 model-facing 计划工具"——**不准**。`TaskManager` + `task_create/update/list` 已注册为对模型暴露的工具（`modules/index.ts:415-432`），schema 已含 status/priority/依赖/owner，直写 SessionTask + emit `task_update`。真实缺口窄：缺 Codex `update_plan` 式的整批 replace/patch + exactly-one-in_progress 不变量。**别新建 `task_plan_update`，在 TaskManager 上加 batch 语义即可**，否则两个职责重叠工具模型不知道调哪个。
2. **WP-E**：`autoAdvanceTodos`（`runFinalizer.ts:506`）确实把 `name === 'bash'` 无条件列为修改类 → 任意成功 Bash 推进当前任务为完成。这是真 bug，修法 = 把 `bash` 从无条件列表移除，仅在命令被标为 verification/task-linked 时才推进。
3. **WP-B**：`write.ts` 确无 `hasBeenRead`/`checkExternalModification` → 覆盖既有文件无 pre-read gate，缺口真实。
4. **WP-G**：`codeIndexServer.ts:331` 确实返回 "Code search via memory service has been removed."，修它是真 P0。

---

## 三、押后清单（明确不进近期排期）

这些是 8 篇里的深度 coding-agent 基建 / 大平台件，对非程序员协作者边际价值低，或属过度工程，**显式 DEFERRED**：

| 押后项 | 来源篇 | 押后理由 |
|--------|--------|----------|
| Tree-sitter repo map（4 语言）、LSP symbol graph、semantic code index + 混合排序 | codebase-nav P1/P2 | 深度 coding-agent 基建；非程序员场景边际价值远低于"产物可信" |
| Capability Matrix、Agent Tree 状态 API、worktree merge queue、policy-as-code、ToolSearch 语义索引 | tool-platform P0/P1/P2 | 控制面大件；工具还没硬化前先做控制面是倒置。该篇 P0 仅保留"统一 AgentFailureCode + 重启恢复（并入 WP-F）" |
| remote browser provider、external Chrome attach、long-run video timeline | browser P2/Later | 账号态/数据隔离风险高，原文也已划在 P2 之后 |
| 环境级 time travel、多 agent 并发回放、Patch repair agent | edit-patch Later | 文本文件链路稳定前不碰 |
| CI logs ingest、Verification Card | verification P1 | 等 WP-C 本地闭环稳定后再接远端 |

押后 ≠ 砍掉，是排在 WP-A~G 之后、按需启动。

---

## 四、推荐排期与依赖顺序

```text
WP-A 证据契约 ──┬─> WP-B Primitive 证据链 ──┬─> WP-C Verification Loop
               │                            └─> WP-D Browser/Computer Proof
               ├─> WP-E Task plan 修复（可与 B 并行，依赖轻）
               └─> WP-F Shell 控制面（独立性高，可并行）
WP-G code_search 修复（独立小件，导航痛点浮现时插入）
```

**推荐启动顺序（按 cowork 用户价值，非编程完备度）**：

1. **WP-A 证据契约** — 地基，阻塞 B/C/D/E，必须先。
2. **WP-E Task plan 修复** — 便宜、日常价值高、且修一个真 bug（成功 Bash 误标完成），性价比最高，先摘。
3. **WP-B Primitive 证据链** — 让"改文件"可信（pre-read/冲突检测/search-to-read），是后续一切的信任前提。
4. **WP-C Verification Loop** — 把"完成"从模型自述变可审计，**对非程序员的信任增益最大**（用户看不懂代码，只能信"完成证据"）。
5. **WP-F Shell 控制面** — 权限 DSL + 重启恢复，安全与可托付。
6. **WP-D Browser/Computer Proof** — 最贴 cowork 产物轴（用户判运行产物、登录/MFA 不自动绕过）。
7. **WP-G code_search 修复** — 独立小件，导航痛点出现时再插。

之后才轮到押后清单。

---

## 五、给艾克斯的开工约束

- 动任何功能 WP 前，先落 **WP-A `EvidenceRef` 契约**，七条线统一引用，禁止再自立证据结构。
- WP-B 三篇（edit-patch / primitive-tool / codebase-nav 的 read 规则）**合一个工作包推进**，因为它们改同一批文件（`read.ts`/`write.ts`/`multiEdit.ts`/`fileReadTracker.ts`），分开做必冲突。
- WP-E **不要新建 `task_plan_update`**，在 `TaskManager` 上加 batch 语义；同 PR 修 `autoAdvanceTodos` 的 Bash 误判。
- 每条线的 depth/验收清单仍以各自原文为准，本文只管"契约 + 边界 + 顺序"。
- 仍守现有纪律：付费/不可逆动作先报后做、改 prompt bump PROMPT_VERSION、PR 不擅自合 main。

---

## 附：8 篇原文的集成定位速查

| 原文 | 集成后归属 | 优先级 |
|------|-----------|--------|
| task-splitting | WP-E（收窄） | 2 |
| primitive-tool-design | WP-B（合并） | 3 |
| edit-patch-checkpoint | WP-B（合并） | 3 |
| codebase-navigation | WP-G（P0 收窄）+ 大部分押后 | 7 / Deferred |
| verification-loop | WP-C | 4 |
| shell-terminal | WP-F | 5 |
| browser-computer-visual-proof | WP-D | 6 |
| tool-platform-agents | 重启恢复并入 WP-F，其余押后 | Deferred |
</content>
</invoke>
