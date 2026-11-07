# N-COMPETITOR-FLASH-PILOT-FU1 — Flash blind collection vs 11-02 report

窗口：2026-10-26..2026-11-02 UTC。输入为 `N-COMPETITOR-FLASH-PILOT.md` 的 511 个数据行，以及私档 11-02 周报和 Memoh/dots 源材料。完整逐行原文、判断记录和记账脚本输出只在 `~/work/evidence/N-COMPETITOR-FLASH-PILOT-FU1.md` 与 `~/work/out/N-COMPETITOR-FLASH-PILOT-FU1/`；本快照不复制私档正文。

## ① Item-by-item reconciliation

R 的原子规则：一条 release bullet，或周报/深挖提升为独立可验行为的一条 claim。重复描述去重；实现子步骤、营销静态事实、用户愿望、Neo 建议不重复计数。周报明确用作能力差异的静态项仍收入。

| 产品 | HIT | FLASH-MISSED | DATE-OR-CALIBER-MISMATCH | \|R\| |
|---|---:|---:|---:|---:|
| Memoh | 60 | 6 | 0 | 66 |
| dots | 10 | 23 | 17 | 50 |
| Claude Code | 18 | 0 | 1 | 19 |
| 合计 | 88 | 29 | 18 | 135 |

恒等式：`88 + 29 + 18 = 135`。完整 R 表在外部证据档 §①：每项均有标签、`file:line`、R verbatim、Flash row verbatim 和边界判断。

Flash 511 行独立分区：

| 产品 | HIT 行 | DATE/CALIBER 行 | EXTRA:OUT-OF-REPORT-SCOPE | EXTRA:WRONG | EXTRA:NOISE | 总数 |
|---|---:|---:|---:|---:|---:|---:|
| Memoh | 59 | 0 | 5 | 0 | 0 | 64 |
| dots | 13 | 3 | 39 | 0 | 0 | 55 |
| Claude Code | 19 | 0 | 373 | 0 | 0 | 392 |
| 合计 | 91 | 3 | 417 | 0 | 0 | 511 |

恒等式：`91 + 3 + 417 + 0 + 0 = 511`。R HIT 数与 Flash HIT 行数不同，是正常 many-to-one：例如一条 Terra claim 对应多个平台/目录行，空闲压缩对应两个 release 行。

R 指针摘要（私档片段均不超过 15 words）：

- Memoh release：`2026-11-02-Memoh-源材料/01-releases-v1.0.0-beta.1-v1.0.1.md:15-82`（release bullets）。
- Memoh 续跑：`02-commit-1721-停机续跑.md:26`（请求锚点）。
- Memoh 审批：`03-commit-1707-审批跨重启.md:19,36,54`（fencing、终态、接管）。
- Memoh routine：`07-routine-定时任务.md:54`（默认静默）。
- Memoh 压缩：`08-记忆与压缩.md:36`（预算与保留顺序）。
- dots 周报：`2026-11-02-周动向-增量扫描.md:129-146`（dots）。
- Work/Codex：`2026-11-02-周动向-增量扫描.md:155-167,181-189`（平台项）。
- Claude Code：`2026-11-02-周动向-增量扫描.md:171-179`（四版 highlights）。

Borderline decisions：

1. `R-D039 ↔ F-D015`：同属 command center，但 Flash 仅覆盖过滤/分组；仍记 HIT，细节不完整。
2. `R-C018 ↔ F-C301`：周报泛化为 Slack 消息编辑；primary 实为自有 canvas 续编。按 primary 的 artifact-edit 簇记 HIT。
3. `R-D014`：周报的 4000+ apps 在私档一手源中未找到；忠实列 R，但不要求 Flash 补写。
4. `F-M017`：内部 typecheck 硬门；private release snapshot 自列，故 HIT 并保留 internal-quality 说明。
5. `F-M064`：11-02 合入但未随版，真实且 digest 未列；记 OUT-OF-REPORT-SCOPE。

## ② Metrics, raw and caliber-adjusted

公式：`recall = R 中 HIT / |R|`；`error rate = (WRONG + DATE-OR-CALIBER-MISMATCH Flash 行) / Flash 行`。

| 产品 | Recall 含口径 | Recall 剔除口径 | Error 含口径 | Error 剔除口径 |
|---|---|---|---|---|
| Memoh | 60/66 = 90.91% | 49/55 = 89.09% | 0/64 = 0.00% | 0/53 = 0.00% |
| dots | 10/50 = 20.00% | 10/33 = 30.30% | 3/55 = 5.45% | 0/51 = 0.00% |
| Claude Code | 18/19 = 94.74% | 18/18 = 100.00% | 0/392 = 0.00% | 0/305 = 0.00% |

FLASH-EXTRA split：

| 产品 | 含口径 scope / WRONG / NOISE | 剔除口径 scope / WRONG / NOISE |
|---|---|---|
| Memoh | 5 / 0 / 0 | 5 / 0 / 0 |
| dots | 39 / 0 / 0 | 38 / 0 / 0 |
| Claude Code | 373 / 0 / 0 | 286 / 0 / 0 |

口径差异逐项：

1. Claude Code v2.1.317：npm `11-02T23:57:53Z`，GitHub release `11-03T01:25:46Z`；周报 `:172` 未列 317。87 行真实，不是 WRONG；392→305。
2. Memoh release day vs merge day：11 个行以 release 日记账，merge 日另存；都为 HIT。剥离后 R 66→55、Flash 64→53。
3. Memoh v1.0.0 tag-only：无 release body，不制造功能行；对指标无数值影响。
4. dots `F-D052..F-D055`：前三行有 counterpart 但日期冲突，第四行为 11-18 生效 scope extra；55→51，error 3/55→0/51。
5. dots 周报基线含 10-09..10-23 的 13 个早期 R 项；不算固定 Flash 窗口漏采，无口径 recall 剔除。
6. Claude Code v2.1.315 npm-only：无 GitHub/CHANGELOG body，不制造功能行。

## ③ Verdict and collection-caliber constraints

**有条件可以。** Flash 可立即承担结构化 release/CHANGELOG lane：Claude Code 的 18 个 feature highlights 全命中，Memoh private release snapshot 的 59 个对应 Flash 行全命中，511 行复核后 WRONG=0。417 个 extra 是 digest 选择不列的真实变化，不应计错。

当前 brief 还不能让 Flash 单独承担完整 collection stage：dots 在剥离窗口/日期冲突后 recall 仅 10/33=30.30%，产品子页、官方采访、静态 capability 差异和 commit/main lane 覆盖不足。补齐下列约束后，Flash 可做 collection，Claude 只做语义去重、相关性和借鉴判断。

1. Date 固定主时钟并保留 secondary clocks：release、npm、merge、tag、effective date 分栏。证据 `R-C019`、`F-D052..055`、11 个 Memoh clock rows。
2. Release object 明确状态：`released-with-notes/npm-only/tag-only/merged-unreleased/scheduled-effective`；无 body 不编功能。证据 v1.0.0、v2.1.315、`F-M064`、`F-D055`。
3. Source map 先行：release/CHANGELOG、相关 docs 子页、官方采访/公告、main/commit lane 全列。证据 `R-D004..019`。
4. User-visible 可操作化：改变行为、配置、错误恢复或安全边界才列；build/test/chore 排除；公开 changelog 的内部质量项标 `internal-quality`。证据 `F-M017`。
5. Unknown date 不猜：记录 URL、首次观察日、指标 eligibility。证据 `F-D052..054`。
6. 一行一个可验行为，并保留平台、版本、开关、计划/已上线范围词。证据 `R-D039`、`R-C018`。
7. Digest omission 不等于 collector error；extra 必须拆 scope/WRONG/NOISE，primary 反证才记 WRONG。证据 417/0/0。
8. Reference report 同样由 primary tie-break；未证实的 4000+ apps 不反向污染 collection brief。证据 `R-D014`。

## ④ Primary re-verification sample

WRONG=0。从可由 pilot 本地 primary HTML 复核的 MISSED 池，用 seed `20261107` 随机抽 5 项；来源均为 `~/work/out/N-COMPETITOR-FLASH-PILOT/verify-r2/learn-dots-fresh.html`，无网络：

| R-ID | Primary re-open 结果 | 裁决 |
|---|---|---|
| R-D015 | 明写电脑在线且 ChatGPT app 开启 | 维持 FLASH-MISSED |
| R-D017 | 明写换渠道不重置 memory | 维持 FLASH-MISSED |
| R-D013 | 明写 dot 自有 cloud computer/browser | 维持 FLASH-MISSED |
| R-D018 | 明写 proceed/approval/hand-off 三态 | 维持 FLASH-MISSED |
| R-D004 | 明写主动研究 connected information，且 read-only | 维持 FLASH-MISSED |

五项全部通过；无需重做 dots 标签。完整 primary verbatim 在外部证据档 §④。

## ⑤ Snapshot and checks

- 仓内只新增本文件；未改源码、测试、pilot evidence 或其他文件。
- 完整周报 verbatim 不在仓内；这里只保留 `file:line` 与短片段。
- `python3 -I ~/work/out/N-COMPETITOR-FLASH-PILOT-FU1/analyze.py`：`flash_total=511, reference_total=135`。
- `git status --short`（commit 前）：`?? N-COMPETITOR-FLASH-PILOT-FU1.md`，仅一个新根文件。
- `git diff --check`：无输出，exit 0。
- `wc -l N-COMPETITOR-FLASH-PILOT-FU1.md`：116（`<1000`）。
- 按 brief 未跑 eslint/typecheck/vitest/gates；本单不触源码。

## ⑥ Expected gain

Owner 从这一份快照即可判断：release lane 现在交 Flash；完整 collection lane 在 source-map/date/object/user-visible 四类约束进入 brief 后交 Flash；Claude 只保留判断。数字同时揭示 digest omission、真正漏采和时钟分歧，避免把 417 个真实 extra 当错误。
