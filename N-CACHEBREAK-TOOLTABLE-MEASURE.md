# N-CACHEBREAK-TOOLTABLE-MEASURE 证据档（2026-10-04 · neo-worker · GLM 席）

单子性质：**只读测量 + 决策**。不改 `src/` `tests/` 任何文件；产出 = 真实会话数据上的 tools-changed 缓存断点度量 + 按预注册阈值给出的 build / no-build 判定。

背景（派单书给定，前单 N-CACHEBREAK-TOOLTABLE / PR #2230 已并）：`CacheBreakReason` 含 `'tools-changed'`（`src/shared/contract/turnCost.ts`），落库在 SQLite 表 `turn_cost_estimates`（列：id, session_id, provider, model_id, input_tokens, output_tokens, usd, source, created_at, cache_break_reason）。该表**没有** cache-read / cache-write 列，所以「重写 token」只能用 tools-changed 轮的 `input_tokens` 做**上界**，证据里按上界表述。

## 验收项原文照抄（①–⑥）

① Read-only query of real session data for the last 7 days: per-session tools-changed count distribution and total rewritten-token bound, with the SQL and raw output pasted (both DB paths, plus the statement that the mini DB was unreachable).

② Thresholds were written and committed before any query ran (paste `git log --oneline` line for that commit, and its timestamp earlier than the first query output).

③ Verdict build / no-build (or insufficient-data) follows mechanically from the pre-registered thresholds, computation shown.

④ `git diff --stat origin/main -- src tests` is empty (paste raw output); no `src/` change.

⑤ Query self-check (replaces reverse mutation, since no code changes): copy the DB to /tmp, `INSERT` one fake `tools-changed` row for a new session id into the COPY only, re-run the count query and show the count rose by exactly 1 and the session distribution shifted accordingly; the original DB's md5 before and after is identical.

⑥ Expected gain: the owner decides how deep to fix tool-table cache breaks from measured numbers instead of intuition.

## 预注册（先于任何 DB 查询写定并提交）

### 阈值（派单默认，原样保留，未改）

> BUILD if (share of sessions having >=1 tools-changed turn, among sessions with >=5 turns in the window) >= 10% AND (sum of input_tokens on tools-changed turns) >= 5% of all input_tokens in those sessions; otherwise NO-BUILD. If the sample is too thin to judge (fewer than 30 qualifying sessions with the metric live), the verdict is INSUFFICIENT-DATA with a concrete re-measure date and the same thresholds.

### 操作化定义（跑查询前钉死；均为本人判断，逐条记录）

1. **"turn" 的操作化**：`turn_cost_estimates` 一行 = 一次模型调用，作为 "turn" 的代理。"sessions with >=5 turns in the window" ⇔ 该 session 在窗口内行数 ≥ 5。
2. **窗口**：`W = [T_query − 7×86400000, T_query]`，`T_query` = 首次执行测量查询那一刻的墙钟（ms），查询前打印并粘贴。同时报告「指标实际覆盖的有效窗口」（tools-changed 行的 min/max created_at、按天行数）。
3. **Q（判定分母集）**：单库内窗口行数 ≥ 5 的 session 全集；两台本地库（`~/.code-agent/code-agent.db`、`~/.code-agent-chatprobe/code-agent.db`）各自查询、各自粘贴原始输出，**判定用两库合并数**（session id 按库命名空间区分；chatprobe 库末行 2026-09-23，预期对窗口零贡献，仍照查照贴）。
4. **Q_live（充分性检查集）**：窗口内 `created_at ≥ T_live` 的行数 ≥ 5 的 session。`T_live = 1759276800000`（2026-10-01T00:00:00Z）。依据：PR #2230 合并 main 于 2026-10-02T14:40:39Z（`git log -1 c0785ab09`，下贴），而派单人核实最早 tools-changed 行在 2026-10-01（分支 dogfood 包先于合并上线），取更早者并向下取整天。
5. **判定 (A)**：`|{s ∈ Q : s 在窗口内 ≥1 行 tools-changed}| / |Q| ≥ 10%`。
6. **判定 (B)**：`Σ input_tokens(窗口内 tools-changed 行, session ∈ Q) / Σ input_tokens(窗口内全部行, session ∈ Q) ≥ 5%`。
7. **判定顺序**：先充分性——`|Q_live| < 30` → **INSUFFICIENT-DATA**，重测日 **2026-10-15**（给指标整整两周蓄样），阈值不变；否则 (A) 且 (B) → **BUILD**，任一不满足 → **NO-BUILD**。
8. **分布**：per-session tools-changed 计数分桶 0 / 1 / 2 / 3+，对「窗口内全部 session」与「Q」各报一份。
9. **重写 token 上界**：`Σ input_tokens(tools-changed 行)`，只作上界表述（表无 cache-read/write 列）。
10. **per-provider**：按 `provider` 列分组的行数 / tools-changed 行数 / token 数，仅描述性，不设阈值。
11. **只读纪律**：一律 `sqlite3 -readonly <db>`；原件 md5 与 `*.db-wal/-shm` 存在性查询前后各记一次；自检 INSERT 只落 `/tmp` 副本。mini 的 nightly neo-data 库从本机不可达——**照实声明，不尝试连**。
12. **BIAS 方向自记**：T_live 向下取整到 2026-10-01 会使 Q_live 偏大（更不容易触发 INSUFFICIENT-DATA）、同时 Q 含预指标 session 会压低 (A)——两者方向相反，均为保守侧，不改阈值。

### 承诺

本节写入并 commit 之后，才执行第一条测量 SQL。预注册 commit 的时间戳与首次查询前的墙钟时间一并粘贴（验收②）。

### 判断记录：预注册 commit 落点

`~/work/evidence/` 不是 git 仓库（`git -C ~/work/evidence rev-parse` 报 fatal），本机唯一可用仓库是施工树。故：权威证据档仍在 `~/work/evidence/N-CACHEBREAK-TOOLTABLE-MEASURE.md`（队列收活路径），同时把该文件的逐字节副本提交到施工树根 `N-CACHEBREAK-TOOLTABLE-MEASURE.md` 作为预注册凭据（根级文件不新增 tracked root directory，`scripts/ci/check-repository-structure.mjs:198-200` 只数含 `/` 的路径首段；eslint 棘轮只扫 `src --ext .ts,.tsx`（`scripts/eslint-ratchet.mjs:45`），md 不受影响）。收尾时把副本同步到最终版再 commit 一次。

---

（以下各节查询后追加）
