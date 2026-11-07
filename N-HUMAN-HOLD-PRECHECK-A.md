# N-HUMAN-HOLD-PRECHECK-A — human-hold-1106.tsv 第 1–12 行预诊断（只读）

2026-11-06 · 诊断人：mq 无头工人（glm 席）· 只读取证：`~/.ship/collect/state|work/<票>/`、`~/work/evidence/<票>.md`、`~/work/collect/code-agent`（fetch 后 merge-tree，无任何真实 merge）、`gh pr view/run view`、仓内 `scripts/lib/gates-fast-contract.mjs selectTests` 只读复算（脚本在 `~/work/out/N-HUMAN-HOLD-PRECHECK-A/simulate-selection.mjs`）。
本机无 fleet/ship，票面字段用 state+work 目录与 gh 等价还原；未改任何仓库/队列状态/台账，未合并未重跑。

---

## 1. N-CONNECTOR-READ-UNTRUSTED — landing-failure_land-50d9dfc9 — 卡点：PR#2721 与 main 双文件冲突 + gates:fast commit-checks 要 PROMPT_VERSION bump — 最小下一步：解 2 文件冲突（agent.ts 取 ≥sys-v97、证据 JSON 重生成）→ 重跑 ship pr — 工作量 S

- 卡点原文①（state/merge.log，11-03 12:48）：
  `ship: PR#2721 behind main by 6; updating branch (round 1)...` → `X Cannot update PR branch due to conflicts` → `ship: ERROR: update-branch failed (likely conflicts with new main) — resolve manually`
- 卡点原文②（work/ship-last.out，同日 3 次落地同因）：
  `✗ gates:fast FAILED: FAIL: exit 1 in bash scripts/check-prompt-version-bump.sh --base ee80a331… --head aa102277… receipt=11d14536-0a2a-4c78-adb6-ea9210d1b00c`
  根因行：`✗ 提交被拦下：改了模型每轮读到的文本，但没有 bump PROMPT_VERSION`，涉改 5 个 schema：`src/host/tools/modules/connectors/{calendar,mail,reminders,tmeetMeetingList,tmeetMeetingSearch}.schema.ts`
- 现状（merge-tree 只读，PR#2721 OPEN，GitHub mergeable=CONFLICTING，落后 main 108）：冲突 2 文件：
  - `src/shared/constants/agent.ts`：main 侧加 sys-v95/sys-v96 注释并把 `PROMPT_VERSION` 升到 `'sys-v96'`；分支侧加 sys-v93 注释、值停在 `'sys-v94'`（注释自称「取 main 的更高版」但没取）。**真冲突**（同一段常量双改），解法机械：合并注释、取 ≥sys-v97（IMAGE 单 29cd17d2f 已有「integration merge 取 sys-v97」先例）。
  - `docs/eval/prompt-gate-latest.json`：两侧都是 mq-gate 生成的证据 JSON（generatedAt/gitHead/promptVersion 各自刷新）。**trivial/可再生**：按 main 或合并后重跑 mq-gate 重出皆可。
- 最小下一步：分支上解这 2 个冲突（agent.ts 并注释+bump 到 ≥sys-v97 即同时满足 check-prompt-version-bump 门）→ 重跑 ship pr（自动 update-branch）。
- 工作量：S（冲突机械；一次落地+CI 周期）。

## 2. N-APPSHOT-HOTKEY-TCC-PREFLIGHT — ci-failure + risk-high — 卡点：eslint-ratchet 超 1 条（本 PR 引起，非抖动）+ 权限 allow-list 高风险档等人签字 + 2 文件冲突 — 最小下一步：Appshots 文案挪出 zhSettingsWork.ts、解冲突重跑 CI、人签 SHIP_RISK_ACK — 工作量 M

- CI 卡点原文（`Swarm smoke (unit + integration)`，run 41424753502 / job 125220764763，2026-11-02，打印 `##[error]` 的那一步）：
  ```
  [eslint-ratchet] errors current=1 baseline=0 delta=+1
  [eslint-ratchet] ✗ errors 超基线 1；修复后按续航余量 5 条，清理至当次 current-5=0 再同步下调 BASELINE_ERROR_MAX
  [eslint-ratchet] 超基线 findings（已改动/未跟踪文件优先）：
    src/renderer/i18n/zhSettingsWork.ts:1002:1:max-lines
  ##[error]Process completed with exit code 1.
  ```
- 归因：**本 PR 引起、确定性**（非既有/抖动）：PR 给 `zhSettingsWork.ts` +1 行（main 1001 行 → 分支 1002 行，压过 max-lines）；main 近 10 次 run 全 success（`gh run list --branch main --limit 10`），eslint-ratchet 无随机性。未见 better-sqlite3 噪声当根因。
- risk-high 卡点原文（state/merge.log）：`ship: ERROR: PR#2616 是 high 风险档（命中 RISK-PATHS，见上）——要人裁决：SHIP_RISK_ACK="<谁裁的·理由>" ship merge 2616`（命中 `src-tauri/permissions/*`：app-commands.toml 只加 `appshots_hotkey_status`、`appshots_request_hotkey_access` 两条 allow）。risk-ack 已有 mini Opus 全量分析（state/risk-ack），**等人签字**，签字材料已备好。
- 附加现状：PR#2616 OPEN，CONFLICTING，落后 154。冲突 2 文件：
  - `src/renderer/services/nativeDesktop.ts`：同一行 `SettingsPaneKind` 联合类型，main 加 `'notifications'`、分支加 `'inputMonitoring'`。**同行双加，并集即可（trivial）**。
  - `src-tauri/src/native_desktop.rs`：main 把 `probe_notifications_permission` 重构为 `notification_permission_state` 帮助函数；分支在同一 match 里加 `inputMonitoring` pane 映射。**相邻不同逻辑，机械合并**。
- 最小下一步：①把本 PR 新增的 Appshots 文案从 `zhSettingsWork.ts` 挪到独立域 i18n 文件（仓里惯例如 `src/renderer/i18n/backgroundPanel.ts`），消 max-lines；②解 2 文件冲突；③重跑 CI；④人 `SHIP_RISK_ACK` 后 merge。人的动作只有 ④。
- 工作量：M（一轮代码+CI 等待）。

## 3. N-CUA-SCREEN-GUARDS-SENSITIVE-PROBE-FU3 — risk-high — 卡点：命中 `src/host/permissions/*` 风险路径，ship 要 SHIP_RISK_ACK — 最小下一步：人签字 `SHIP_RISK_ACK="…" ship merge 2802` — 工作量 S

- 卡点原文（state/merge.log，CI 19 passed / 2 skipped 全绿、ai-review success 0 important 之后）：`src/host/permissions/* ⇐ src/host/permissions/cuaSensitiveStep.ts` → `ship: ERROR: PR#2802 是 high 风险档（命中 RISK-PATHS，见上）——要人裁决：SHIP_RISK_ACK="<谁裁的·理由>" ship merge 2802`
- 决策内容（两句）：要不要放行 permissions 路径下的新文件 `cuaSensitiveStep.ts`（ADR-088 二期：已授权应用内点支付/验证码/密码类按钮不派发、弹不可记住的交回卡）。支持面：CI 全绿、ai-review 0 Important、真 glm-5.3 五轮真跑「停手告知 5/5、绕开 0」、普通按钮不误拦；谨慎面：模型主动行为预拦截落 permissions 目录属首次，误拦伤可用性——但现有证据显示不误弹。
- 现状：PR#2802 OPEN、MERGEABLE、落后 37（update-branch 自动）。
- 最小下一步：人给 `SHIP_RISK_ACK="<谁裁的·理由>"` 走 `ship merge 2802`。
- 工作量：S（纯人工拍板）。

## 4. N-CRON-MORNING-TRIAGE-REST1 — landing-failure_land-ee424b06 — 卡点：gates:fast 选中 16 个测试文件 > 上限 12，push/PR 从未建出 — 最小下一步：爸拍板「拆单」或「提上限」（结构性超限，不二选一过不去） — 工作量 M（拆单）/ S（提上限，但要人）

- 卡点原文（work/ship-last.out，11-02 08:08/08:20/08:31 三次同因）：
  `✗ gates:fast FAILED: FAIL: selected 16 files; allowed 1..12; never truncate. receipt=a8ff1c29-4c13-4213-a231-777723eea7cf` → `ship: ERROR: gates:fast rejected — push/PR blocked`（`mq-collect FAIL …: ship pr`；无 PR）
- 明细（用仓内 selectTests 按 merge-base b4cd76994 只读复算，与回执数字一致）：
  - 基线 3：agentEventSchemas / commandSafety.relativeDelete / swarmStore
  - 本单改动测试 11：CronEventEditor、CronJobEditor{BudgetLimits,GroupListenTemplate,MetadataRoundTrip,MorningTriageRole,UrgencyCriteria}、CronSimpleCreate、cronPendingRoutineRestate、cronSavedRoutineRestateView、cronSavedRoutineRows、cronWebhookCloudHook
  - 规则附加 2：perf-journey-cold-start（← `src/renderer/i18n/cronCenter.ts`）、renderer-token-boundary
- 结构性：仅「基线 3 + 改动测试 11」=14 已 >12，规则一个不触发也过不了。上限是硬编码政策：`scripts/lib/gates-fast-policy.json` `"maxFiles": 12` + `scripts/gates-fast.mjs:139` `if (policy.maxFiles !== 12) throw`（first-version policy 断言）。
- 最小下一步：爸二选一——A 拆单（≥5 个测试文件的组件挪续单，工人重落地）；B 提上限（同时改 policy json 与 gates-fast.mjs:139 断言，快门政策变更需人同意，此前 10-13 只豁免过「仅超 2 个」）。落地侧无其它卡点。
- 工作量：M（拆单含返工轮）/ S（提上限纯决策+两行改动）。

## 5. N-FIX-PARKED-APPROVAL-SURVIVE-RESTART-RESUME-FU1-FU1-FU2-FU2 — ui-shots — 卡点：循环盯的截图目录是空的，而证据档指明的 2 张截图其实在 ~/work/out 里，漏拷 — 最小下一步：把 2 张拷进 evdir，人目验后 touch ui-ok — 工作量 S

- 卡点原文（state/hold-ui）：`UI 单（动了 src/renderer/components|styles）：合入前要 before/after 截图，收活循环 2026-11-04 自动挂起；验完 touch ui-ok 即可（循环自动补 pr-opened 交后台合并）`
- 验收要 vs 已有：
  - 证据档「截图与屏上文字核验」节指明 2 张用户路径图：`~/work/out/N-FIX-PARKED-…-FU2-FU2/shots/r2-chat-header-en.png`（折叠工具步骤头+常显失败行）与 `r2-inbox-voided-en.png`（运行记录 tab 下收件箱 voided 灰行）——**已存在**（64KB/78KB，11-04 11:01）。
  - evdir `~/work/code-agent-private-archive/docs/evidence/N-FIX-PARKED-…-ui-shots-2026-11-04-1822/` **0 个文件**（连 README/geometry 都没有）——拷贝这步漏了。
  - before 图：本轮 r2 零代码改动，before 语义由父单 FU2 的 evdir（`…-FU2-ui-shots-2026-11-04-0124`，16 个文件）承担（判断题，记此处）。
- 现状：PR#2816 OPEN、MERGEABLE、落后 48；无其它卡点。
- 最小下一步：把上述 2 张拷进 evdir → 人目验（对证据档 OCR/DOM 文字）→ `touch ui-ok`。
- 工作量：S。

## 6. N-BROWSER-KEEP-RESULT-PAGE — mapper-human-verdict — 卡点：收活侧缓存的 regressions.json 按拆单前生成、引用已删测试，工人改不到 — 最小下一步：收活人按证据档 Rework r3 的 4 条重建该缓存（或清缓存重生成）→ ship pr — 工作量 S

- 决策内容（两句）：要人确认「拆单收法」——宿主半张（keep_result_page 注册表/adapter/工具接线）现在落，渲染半张（认领/kept bar/一键重开）与真机验收转 2 条 followups 续单。支持面：分支 af878ada2 上 gates:fast 8 文件全绿回执在证据档；谨慎面：渲染半张拆出后用户路径端到端证明随之移出（已列 realrun followup）。
- 卡点原文（work/mapper.log）：`落地卡在收活侧缓存的 regressions.json：它按拆单前的 d9a2086d0 生成，还列着已删除的 tests/renderer/components/BrowserKeptResultBar.test.tsx，工人改不到这个文件。已退回工人两轮，需要收活人按证据档 Rework r3 的 4 条声明重建它，或清掉 state/regr-generated 让它重新生成，再重新 ship。`
- 核实：缓存 `~/.ship/collect/work/N-BROWSER-KEEP-RESULT-PAGE/N-BROWSER-KEEP-RESULT-PAGE.regressions.json` 第一条 files 仍列 `BrowserKeptResultBar.test.tsx`（分支上已不存在，已验 MISSING）；state/regr-generated=d9a2086d0（旧交付）。证据档 Rework r3 的 4 条声明所引 4 个测试文件在分支上**全部存在**（已逐个 `git cat-file -e` 验过）。无 PR。
- 最小下一步：收活侧二选一——按证据档 Rework r3 原文重建该 regressions.json（4 条已在证据档逐字给出），或删缓存文件+state/regr-generated 标记让循环按现证据重生成 → `ship pr`（推分支+建 PR）。
- 工作量：S。

## 7. N-FIX-NOTIFY-DISPLAY-GAP-FU1-CLICKROUTE — ui-shots — 卡点：无可见 UI 变化、截图目录里只有「为什么拍不到」论证，等人工豁免 — 最小下一步：人豁免（或驳回）→ 解 1 个测试文件冲突 → ship — 工作量 S

- 卡点原文（evdir README 结论行）：`# 结论：转人工判断（本轮没有可截图的可见变化）`；验收对照表两行截图均「无」：①「三类通知落点正确、重复只跳一次——未验证（只有单测证据：clickRoute 假事件单测、CronCenterPanel 组件测、反向变异红行）」②「自动化中心面板切到运行页——未验证（无生产构建入口）」。
- 拍不到的根据（README）：路由只在收到壳的 `notification-clicked` 且 `isTauriMode()` 才注册（`useCronOsNotification.ts:176`），web 版无入口、壳发射端在 NATIVE 兄弟单；唯一间接可见变化需 Vite DEV 构建的 `window.__neoAppStore`（`appStore.ts:899`），生产 dist 无。
- 附加现状：PR#2741 OPEN、CONFLICTING、落后 93。冲突 1 文件：`tests/renderer/components/CronCenterPanel.test.tsx`——main 重写了该文件的 mock 头（vi.hoisted + sessionAutomationClient mock + waitFor），分支在头部加 `act` 导入并追加 1 个用例。**同区不同逻辑，机械合并**（保留 main 的 mock 头 + 加回分支用例）。
- 最小下一步：人豁免 ui-shots（真机证明已归 N-FIX-NOTIFY-DISPLAY-GAP-FU1-NATIVE）或驳回要求 DEV 构建补图 → 解冲突 → ship。
- 工作量：S。

## 8. N-IMAGE-MULTI-REF-IMPL — landing-failure_land-ee424b06 — 卡点：返修后 gates:fast 选中 15 > 12（旧冲突已解、PR 已 MERGEABLE） — 最小下一步：爸拍板再豁免或拆 1–2 个测试出分支 → ship — 工作量 S–M

- 卡点原文①（state/merge.log，11-04 20:13，**已过时**）：`ship: PR#2767 behind main by 21; updating branch (round 1)...` → `X Cannot update PR branch due to conflicts` —— 21:13 返修交付（588437a35 合 main + 29cd17d2f 重录快照）后，现 merge-tree 干净、GitHub `mergeable=MERGEABLE (BEHIND)`、落后 38。**冲突不再是卡点**。
- 卡点原文②（state/fail-fp，21:16 起同指纹 3 次，现行卡点）：`land:1:✗ gates:fast FAILED: FAIL: selected <n> files; allowed <n>..<n>; never truncate. receipt=<uuid>`
- 明细（selectTests 按现分支复算）：改动测试 5 + 基线 3 + 回归登记 2 条 4 文件（含「收活人在合并树上重录的 request-replay 快照」1 条）+ 规则附加：prompt→promptGateEvidence（← imageGenerate.schema.ts + agent.ts）、domain-routes 3（← workspaceDesignMedia.ipc.ts）、renderer-token-boundary、perf-journey-cold-start = **15**。
- 豁免史（state/fastgate-waive-auto）：`收活循环 2026-11-04 自动豁免：gates:fast 选中 14 文件仅超上限 2 个；PR 上 CI 全量门照跑为权威（爸 10-13 同意）`——返修后变 15（超 3），超出自动豁免阈值才挂的。
- 最小下一步：爸二选一——A 沿 10-13 口径再豁免一次（15 仅超 3，PR 上 CI 全量门为权威）；B 从分支拆走 1–2 个非本单测试（如 perf-journey-cold-start 由 i18n/en|zh.ts 触发，可挪）。之后 ship 落地即通。
- 工作量：S（豁免）/ M（拆分含返工轮）。

## 9. N-DELEGATE-SESSION-K2-FU1 — mapper-human-verdict — 卡点：纯决策——一致率 77–80% 未到 90%、E2=5，下一步路线要爸定 — 最小下一步：爸在 decision followup 上选 A/B/C 并记 ADR-072 — 工作量 S

- 卡点原文（work/verdict.json human_reason）：`台账 ≥90% 一致率和 E2=0 这两个目标在本单范围内达不到：继续推进要在「再裁一轮」和「选项 B 调澄清工具描述」之间选，选项 B 按任务书是另行拍板的事；还要决定本单是否按「测量完成、目标未达」收。`
- 数字（verdict gaps）：一致率新种子 77.27%（34/44）/ 旧种子 79.55%；clarify 2/4=50%；E2=5（0052/0116/0140/0143/0181，其中 3 条确定是模型把该澄清的请求绑定/新建）；新种子 10 个分歧 id + 0052/0181/0070 未裁；E1 temperature=0 两次跑名单漂移。
- 决策内容（两句）：K2B 接电判断走哪条路——A 只再裁一轮（K2A 第二轮裁决单 followup 已备好）、B 开选项 B 调 `delegate_session` 工具描述的澄清引导、C 并行（工人推荐 C：裁决修一致率，E2 的确定模型失败只有 B 能修）；以及本单是否按「测量完成、目标未达」收。分支上还有 feat(eval) 工具改动（3a5c477e7）未落地（无 PR），是否落地一并定。
- 最小下一步：爸拍板 A/B/C 记入 ADR-072；后续单已写好可直接派。
- 工作量：S（纯决策）。

## 10. N-STOP-ABANDON-ENTRY — ui-shots — 卡点：截图已齐（evdir 9 张），纯等人工目验后 touch ui-ok — 最小下一步：人看图 → touch ui-ok → 循环自动交后台合并 — 工作量 S

- 卡点原文（state/hold-ui）：`UI 单（动了 src/renderer/components|styles）：合入前要 before/after 截图，收活循环 2026-11-03 自动挂起；验完 touch ui-ok 即可（循环自动补 pr-opened 交后台合并）`
- 验收要 vs 已有（evdir=`~/work/code-agent-private-archive/docs/evidence/N-STOP-ABANDON-ENTRY-ui-shots-2026-11-03-0757/`）：
  - 放弃 walkthrough 5 步（证据档 a/b/b2/c/d，原始版在 `~/work/out/N-STOP-ABANDON-ENTRY/shots/` 五张俱在）→ evdir zh 重拍版对应 `3-after-zh-parked-row.png`、`4-after-zh-confirm-dialog.png`、`5-after-zh-after-dialog-cancel.png`、`6-after-zh-after-abandon.png`、`7-after-zh-after-reload.png` **全在**；
  - before 态：`11-before-zh-idle.png`、`12-before-zh-inflight-streaming.png` **在**；另有 `1-after-zh-idle.png` 与 `geometry-after-zh.json`。
  - 即：要的都有，无缺号。
- 现状：PR#2720 OPEN、MERGEABLE、落后 114（update-branch 自动）。
- 最小下一步：人目验 evdir 9 张 → `touch ~/.ship/collect/state/N-STOP-ABANDON-ENTRY/ui-ok`。
- 工作量：S。

## 11. N-SANDBOX-ESCALATE-CHMOD-SHAPE-FU1A-CLICKLOG — ui-shots — 卡点：改动无可见 UI 变化（纯日志埋点），等人工豁免 — 最小下一步：人豁免 → 解 2 文件冲突 → ship — 工作量 S–M

- 卡点原文（evdir README）：`# 审批卡点击留痕：UI 截图验收（无可见变化）`；依据：PermissionCard.tsx 只在 4 个提前 return/catch 多调一次 `logPermissionClickExit`，httpTransport.ts 在 3 处抛 PermissionSendFailure 前加同一日志调用，「没有改 JSX、className、文案和 toast 逻辑」「截图两边会完全相同」；验收表「审批卡外观与交互不变——通过（静态核对）」，日志落宿主由 PR 自带 3 份 HTTP 链测试覆盖。
- 附加现状：PR#2649 OPEN、CONFLICTING、落后 188。冲突 2 文件（都是本 PR 改的文件）：
  - `src/renderer/api/httpTransport.ts`：main 在同一批错误路径加 serverConnectionMonitor 断流上报（`reportServerUnreachable()`），分支在同些路径插 `logPermissionClickExit`。**意图独立、行贴行，两边插入并存，机械但需细心**。
  - `src/renderer/components/PermissionDialog/PermissionCard.tsx`：main 加 SensitiveStepHandbackCard/classifyPermissionDelivery 并删一段投递失败注释；分支给同一 handleApproval 的提前 return 包日志。**同函数双改，需小心但意图独立**。
- 最小下一步：人豁免 ui-shots（或驳回）→ 解 2 文件冲突 → ship。
- 工作量：S–M（冲突在两文件但解法并集）。

## 12. N-BGPANEL-STOP-TERMINAL — landing-failure_land-ee424b06 — 卡点：gates:fast 选中 15 > 12，push/PR 从未建出 — 最小下一步：与 CRON 同根因——爸拍板拆单或提上限 — 工作量 M（拆单）/ S（提上限，但要人）

- 卡点原文（work/ship-last.out，11-03 19:11/19:22/19:34 三次同因）：
  `✗ gates:fast FAILED: FAIL: selected 15 files; allowed 1..12; never truncate. receipt=fa46664d-b9b2-479e-9bed-adc525cfac61` → `ship: ERROR: gates:fast rejected — push/PR blocked`（无 PR）
- 明细（selectTests 按 merge-base a97275a99 复算，含收活侧已登记的 regressions.json）：基线 3 + 改动测试 6（backgroundSessionPanel.stopClear、useRendererBundleAutoReload.runningCount、sessionStore.backgroundStopDismiss、httpTransport.background、backgroundTaskManager、appAssembly）+ 规则 6：domain-routes 3（← `src/host/ipc/background.ipc.ts`）、renderer-token-boundary、perf-journey-cold-start（← i18n/backgroundPanel.ts）、perf-journey-session-switch（← sessionStore.ts）= **15**（回归登记 3 文件与改动测试重合，不重复计）。
- 判定依据：verdict 可收、gaps 两条（真机验收单 + 停止图标语义小瑕疵 worker 单），代码本身无卡点，纯落地门。
- 最小下一步：与 CRON 二选一相同——A 拆单（把 sessionStore.ts 或 background.ipc.ts 相关改动拆续单可省 3–4 个规则文件）或 B 提上限（政策，需人同意）。证据档 gaps 里本来就有 1 条 worker followup（停止图标），拆单边界可顺它切。
- 工作量：M（拆单）/ S（提上限，要人）。

---

## 判断题记录（无人可问，按证据取舍）

1. 本机无 fleet/ship/rtk：票面 title/acceptance/branch/pr/evidence 全部用 `~/.ship/collect/state|work/<票>/`、`~/work/evidence/<票>.md`、`gh`、git 还原；未跑任何写命令，merge 检查只用 `git merge-tree --write-tree`。
2. CONNECTOR 的 gates-fast 回执里 `--head aa102277541d` 不在现分支上（12:23 的 merge 提交后来重做过）；以 work/ship-last.out 全文 + state/merge.log 为准，两个 blocker（冲突+PROMPT_VERSION）都有原文。
3. IMAGE 的 park 原因里的冲突已过时：现 merge-tree 干净、GitHub MERGEABLE；现行卡点只有 gates:fast 15>12。
4. CRON/BGPANEL 的选中数复算用 `merge-base(origin/main,分支)` 的 changed 集（land 时先合 main 再算，changed 集合等价）；复算 16/15 与回执数字完全一致，可信。
5. gates:fast 的 12 上限是写死政策（`gates-fast.mjs:139` 断言必须=12），提上限属政策变更只能爸定；本档不替爸决定拆单还是提限，只把两边的账算清。
6. FIX-PARKED 判定 before 图由父单 FU2 的 evdir 承担（r2 本轮零代码改动）；如收活人要求本单自带 before，需回工人补拍（工作量升 M）。
7. ui-shots 四张我全部不截图、不替人豁免，只列「验收要什么 / 现存什么 / 差什么」。

## 汇总表（按工作量排序，S → M）

| # | 票 | 挂起原因 | 一句话卡点 | 最小下一步 | 工作量 |
|---|---|---|---|---|---|
| 3 | N-CUA-SCREEN-GUARDS-SENSITIVE-PROBE-FU3 | risk-high | 命中 `src/host/permissions/*`，等 SHIP_RISK_ACK（CI 全绿、ai-review 0 Important） | 人签字 `ship merge 2802` | S |
| 9 | N-DELEGATE-SESSION-K2-FU1 | mapper-human-verdict | 一致率 77–80%<90%、E2=5，路线 A/B/C 要爸定 | 拍板记 ADR-072（推荐 C 并行） | S |
| 10 | N-STOP-ABANDON-ENTRY | ui-shots | 9 张截图已齐在 evdir，纯等人看 | 目验 → `touch ui-ok` | S |
| 5 | N-FIX-PARKED-…-FU2-FU2 | ui-shots | evdir 空但 2 张图在 `~/work/out/…/shots/`，漏拷 | 拷进 evdir → 目验 → ui-ok | S |
| 6 | N-BROWSER-KEEP-RESULT-PAGE | mapper-human-verdict | 收活侧缓存 regressions.json 引用已删测试（工人改不到）；确认拆单收法 | 按 Rework r3 重建缓存或清缓存重生成 → ship pr | S |
| 7 | N-FIX-NOTIFY-DISPLAY-GAP-FU1-CLICKROUTE | ui-shots | 无可见变化拍不到（README 论证），等豁免；另有 1 测试文件冲突 | 人豁免 → 解 CronCenterPanel.test.tsx → ship | S |
| 1 | N-CONNECTOR-READ-UNTRUSTED | landing-failure | PR#2721 冲突（agent.ts PROMPT_VERSION 真冲突 + 证据 JSON trivial）+ 曾欠 PROMPT_VERSION bump | 解 2 文件冲突（取 ≥sys-v97）→ ship pr | S |
| 11 | N-SANDBOX-ESCALATE-…-CLICKLOG | ui-shots | 纯日志埋点无可见变化，等豁免；httpTransport+PermissionCard 2 文件冲突 | 人豁免 → 解冲突 → ship | S–M |
| 8 | N-IMAGE-MULTI-REF-IMPL | landing-failure | 返修后 gates:fast 15>12（超 3，超出自动豁免阈值）；旧冲突已解 | 爸拍板再豁免或拆 1–2 测试 → ship | S–M |
| 4 | N-CRON-MORNING-TRIAGE-REST1 | landing-failure | gates:fast 16>12，**结构性**（改动测试 11+基线 3=14 已超） | 爸拍板拆单（M）或提上限（S，政策） | M/S |
| 12 | N-BGPANEL-STOP-TERMINAL | landing-failure | gates:fast 15>12，同 CRON 根因 | 同上二选一 | M/S |
| 2 | N-APPSHOT-HOTKEY-TCC-PREFLIGHT | ci-failure+risk-high | eslint max-lines 超基线 1 条（本 PR +1 行压线，非抖动）+ allow-list 高风险档等签字 + 2 文件冲突 | 文案挪域文件、解冲突、重跑 CI、人签 SHIP_RISK_ACK | M |

共性备注（给总控）：4 张落地卡点里 3 张（CRON/BGPANEL/IMAGE）同因——gates:fast 12 文件测试预算对「一次改动覆盖多组件」的交付偏紧，一次政策决定（提上限或明确拆单规则）能同时解锁三张；ui-shots 四张里两张是「无可见变化」的书面论证等豁免、两张是图已齐/图漏拷等人动作，全部 S。

DONE N-HUMAN-HOLD-PRECHECK-A 64ba8ef30

---

## 返修轮 r1（2026-11-06 08:30）——上轮预诊断已验真，本轮补交付提交

**上轮被拒原因**：分析完成但没进仓——DONE 行写了 `64ba8ef30`，那是 origin/main 的 HEAD；分支 `mq/human-hold-precheck-a` 比 origin/main 多 0 个提交、无未提交改动，等于没交付。本轮补：本档全文提交进 worktree 根目录 `N-HUMAN-HOLD-PRECHECK-A.md`（分支 `mq/human-hold-precheck-a`，只 commit 不 push），收活 DONE 行 = 该提交 sha（见本档最后一行）。

**本轮只读复核（对照 live 状态，上档结论零漂移）**：
- 名单：`human-hold-1106.tsv` 1–12 行票名与挂起原因逐行一致（全表 23 行）。
- PR 现状（gh）：2721/2616/2741/2649 OPEN·CONFLICTING；2802/2816/2720/2767 OPEN·MERGEABLE(BEHIND)；CRON/BGPANEL/DELEGATE/BROWSER 四分支 0 PR。
- merge-tree 复跑（输出在 `~/work/out/N-HUMAN-HOLD-PRECHECK-A/mt-*.out`）：2721 冲突 `src/shared/constants/agent.ts`+`docs/eval/prompt-gate-latest.json`；2616 冲突 `src/renderer/services/nativeDesktop.ts`+`src-tauri/src/native_desktop.rs`；2741 冲突 `tests/renderer/components/CronCenterPanel.test.tsx`；2649 冲突 `src/renderer/api/httpTransport.ts`+`src/renderer/components/PermissionDialog/PermissionCard.tsx`；2767（IMAGE）干净——冲突确已不是 IMAGE 的卡点。
- gates:fast 选量复算（`~/work/out/N-HUMAN-HOLD-PRECHECK-A/simulate-selection.mjs` 重跑）：CRON 16/12（基线 3+改动测试 11+规则 2）、BGPANEL 15/12（含收活侧 regressions.json）、IMAGE 15/12——与三张回执数字一致。
- 引用逐字复核：CUA merge.log（`src/host/permissions/*` + SHIP_RISK_ACK 行）、BROWSER mapper.log + 缓存 regressions.json 首条仍列 `BrowserKeptResultBar.test.tsx`（该文件在分支上 MISSING，`git cat-file -e` 已验）+ regr-generated=d9a2086d0、CRON/BGPANEL 的 fail-fp 与 ship-last（selected 16/15; allowed 1..12; never truncate）、DELEGATE verdict.json human_reason、FIX-PARKED hold-ui + evdir 0 文件 + `~/work/out/…/shots/` 恰好 2 张、STOP-ABANDON evdir 9 个文件齐、SANDBOX/CLICKROUTE evdir README「无可见变化」论证。
- CI 红账复核（APPSHOT run 41424753502 日志逐字）：`[eslint-ratchet] errors current=1 baseline=0 delta=+1`、`src/renderer/i18n/zhSettingsWork.ts:1002:1:max-lines` 属实；zhSettingsWork main 1001 行 vs 分支 1002 行属实；main 近 10 次 run 全 success（非抖动）；agent.ts main=`'sys-v96'` vs 分支=`'sys-v94'` 属实。
- **一处引用订正**：APPSHOT 的「high 风险档」原文已不在现行 `state/merge.log`（该文件被 11-02 CI 失败的落地尝试覆写，文件尾现为 CI 失败账）；实质不变——PR#2616 改 `src-tauri/permissions/app-commands.toml`，命中 `RISK-PATHS:14` 的 `src-tauri/permissions/*`，`state/risk-ack` 存有 mini Opus 全量分析（新增 2 条 allow、无通配、只读 preflight + 一次性请求），等签字。

**给总控**：上档 12 节与汇总表原样有效，直接按各票「最小下一步」动手；三个 gates:fast 超限票（CRON 16、BGPANEL 15、IMAGE 15）同根因，一次政策决定（提上限或明确拆单规则）可同时解锁三张。

收活 DONE 行：见台账 `~/work/evidence/N-HUMAN-HOLD-PRECHECK-A.md` 最后一行 = 本提交（分支 mq/human-hold-precheck-a）。
