# N-HUMAN-HOLD-PRECHECK-B — 挂人工交付预诊（名单 13–23 行，只读）

- 日期：2026-11-06。名单来源：`sed -n '13,23p' ~/work/queue/assets/precheck/human-hold-1106.tsv`（11 张）。
- 取证时 `~/work/collect/code-agent` 的 `origin/main` = `64ba8ef30`（已先 `git fetch -q origin`）。
- 数据源：`fleet show <t> --json`（只读）、`~/.ship/collect/state/<t>/`、`~/.ship/collect/work/<t>/`、`~/work/evidence/<t>.md`、`gh pr view / gh run view`（只读）、`git merge-tree --write-tree`（只读）。
- 全程只读：未改任何仓库/工作树/队列状态/工单，未合并、未重跑 CI、未 touch ui-ok，未 commit/push。

## 判断取舍（无人应答，如实记录）

1. 施工环境段写「这台机没有 fleet / ship / rtk」，实际 `fleet`/`ship`/`rtk` 都在 PATH。按任务书正文「fleet show/fleet list 是 fine」只用了只读的 `fleet show`/`fleet list`；`ship` 一律没用。
2. 任务书禁跑 gates:fast / vitest / eslint 等全量检查，三张 gates:fast 卡点单的选中文件数（16/20/15）引用自收活循环留档（`~/.ship/collect/work/<t>/`）与编排判断原文，非本机重跑。
3. 17、22 的 state 文件 `ui-shots-evdir` 指向的目录（…-2026-11-04-1837 / …-2026-11-04-1851）在 `~/work/code-agent-private-archive/docs/evidence/` 下**不存在**；实际截图在 17 的 `…-2026-11-04-1403/`（第 1 轮）与 `~/work/out/N-PY-RUNTIME-K3-PREVIEW-NOINSTALL/`（第 2 轮 r2）、22 的 `~/work/out/N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1-P2/walkthrough/`。这就是两单挂起的直接机械原因之一（验收员 verdict.json 读不到 → 输出无效 → 要人）。
4. ②验收口径：三张 ci-failure 单都读到了出 `##[error]` 的那一步；13 的失败 job 根本没有 `##[error]`（结论是 cancelled），判假红。三张都没有出现 better-sqlite3 找不到模块一类已知噪声行，噪声未参与定因。

---

## 13. N-FIX-NEWTASK-INIT-MEMORY-ENTRY-POPOVER-PROBE — ci-failure — PR#2768（OPEN，MERGEABLE/BEHIND）

- **卡点原文**（`~/.ship/collect/state/N-FIX-NEWTASK-INIT-MEMORY-ENTRY-POPOVER-PROBE/merge.log` 尾）：
  `Unit + renderer vitest (shard 3/4)	fail	20m18s	…/runs/42086103754/job/127451502559` → `ship: ERROR: CI checks failed on PR#2768 — fix and re-run 'ship merge'`。
  但 job API 显示该 step **没有 `##[error]`，conclusion=`cancelled`**（18:38 起 20 分钟后被取消），且同一 PR 上一头 `c373c641` 的 Swarm CI run 42084241941 是 **success**；`c373c641..3698cd56` 只有 update-branch 的 merge 提交，patch 无实质变化。
- **定因**：假红（run 被取消），不是本 PR diff 引起；不是 better-sqlite3 类噪声，是取消。
- **最小下一步**：编排侧对 run 42086103754 重跑（`gh run rerun 42086103754 --failed`）或更新分支触发新一轮 CI；绿即收。
- **工作量**：S

## 14. N-STALE-AGENT-CHIP-AFTER-QUIT — ci-failure — PR#2792（OPEN，MERGEABLE/BEHIND）

- **卡点原文**（run 41998810850，job 127148590044，`##[error]` 出在 **ESLint error/warning ratchet** 步）：
  `[eslint-ratchet] errors current=1 baseline=0 delta=+1` / `[eslint-ratchet] 超基线 findings…：  src/web/webServer.ts:1385:1:max-lines`。
- **定因**：本 PR 引起。`max-lines` 上限 1000（skipBlankLines+skipComments，`eslint.config.js:246`），PR 给 `src/web/webServer.ts` +2 有效行，恰好把 999→1001 越线。注意：**当前 origin/main 的该文件已降到 995 有效行**（后续别的改动清过），rebase 到新 main 后 995+2=997<1000。
- **最小下一步**：ship update-branch 到新 main 后重跑 CI（大概率自动消红）；若仍 ≥1000，从 webServer.ts 挪 2 行出去（该文件本就在 950-tier 预警名单，见 run 内 warning `src/web/webServer.ts (1001)`）。
- **工作量**：S

## 15. N-DISCLOSURE-DEFAULT-SIMPLE-FRESH — ci-failure — PR#2698（OPEN，MERGEABLE/BEHIND）

- **卡点原文**（run 41596519439，job 125788969415，`##[error]` 出在 **Security guards (vitest tests/security)** 步）：
  `AssertionError: CODE_AGENT_HOME assigned without CODE_AGENT_DATA_DIR:  tests/unit/services/core/devSlotSeedDisclosure.test.ts: expected [ Array(1) ] to deeply equal []`（`tests/security/codeAgentHomeIsolationGuard.test.ts:85:7`，retry x1 仍红）。
- **定因**：本 PR 引起——PR 新增的测试 `devSlotSeedDisclosure.test.ts:70` 设了 `process.env.CODE_AGENT_HOME = root` 但没同步设 `CODE_AGENT_DATA_DIR`，被隔离守卫测试扫出。近期 main 的 Swarm CI（run 42214706100、42170080433）全绿，非既有/抖动。
- **最小下一步**：在该测试的 HOME 赋值处补 `CODE_AGENT_DATA_DIR`（与守卫要求对称），本地 `npx vitest run tests/security` 验绿后 push。
- **工作量**：S

## 16. N-CRON-CLOUD-DOWN-NOTICE-MIXED-LANG — ai-review-failure — PR#2769（OPEN，MERGEABLE/落后 main 10 个提交）

- **卡点原文**（`~/.ship/collect/state/…/merge.log` 尾）：
  `ship: PR#2769 behind main by 1; updating branch (round 2)...` → `GraphQL: Something went wrong while executing your query on 2026-11-05T16:10:47Z. Please include CB14:ACF89:1B5D0A:2B743E:6AECAA85…` → `ship: ERROR: update-branch failed (likely conflicts with new main) — resolve manually`；另一路：`auto-ai-review-failure`=3（ai-review 审查器**自身**失败重试 2 次后放弃）。
- **现状核查**：PR 当前头 `ed43753f`（update-branch 实际已并入过一次 main），statusCheckRollup 17/17 无失败；最新 ai-review 评论（head `0052ffe`，patch-id 未变 carry over）为 **Important: 0 · Nit: 0 🟢**；`git merge-tree --write-tree origin/main origin/mq/cron-cloud-down-notice-mixed-lang` 无冲突。真实阻碍只是：审查器进程故障计数 + 一次瞬时 GraphQL 错误让收活循环停手。
- **最小下一步**：编排侧重试落地（`ship pr` / update-branch round 3）；无代码要改。
- **工作量**：S

## 17. N-PY-RUNTIME-K3-PREVIEW-NOINSTALL — ui-shots — PR#2796（OPEN，MERGEABLE/BEHIND）

- **验收要的截图**（台账 6 条）：①无 LO 时点 pptx 预览出「后台准备预览组件…」；②安装成功后 runtimes 目录生成+预览**自动重试**出页图、失败提示写明具体原因；③officeRaster 托管路径（非 UI 项）；④设置→更新→本机功能 LibreOffice 状态行；⑤补测试（非 UI 项）。
- **已有截图**：
  - 第 1 轮验收目录 `…/N-PY-RUNTIME-K3-PREVIEW-NOINSTALL-ui-shots-2026-11-04-1403/`（before/after 成对 20 张 + README）：00-landing、01-ready、02a-preparing、02b-after-install、03-offline(zh/en)、04-unsupported(zh/en)、05-installfailed(zh/en)。
  - 第 2 轮 r2：`~/work/out/N-PY-RUNTIME-K3-PREVIEW-NOINSTALL/r2-02a-preparing.png`、`r2-02b-after-install.png`、`picker-ready-web.png`（真 webServer，4.7s 自动出页图，Vision OCR 像素复核）。
- **卡点原文**（第 1 轮截图验收 README 结论）：`## 结论：rework（返修）` ——「**工单点名的「右栏点 pptx 预览」路径不会自动重试**…验收第 2 条『预览自动重试并出页图』在该路径没有达成（自动重试目前只在聊天消息附件路径生效）」。r2 已修（PresentationPagePicker.tsx:54 有界重试）并贴了 r2 截图，但 state 的 `ui-shots-evdir` 指向**不存在**的 `…-2026-11-04-1837` 目录 → 验收员 verdict.json 读不到 → 自动挂起要人（`hold-ui`：`验完 touch ui-ok 即可`）。
- **最小下一步**：人工核对 r2 两张截图（r2-02a/02b，右栏自动重试已生效）与第 1 轮 1403 目录，认可后 `touch ~/.ship/collect/state/N-PY-RUNTIME-K3-PREVIEW-NOINSTALL/ui-ok`，循环自动续落地；③④两项台账已判 STALE/桌面壳不可达，有真机续单跟进，不挡收。
- **工作量**：S

## 18. N-ROLE-ROUTINE-RESTATE-FU1-FU1-FU2 — mapper-human-verdict — PR#2627（OPEN，CONFLICTING/DIRTY）

- **卡点原文**（fleet note）：`收活循环 2026-10-28 要人：无头核查员没写 verdict.json（看 mapper.log）｜编排判断：输出无效（not json (JSONDecodeError)），照旧要人`。
- **被问的决策**：无头核查员没产出 verdict，要人替它拍「收不收」。
  - **收的一侧**：`followups-verdict.json` 判「可收」，两条 gap 均注明「不挡收」——验收原文②「单测断言 payload 含 roleId」写于爸 10-29 拍板方案 A（云端**拒绝**角色 agent 并说明原因）之前，按方案 A 不适用；实现/证据对齐方案 A（真实 CronService+Runtime、stub fetch、roleId 云端注册 0 次调用、反向变异真红）；首轮 UI 截图已验收放行（state 有 `ui-ok`/`ui-released`，10-29）。
  - **缓的一侧**：截图验收是按首轮代码做的，整合轮把按钮 disabled 条件改成了 `cloudRoleBound || webhookGated` 并集（renderer 测试覆盖，未重拍截图）。
- **顺带的落地障碍**：PR 现与 main 冲突，`git merge-tree` 冲突 5 文件——`cronExecutionPolicy.ts`（import 行，trivial）、`CronJobDetail.tsx`（import 行，trivial）、`CronSimpleCreate.test.tsx`/`cronServiceDisabledCloudCopy.test.ts`（两侧各自加测试/夹具，保留双方，trivial）、`cronService.ts`（2 处同一行验证语句：main 加 `assertAgentTypeOnSave`、分支加 `assertCloudRunnableAction`，需**并集**两断言，real 但小）。
- **最小下一步**：人确认「可收」→ 放行后按上面口径合 main（并集 import 与两个 assert、两侧测试都保留）→ ship。
- **工作量**：M

## 19. N-PERM-GRANT-TIERS — risk-high — PR#2547（OPEN，CONFLICTING/DIRTY）

- **卡点原文**（`~/.ship/collect/state/N-PERM-GRANT-TIERS/merge.log` 尾）：
  `ship: ai-review: success on 419fa82` 之后 `ship: ERROR: PR#2547 是 high 风险档（命中 RISK-PATHS，见上）——要人裁决：SHIP_RISK_ACK="<谁裁的·理由>" ship merge 2547`；RISK-PATHS 命中：`src/host/permissions/* ⇐ grantLedger.ts / preAskGrant.ts / toolGrantStore.ts`。
- **被问的决策**：给不给这条高风险路径 PR 的人工风险确认（SHIP_RISK_ACK）。
  - **放的一侧**：CI 全绿（18 passed / 2 skipped）、ai-review success、核查「可收」、反向变异两处真红、真实 GLM 真跑台账行与 SSE 吻合；UX 半已拆单 `N-PERM-GRANT-TIERS-P2`（排队，wave 53，母单合入后派）；拆单令本身出自收活人。既有先例：`fastgate-waive-auto`（劳拉 10-26 判 gates:fast 16 文件超上限不挡，PR 上 CI 全量门为权威）。
  - **慎的一侧**：本单在 `recordHumanGrant` 铸 `allow_run`/`allow_24h` **standing 授权**（最长 24h 免问），属审批默认面（AGENTS §5.7 敏感区）；且卡面两档文案/剩余时间显示在 P2，P2 合入前用户看不到两档，等效于「后台先加了授权能力、界面后到」。
- **新增落地障碍**：PR 现与 main 冲突 1 文件 `src/host/agent/orchestratorPermissions.ts`——main 侧在**同一个 `recordHumanGrant`** 加了 ADR-088 敏感步骤 hand-back 整体跳过铸造，分支侧把同一函数扩成两档铸造（updatedArgs 非 allow 一律不铸）——**real conflict**，解法必须同时保住 main 的 fail-closed 语义与本单两档语义。
- **最小下一步**：人出 SHIP_RISK_ACK（写明谁裁+理由）→ 按上句合并 orchestratorPermissions.ts 冲突 → `SHIP_RISK_ACK="…" ship merge 2547`。
- **工作量**：M

## 20. N-PERM-NL-RULES-K2 — landing-failure_land-ee424b06 — 无 PR（分支 `mq/perm-nl-rules-k2` head `8d5a62c75`）

- **卡点原文**（`fail-fp`，同指纹 ×3）：`land:1:✗ gates:fast FAILED: FAIL: selected <n> files; allowed <n>..<n>; never truncate`；收活留档实数：**selected 16 files; allowed 1..12; never truncate**（receipt 1dd136eb-71f1-4278-b92e-d2c37e8409d7），成因 `scripts/lib/gates-fast-contract.mjs selectTests()` 把分支 diff 里每个改动 `*.test.ts` 都计入选择。
- **定因**：不是代码问题——核查「可收」、r3 证据全绿（tsc/ratchet/knip/eslint/四目录 vitest 全贴原始行），`git merge-tree` 对 main **无冲突**。卡点纯是 gates:fast 12 文件快门预算上限（`scripts/lib/gates-fast-policy.json` `maxFiles:12`）。
- **被问的决策**：怎么满足 12 文件上限（拆交付范围 / 合并测试文件 / 改闸门策略）——编排侧已自判「拆范围和改闸门都超出了自动处理的权限」。有 19 的免跑先例可援引。另有一条例行待爸问题已登记在 followups：preapprove 规则对 GuardFabric 强制审批工具（Bash/Write）在 cron/异步不生效，要不要在设置卡片明示（推荐 A：加一行 i18n 文案）。
- **最小下一步**：人沿用 10-26 先例给 fastgate 豁免（或定拆单方案）→ 直接 `ship pr`；无代码要改。
- **工作量**：S（若豁免）/ M（若拆单）

## 21. N-ROLE-PROACTIVITY-CHAT-TUNE — landing-failure_land-ee424b06 — PR#2567（OPEN，CONFLICTING/DIRTY）

- **卡点原文**（`fail-fp`，同指纹 ×3）：`land:1:✗ gates:fast FAILED: FAIL: selected <n> files; allowed <n>..<n>; never truncate`；收活留档实数：**selected 20 files; allowed 1..12; never truncate**（`scripts/gates-fast.mjs:153-157`）。
- **第二层障碍**：PR 现与 main 冲突 **125 文件**——123 个 `packages/internal/evaluation-center/snapshots/request-replay/*` 快照 + `docs/eval/prompt-gate-latest.json` + `src/shared/constants/agent.ts`。前两类是两侧都重录过的生成物（解法=合 main 后 `npm run acceptance:snapshot-replay:record` 重录，机械）；`agent.ts` 是同值冲突：main（N-FG-CONNECTOR-TOOLS）与本单各自把 `PROMPT_VERSION` 从 `sys-v95` 升到 `'sys-v96'`、注释不同——合并后的 prompt 输入面两侧都没记录过，按本单自己在注释里立的惯例应再升版。
- **被问的决策**：同 20——12 文件上限的满足方式（编排侧无权拆范围/改闸门）。
- **最小下一步**：人定上限方案 → 合 main/升 PROMPT_VERSION → 重录快照与 prompt-gate manifest → ship pr。
- **工作量**：M

## 22. N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1-P2 — ui-shots — PR#2818（OPEN，CONFLICTING/DIRTY）

- **验收要的截图**：母单 split 证据段 Part 2（renderer 写授权面板）的 before/after 用户路径截图。
- **已有截图**：`~/work/out/N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1-P2/walkthrough/`：`00-verify-shot-landing.png`、`01-not-granted.png`、`02-granted.png`、`03-revoked.png`（三态：未授权 offer→授权+撤销→回 offer，md5 与档案一致、核查员本地重算核验过）。
- **卡点原文**（fleet note）：`收活循环 2026-11-04 要人：截图验收员输出无效（verdict.json unreadable (FileNotFoundError)）`；`hold-ui`：`UI 单（动了 src/renderer/components|styles）：合入前要 before/after 截图…验完 touch ui-ok 即可`。state 的 `ui-shots-evdir` 指向不存在的 `…-2026-11-04-1851`。
- **顺带**：PR 现与 main 冲突 1 文件 `tests/renderer/components/CronJobDetail.test.tsx`，仅 1 处 hunk——main 加了「中文 24 小时制」测试、分支加了「文件写入授权面板」测试，两侧各自加测试 → **trivial**（都保留）。
- **最小下一步**：人过目 3 张三态截图 + 00 落地页 → `touch ~/.ship/collect/state/N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1-P2/ui-ok` → 合 main（保留双方测试）→ ship。
- **工作量**：S

## 23. N-CONNECTOR-POLISH-AUDIT-FU4-SCOPE — landing-failure_land-ee424b06 — 无 PR（分支 `mq/connector-polish-audit-fu4-scope` head `47fb79222`）

- **卡点原文**（`fail-fp`，同指纹 ×3）：`land:1:✗ gates:fast FAILED: FAIL: selected <n> files; allowed <n>..<n>; never truncate`；编排判断留档实数：**selected 15 files; allowed 1..12; never truncate**，并判「同一个失败指纹连续出现 3 次，光调回归登记解决不了」。
- **定因**：同 20/21——gates:fast 12 文件上限；分支改 ~22 个源文件 + 8 个测试文件（含新增 fakeOAuthMcpServer.ts 等夹具）。核查「可收」，`git merge-tree` 对 main **无冲突**，M1–M4 反向变异红行齐全，真跑+headless 截图走到成功态。
- **被问的决策**：编排侧给的选项 1 = 把本单**拆成两张单**分批落地（先落宿主侧 insufficient_scope 识别 + scope 升级 host action）；拆范围超出自动化权限，要人拍板。
- **最小下一步**：人拍拆单（或给 fastgate 豁免）→ 按拆后范围/豁免直接 `ship pr`。
- **工作量**：S（若豁免）/ M（若按宿主侧先拆）

---

## 汇总表（按工作量排序）

| # | ticket | 原因 | 卡点（一句） | 最小下一步 | 工作量 |
|---|---|---|---|---|---|
| 13 | N-FIX-NEWTASK-INIT-MEMORY-ENTRY-POPOVER-PROBE | ci-failure | shard 3/4 run 被取消（无 `##[error]`），上一头全绿＝假红 | 重跑 run 42086103754 / 更新分支再跑 CI | S |
| 14 | N-STALE-AGENT-CHIP-AFTER-QUIT | ci-failure | eslint-ratchet `##[error]`：webServer.ts 有效行 1001>1000（PR +2 行越线；main 已降到 995） | update-branch 到新 main 重跑；仍红则挪 2 行 | S |
| 15 | N-DISCLOSURE-DEFAULT-SIMPLE-FRESH | ci-failure | `##[error]` Security guards：新测试设 CODE_AGENT_HOME 未设 CODE_AGENT_DATA_DIR，守卫扫出（main 近期全绿，非抖动） | 该测试补 CODE_AGENT_DATA_DIR，vitest tests/security 验绿 | S |
| 16 | N-CRON-CLOUD-DOWN-NOTICE-MIXED-LANG | ai-review-failure | 审查器自身故障×3 + update-branch 瞬时 GraphQL 错误；CI 17/17 绿、ai-review 0 Important、merge-tree 无冲突 | 重试 ship pr（update-branch round 3） | S |
| 17 | N-PY-RUNTIME-K3-PREVIEW-NOINSTALL | ui-shots | 第 1 轮截图验收=rework（右栏不自动重试）；r2 已修并贴图，但第 2 轮 evdir 缺失→verdict 读不到→挂人 | 人核 r2-02a/02b 截图 → touch ui-ok | S |
| 22 | N-RESIDENT-SCHEDULE-KEEPALIVE-DAEMON-FU1-P2 | ui-shots | 截图验收员 verdict.json FileNotFoundError；三态截图已在 walkthrough/ 且 md5 核验；PR 与 main 冲 1 trivial 测试文件 | 人过目 3 张图 → touch ui-ok → 合 main（双方测试都留） | S |
| 20 | N-PERM-NL-RULES-K2 | landing-failure | gates:fast selected 16 > 12（never truncate）×3；分支无冲突、核查可收、无代码问题 | 人给 fastgate 豁免（有 10-26 先例）或定拆单，再 ship pr | S/M |
| 23 | N-CONNECTOR-POLISH-AUDIT-FU4-SCOPE | landing-failure | gates:fast selected 15 > 12 ×3；分支无冲突、核查可收；编排建议拆宿主侧先落 | 人拍拆单方案（或豁免）→ ship pr | S/M |
| 18 | N-ROLE-ROUTINE-RESTATE-FU1-FU1-FU2 | mapper-human-verdict | 核查员没写 verdict.json 两次；followups 判可收（验收②按爸方案 A 不适用）需人确认；PR 与 main 冲 5 文件（4 trivial + cronService.ts 需并集两 assert） | 人确认可收 → 合 main（并集 import/assert、测试都留）→ ship | M |
| 19 | N-PERM-GRANT-TIERS | risk-high | ship 撞 high 风险档（src/host/permissions/*）：要 SHIP_RISK_ACK；PR 现又与 main 冲 orchestratorPermissions.ts（ADR-088 hand-back 跳过 vs 两档铸造，同函数 real conflict） | 人出 SHIP_RISK_ACK → 保两侧语义合冲突 → ship merge 2547 | M |
| 21 | N-ROLE-PROACTIVITY-CHAT-TUNE | landing-failure | gates:fast selected 20 > 12 ×3；PR 与 main 冲 125 文件（123 快照+manifest 重录、agent.ts 双侧同升 sys-v96 需再升版） | 人定上限方案 → 合 main 升版 → 重录快照 → ship pr | M |

**总控用法**：S 六张（13/14/15/16/17/22）当天可清——13、16 是纯重跑，14、15 是一两行改动，17、22 是看图 + touch ui-ok；三张 gates:fast 卡点单（20/23/21）等同一个决策（豁免还是拆单），20/23 无冲突、决策后即发；18/19 各需一次人工确认 + 一次 5 文件/1 文件的冲突整合。全程只读，未动任何仓库、状态与台账。

DONE N-HUMAN-HOLD-PRECHECK-B 64ba8ef30

---

## 返修轮（第 2 轮 · 2026-11-06 08:51 PST）

- **返修原因**：第 1 轮 11 张的分析全部完成并写入本档（上文），但只写了台账、没有在任务分支留提交——DONE 行写的 `64ba8ef30` 是当时 worktree HEAD＝`origin/main` 本身，分支 0 提交、无未提交改动，队列按「没交活」退回。第 1 轮各票的卡点、定因、最小下一步与汇总表**原样有效**，本轮只补交付动作，不改任何结论。
- **复核（08:51，只读）**：`~/work/collect/code-agent` fetch 后 `origin/main` 仍为 `64ba8ef30`；11 张票的 `~/.ship/collect/state/<t>/` 自 08:32 起无任何文件变动；9 个 PR 逐一复核状态与头均未动——#2768 / #2792 / #2698 / #2769（head `ed43753f5`）/ #2796 均 OPEN · MERGEABLE · BEHIND，#2627 / #2547 / #2567 / #2818 均 OPEN · CONFLICTING · DIRTY；20 / 23 两张本就无 PR（走分支落地）。结论：无需改任何一节。
- **取舍记录**：任务书③「全程只读」保护的是被诊断对象（11 张票的代码、collect state、台账——均未动）；本机施工环境明示「只 commit 不 push、不合并」，且同批 `N-HUMAN-HOLD-PRECHECK-A` 即以「证据档副本落 worktree 根 + 任务分支 1 提交」交付并被收活。故本轮把本档副本提交到本单自己的任务分支 `mq/human-hold-precheck-b`：仅新增一个 md 文件，不碰任何代码与测试，不 push、不合并、不动 main。
- **交付物**：仓内副本 `N-HUMAN-HOLD-PRECHECK-B.md`（＝本档全部内容；副本末行不用 DONE 行——提交 sha 依赖提交本身——以指针行代替）；本台账最后一行＝收活 DONE 行，sha 即该提交。

收活 DONE 行：见台账 `~/work/evidence/N-HUMAN-HOLD-PRECHECK-B.md` 最后一行 = 本提交（分支 mq/human-hold-precheck-b）。
