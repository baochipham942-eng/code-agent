# Neo Tools 开工指令 · 会话拆分（给艾克斯）

日期：2026-06-26

依据：[`2026-06-26-00-INTEGRATION-evidence-and-resequencing.md`](./2026-06-26-00-INTEGRATION-evidence-and-resequencing.md)（排期）、[`ADR-029`](../../decisions/029-unified-evidence-provenance-contract.md)（证据契约，已 Accepted）

## 拆分原则

- **3 个会话，串行 S1 → S2 → S3**，按依赖关系天然分三层：地基 → 工具硬化 → 可信证据上层。
- 每个会话**艾克斯自建一个 `/goal`**，用下方 objective + verifyCommand + reviewCondition 起。完成靠验证证据，不靠自述。
- 会话内含多个 WP，按列出的**内部顺序**做，每个 WP 做完立即 commit（一会话多 commit、一会话一 PR）。
- **scope 锁死**：只改该会话列出的文件，不顺手重构、不碰下个会话的 WP。
- 守现有纪律：付费/不可逆动作先报后做；改 prompt bump PROMPT_VERSION；**PR 不擅自合 main**，等林晨拍板。
- **S1 合并后再起 S2，S2（含 B）合并后再起 S3**——证据契约/文件证据链一变，下游返工。

## 依赖与顺序

```
S1 地基+快修 (A + E + G) ── 必须先；A 是契约底座，E/G 独立小修复
        ↓ 合并后
S2 工具层硬化 (B1 + B2 + F) ── B 是 C/D 的前置；F 独立一并做
        ↓ 合并后
S3 可信证据上层 (C + D) ── 依赖 A 与 B
```

---

## 会话一 — 地基 + 快速修复（WP-A + WP-E + WP-G）

最轻、最快见效；A 当场被 E/G 两个消费者验证。

**内部顺序：先 A，再 E、G。**

### WP-A 证据契约
- 改：`src/shared/contract/evidence.ts`（新增）。无行为变更。
- 做：按 ADR-029 落 `EvidenceRef` + `EvidenceKind/EvidenceState/RedactionStatus`；提供 `makeEvidenceRef()`、`isConclusionEligible()`（仅 `state==='read'` 或验证 passed）、`isExportSafe()`（拒 `contains_secret_blocked`）、`isStale()`。

### WP-E Task plan 修复
- 改：`taskManager.ts`、`runFinalizer.ts`。
- 做：① 在现有 `TaskManager` 上加批量计划语义（replace/patch + exactly-one-in_progress 不变量），**不要新建 `task_plan_update`**（TaskManager 已是 model-facing 注册工具）。② 修 `autoAdvanceTodos`（`runFinalizer.ts:506`）：把 `bash` 从无条件修改类列表移除，仅命令被标 verification/task-linked 时才推进。③ `SessionTask.evidenceRefs` 用 EvidenceRef。

### WP-G code_search 修复
- 改：`codeIndexServer.ts` + `docs/guides/tools-reference.md`。
- 做：`code_search` 改 lexical/FTS + symbol（**不引 embedding**），结果标 EvidenceRef `state:'candidate'` + next-read 提示；同步修过时 docs。

### goal
- objective：实现 EvidenceRef 证据契约（ADR-029），并摘两个独立修复——TaskManager 批量计划语义+Bash 误标完成 bug、code_search 修复
- verifyCommand：`npm run typecheck && npx vitest run tests/unit/shared/contract/evidence.test.ts tests/unit/agent/todoParser.persistence.test.ts tests/unit/agent/runtime/runFinalizer.autoAdvance.test.ts tests/unit/mcp/`
- reviewCondition：EvidenceRef 字段同 ADR-029 且四闸有测试；未新建重复任务工具、exactly-one-in_progress 有测试、纯探索 Bash 不推进；code_search 不再返回 "memory service removed" 且结果标 candidate

---

## 会话二 — 工具层硬化（WP-B1 + WP-B2 + WP-F）

文件证据链 + shell 控制面，都是"工具可托付"层。**S1 合并后再起。**

**内部顺序：B1 → B2 → F。**

### WP-B1 文件改动证据链
- 改：`read.ts`、`write.ts`、`multiEdit.ts`、`fileReadTracker.ts`、`externalModificationDetector.ts`（+schema）。
- 做：① Read 返回 `EvidenceRef`(kind:'read'+digest+shownRange)，tracker 存 digest。② Write 覆盖既有文件加 pre-read gate（无最新 Read→`NOT_READ_FOR_OVERWRITE`；digest 不符→`STALE_FILE`；`force` 必带 reason 进 audit）。③ 冲突检测升到 mtime+size+digest。

### WP-B2 发现层分页 + search-to-read 闸
- 改：`glob.ts`、`listDirectory.ts`、`grep.ts`（+schema）、`toolResultBudget.ts`、`toolPreflightGuards.ts`、`archiveHydration.ts`。
- 做：① Glob/List 加 offset/limit/sort/respect_gitignore，正文只输出当前页+nextOffset。② search-to-read guard：只在搜索出现、未 Read 的文件被 Edit/overwrite-Write 时返回 `READ_REQUIRED_AFTER_SEARCH`。③ 大输出统一进 archive + next-read hint。

### WP-F Shell 控制面
- 改：`commandPolicy.ts`、`permissionClassifier.ts`、`process.ts`(+schema)、`backgroundTaskStore.ts`、`backgroundTaskSnapshotAdapters.ts`、`spawnGuard.ts`。
- 做：① 命令级权限 DSL（exact/prefix/glob，deny 优先，危险命令硬拦截最高）。② Process 读写权限拆分（list/poll/log/output=观察类，write/submit/kill=控制类）。③ 后台任务+子 agent 重启恢复（**合并 tool-platform 篇 SpawnGuard durable**：running-recovered/dead-log-only/failed/killed，不再一律转 failed）。

### goal
- objective：Primitive 文件证据链（Read EvidenceRef / Write pre-read gate / digest 冲突 / 分页 / search-to-read 闸）+ Shell 控制面（命令级权限 DSL / Process 读写拆分 / 重启恢复）
- verifyCommand：`npm run typecheck && npx vitest run tests/unit/tools/modules/file/read.test.ts tests/unit/tools/modules/file/write.test.ts tests/unit/tools/enhancements/externalModificationDetector.test.ts tests/unit/tools/modules/file/glob.test.ts tests/unit/tools/modules/shell/grep.test.ts tests/unit/tools/permissionClassifier.test.ts tests/unit/tools/modules/shell/process.test.ts tests/unit/tasks/backgroundTaskSnapshotAdapters.test.ts tests/unit/agent/spawnGuard.test.ts tests/security/commandSafety.test.ts`
- reviewCondition：未读覆盖/读后外改/digest 不符三种均拒改、新建文件不受影响；search 后未读直接 Edit 被拒；危险命令硬拦截优先级高于 user allow；观察类不触发执行审批；重启 running 任务有明确恢复态而非伪 failed

---

## 会话三 — 可信证据上层（WP-C + WP-D）

完成验证 + 产物 proof，都消费 A、依赖 B。**S2 合并后再起。**

**内部顺序：C、D 可任意先后（文件不相交）。**

### WP-C Verification Loop
- 改：`goalVerifyGate.ts`、`goalCompletionGate.ts`、`turnTrace.ts`、`changeDetector.ts` + 新 verification 模块。
- 做：VerificationPlan + related test selector v0（git diff→规则映射 targeted test，定位不到写 skippedChecks）+ VerificationRunner（包 runVerifyGate，产出 `VerificationEvidence`=状态+failureType+`EvidenceRef[]`）+ 失败归因 v0 + final answer 三态（passed/failed/not_run，全 not_run 不得标 fully verified）。**CI ingest / Verification Card 押后。**

### WP-D Browser/Computer Proof
- 改：`browserAction.ts`、`computerUse.ts`、`screenshot.ts`、`browserComputerRedaction.ts` + 证据卡 renderer。
- 做：proof = `EvidenceRef[]`(dom/a11y/screenshot/ax) + 领域字段(targetRef/approval/manualTakeover)；统一证据卡；截图 analyzed 规则（只有 path 不算看到 UI）；manual takeover 状态机（login/mfa/captcha 不自动绕过）。**remote browser / external Chrome / video 维持押后。**

### goal
- objective：Verification Loop 本地闭环（plan+selector+runner+归因+三态）+ Browser/Computer proof 改 EvidenceRef 集合（证据卡+截图 analyzed 规则+manual takeover）
- verifyCommand：`npm run typecheck && npx vitest run tests/unit/evaluation/trajectory/ tests/unit/agent/ tests/unit/tools/vision/ && npm run acceptance:browser-computer-all`
- reviewCondition：现有 `--verify` 不破坏、final answer 三态不虚报、改 runtime 文件能自动选 targeted test 或写明未选原因；只有截图 path 未 analyze 不能表达为已视觉确认；登录/MFA/CAPTCHA 分类为 manual takeover 不自动绕过；导出无 secret/cookie/base64；既有 acceptance 不回退
</content>
