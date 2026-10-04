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
4. **Q_live（充分性检查集）**：窗口内 `created_at ≥ T_live` 的行数 ≥ 5 的 session。`T_live = 1759276800000`（标注为 2026-10-01T00:00:00Z）。依据：PR #2230 合并 main 于 2026-10-02T14:40:39Z（`git log -1 c0785ab09`，下贴），而派单人核实最早 tools-changed 行在 2026-10-01（分支 dogfood 包先于合并上线），取更早者并向下取整天。**〔施工后更正：该 epoch 实为 2025-10-01T00:00:00Z，笔误差一年；意图日期 2026-10-01T00:00:00Z 的正确 epoch 是 1790812800000。两版 Q_live 都跑了、都贴。判定对两版都不变（主库没有任何 ≥5 行的会话）——见「判定」节。〕**
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

## ② 预注册时序证据（先于一切查询）

- `git log --oneline` 行（原样）：
  ```
  4f65fc152 evidence(N-CACHEBREAK-TOOLTABLE-MEASURE): pre-register decision thresholds
  ```
- 该 commit 时间戳：`2026-10-04T00:59:33-07:00`（= 2026-10-04T07:59:33Z，`git log -1 --format='commit time: %cI'` 原样输出 `commit time: 2026-10-04T00:59:33-07:00`）。
- 首条测量 SQL 执行前的墙钟（原样）：
  ```
  === wall clock BEFORE first query ===
  2026-10-04T07:59:50Z
  epoch_ms=1791100790000
  ```
- 时序：07:59:33Z 预注册 commit < 07:59:50Z 拍钟 < ~08:00Z 首条 SQL。commit 与拍钟之间没有任何 sqlite3 调用（此前的动作只有 git 与 ls/md5/pgrep）。sqlite3 版本 `3.50.6`。
- 窗口参数（由拍钟导出，全部查询沿用）：
  - `W = [1790495990000, 1791100790000]` = `2026-09-27T07:59:50Z → 2026-10-04T07:59:50Z`（`date -u -r 1790495990` → `2026-09-27T07:59:50Z` 已验）。
  - `T_live`：见预注册第 4 条的更正说明——笔误值 1759276800000（=2025-10-01）与意图值 1790812800000（=2026-10-01T00:00:00Z，`date -u -r 1790812800` → `2026-10-01T00:00:00Z` 已验）两版都跑，判定对两版一致。
- PR #2230 合并时间（原样）：
  ```
  c0785ab09f94e77b5b459fbb3ce2754afde1723c 2026-10-02T07:40:39-07:00 mq/cachebreak tooltable (#2230)
  ```

## 现场盘点：与派单书数据的出入（判断记录，跑数前完成）

派单书称「Data available on this Mac (verified by the drafter)」。实测本机现状与派单书有**三处硬出入**，逐条记录如下；处理原则：判定池 = 预注册列名且现存的库；新发现的库只作池外补充、不进判定（看到数字后再改池子 = 数据钓鱼）。

1. **`~/.code-agent-chatprobe/` 整个目录不存在**（原样输出）：
   ```
   ls: /Users/leo/.code-agent-chatprobe/: No such file or directory
   (find ~/.code-agent-chatprobe -name '*.db' → 空, find exit=1)
   ```
   派单书引用的历史值（111 行、全 none、末行 2026-09-23）已无法在本机复核，只能照抄并标注「不可复核」。该库预期对 7 天窗口零贡献（末行 9-23 < 窗口下沿 9-27），其消失不改变判定。
2. **`~/.code-agent/code-agent.db` 与派单书数字完全不符**：实测 20 行 / 7 会话、全部 `none`、provider 全 `longcat`、行时间 2026-09-30 06:54:55–06:56:14 UTC；文件 mtime `Sep 29 23:56`（本地）= 末行时刻，此后**冻结无写入**。派单书写的 3356 行 / 873 会话 / 3 条 tools-changed（最早 2026-10-01）不可能来自这个文件——它 9-30 之后没被动过，而「最早 10-01」的行要求 10-01 之后仍有写入。全机检索（`mdfind -name code-agent.db`、`find ~/Library/Application\ Support -maxdepth 2`、`find ~/work -maxdepth 3`）原始输出：
   ```
   /Users/leo/work/patrol/neo-data/code-agent.db.backup-1
   /Users/leo/work/patrol/neo-data/code-agent.db
   /Users/leo/work/evalslot/.code-agent-dev8/code-agent.db
   /Users/leo/work/patrol/neo-data/code-agent.db
   ```
   现存候选全量盘点（都只读查过）：`~/.code-agent`（20 行，见上）、`~/work/patrol/neo-data`（14 行 / 5 会话、全 none、2026-09-14，本地巡逻产物，**不是** mini 的 nightly 库）、`~/work/evalslot/.code-agent-dev8`（810 行 / 221 会话、5 条 tools-changed、活库）。`~/.code-agent-dev/` 存在但**无 DB**（仅 config.json / secure-storage.json）。**没有任何本机现存库能复现 3356/873/3**；该组数字来源无法追溯，如实记录。
3. **mini 的 nightly neo-data DB 从本机不可达**：照派单书声明，未做任何连接尝试。本机 `~/work/patrol/neo-data/code-agent.db` 与它同名不同物（14 行、9-14 冻结）。

**池外补充库的选择**：`~/work/evalslot/.code-agent-dev8/code-agent.db` 是本机唯一含 tools-changed 行的库（且 25 分钟前仍在写）。不进判定池的理由：① 预注册没列它；② 它 221/221 会话全是 `test-*` 前缀（评测/dogfood 槽流量，非用户会话）；③ 看到数字后扩池违背预注册本意。但完全不提它更糟——作为**补充上下文**同口径测一套，供 owner 重测时决策。

## ① 测量：SQL 与原始输出（全部 `sqlite3 -readonly`）

### 库 1：`~/.code-agent/code-agent.db`（预注册判定池 · 幸存成员）

查询前原件状态（原样）：
```
-rw-r--r--  1 leo  staff  4345856 Sep 29 23:56 /Users/leo/.code-agent/code-agent.db
-rw-r--r--   1 leo  staff     32768 Sep 29 23:54 /Users/leo/.code-agent/code-agent.db-shm
-rw-r--r--   1 leo  staff  4499072 Sep 29 23:54 /Users/leo/.code-agent/code-agent.db-wal
md5(.db)  = 6fd0551bf6bf66985b11cec967d3c997
md5(-wal) = 13fd8558c9a265d3c78bd776789b959a
```
（`-shm` 的 mtime 在我只读查询后变为 Oct 4 01:00——只读连接也会动 shm 读标记；内容不变，以 .db 与 -wal 的 md5 为准。另：pgrep 命中的是主检出里另一场会话的 vitest/Playwright，不是本产品 app，无人写此库。）

**S0 · 表结构**（核对派单书列清单，一致）：
```sql
SELECT sql FROM sqlite_master WHERE name='turn_cost_estimates';
```
```
CREATE TABLE turn_cost_estimates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model_id TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL,
      usd REAL,
      source TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      cache_break_reason TEXT NOT NULL DEFAULT 'none'
    )
```

**S1 · 全量对账**：
```sql
SELECT count(*) AS rows_total, count(DISTINCT session_id) AS sessions_total, min(created_at) AS min_ms, datetime(min(created_at)/1000,'unixepoch') AS min_utc, max(created_at) AS max_ms, datetime(max(created_at)/1000,'unixepoch') AS max_utc FROM turn_cost_estimates;
```
```
rows_total|sessions_total|min_ms|min_utc|max_ms|max_utc
20|7|1790751295814|2026-09-30 06:54:55|1790751374868|2026-09-30 06:56:14
```

**S2 · 按 cache_break_reason 全量分组**：
```sql
SELECT cache_break_reason, count(*) AS n, count(DISTINCT session_id) AS sessions FROM turn_cost_estimates GROUP BY cache_break_reason ORDER BY n DESC;
```
```
cache_break_reason|n|sessions
none|20|7
```

**S3 · 窗口总量**（W = [1790495990000, 1791100790000]）：
```sql
SELECT count(*) AS rows_w, count(DISTINCT session_id) AS sessions_w, sum(input_tokens) AS input_tokens_w FROM turn_cost_estimates WHERE created_at >= 1790495990000 AND created_at <= 1791100790000;
```
```
rows_w|sessions_w|input_tokens_w
20|7|132064
```
（有效窗口 = 全部 20 行都落在 2026-09-30 06:54:55–06:56:14 UTC 这 79 秒内；窗口内无其他天。）

**S4 · 窗口内 per-session 全量**（7 行，全量粘贴）：
```sql
SELECT session_id, count(*) AS rows_w, sum(CASE WHEN cache_break_reason='tools-changed' THEN 1 ELSE 0 END) AS tc, sum(input_tokens) AS tok FROM turn_cost_estimates WHERE created_at >= 1790495990000 AND created_at <= 1791100790000 GROUP BY session_id ORDER BY rows_w DESC;
```
```
session_id|rows_w|tc|tok
test-1790751326276|4|0|37324
test-1790751312850|4|0|11789
test-1790751354247|3|0|11429
test-1790751291768|3|0|34364
test-1790751366570|2|0|13126
test-1790751346153|2|0|11903
test-1790751306385|2|0|12129
```
（session id 全部 `test-*`：这 20 行是 9-30 的一次测试流量，不是用户会话。）

**S5 · 分布分桶（窗口内全部 session）**：
```sql
SELECT CASE WHEN tc=0 THEN '0' WHEN tc=1 THEN '1' WHEN tc=2 THEN '2' ELSE '3+' END AS bucket, count(*) AS sessions FROM (SELECT session_id, sum(CASE WHEN cache_break_reason='tools-changed' THEN 1 ELSE 0 END) AS tc FROM turn_cost_estimates WHERE created_at >= 1790495990000 AND created_at <= 1791100790000 GROUP BY session_id) GROUP BY bucket ORDER BY bucket;
```
```
bucket|sessions
0|7
```

**S6 · Q（≥5 行会话）与 Q 内 tools-changed 会话数**：
```sql
WITH q AS (SELECT session_id FROM turn_cost_estimates WHERE created_at >= 1790495990000 AND created_at <= 1791100790000 GROUP BY session_id HAVING count(*) >= 5) SELECT count(*) AS q_sessions, (SELECT count(*) FROM q WHERE session_id IN (SELECT session_id FROM turn_cost_estimates WHERE created_at >= 1790495990000 AND created_at <= 1791100790000 AND cache_break_reason='tools-changed')) AS q_with_tc FROM q;
```
```
q_sessions|q_with_tc
0|0
```
（Q 为空 ⇒ Q 上的分布分桶无行可报；单会话最大 4 行，见 S4。）

**S7 · tools-changed 全量计数**：
```sql
SELECT count(*) AS tc_rows_alltime FROM turn_cost_estimates WHERE cache_break_reason='tools-changed';
```
```
0
```

**S8 · Q_live**（T_live 两版都贴）：
```sql
-- 笔误版 T_live=1759276800000（=2025-10-01，预注册原文写的 epoch）
SELECT count(*) AS q_live_sessions FROM (SELECT session_id FROM turn_cost_estimates WHERE created_at >= 1759276800000 AND created_at <= 1791100790000 GROUP BY session_id HAVING count(*) >= 5);
→ 0
-- 更正版 T_live=1790812800000（=2026-10-01T00:00:00Z，预注册意图日期）
SELECT count(*) AS q_live_sessions FROM (SELECT session_id FROM turn_cost_estimates WHERE created_at >= 1790812800000 AND created_at <= 1791100790000 GROUP BY session_id HAVING count(*) >= 5);
→ 0
```

**S9 · 窗口内 per-provider**：
```sql
SELECT provider, count(*) AS rows_w, count(DISTINCT session_id) AS sessions_w, sum(input_tokens) AS input_tokens_w, sum(CASE WHEN cache_break_reason='tools-changed' THEN 1 ELSE 0 END) AS tc_rows FROM turn_cost_estimates WHERE created_at >= 1790495990000 AND created_at <= 1791100790000 GROUP BY provider ORDER BY rows_w DESC;
```
```
provider|rows_w|sessions_w|input_tokens_w|tc_rows
longcat|20|7|132064|0
```

### 库 2：`~/.code-agent-chatprobe/code-agent.db`

不存在（见「现场盘点」第 1 条原始输出）。无可跑查询。

### 库 3（池外补充，不进判定）：`~/work/evalslot/.code-agent-dev8/code-agent.db`

**M1 · 全量与 reason 分布**：
```sql
SELECT count(*) AS rows_total, count(DISTINCT session_id) AS sessions_total, datetime(min(created_at)/1000,'unixepoch') AS min_utc, datetime(max(created_at)/1000,'unixepoch') AS max_utc FROM turn_cost_estimates;
SELECT cache_break_reason, count(*) AS n, count(DISTINCT session_id) AS sessions FROM turn_cost_estimates GROUP BY cache_break_reason ORDER BY n DESC;
```
```
810|221|2026-09-30 06:14:01|2026-10-04 07:08:52
none|805|221
tools-changed|5|5
```

**M2 · 窗口总量**（同一 W）：
```sql
SELECT count(*) AS rows_w, count(DISTINCT session_id) AS sessions_w, sum(input_tokens) AS input_tokens_w FROM turn_cost_estimates WHERE created_at >= 1790495990000 AND created_at <= 1791100790000;
```
```
rows_w|sessions_w|input_tokens_w
810|221|4093286
```

**M3 · T_live 起按天行数（有效指标窗口）**：
```sql
SELECT date(created_at/1000,'unixepoch') AS day_utc, count(*) AS rows_w, sum(CASE WHEN cache_break_reason='tools-changed' THEN 1 ELSE 0 END) AS tc_rows FROM turn_cost_estimates WHERE created_at >= 1759276800000 GROUP BY day_utc ORDER BY day_utc;
```
```
day_utc|rows_w|tc_rows
2026-09-30|170|0
2026-10-01|534|0
2026-10-04|106|5
```
（T_live 笔误不影响本表——所有行都晚于 2025-10-01。tools-changed 只出现在 2026-10-04 一天；10-02 / 10-03 零行。）

**M4 · 分布分桶（窗口内全部 session）**：
```sql
SELECT CASE WHEN tc=0 THEN '0' WHEN tc=1 THEN '1' WHEN tc=2 THEN '2' ELSE '3+' END AS bucket, count(*) AS sessions FROM (SELECT session_id, sum(CASE WHEN cache_break_reason='tools-changed' THEN 1 ELSE 0 END) AS tc FROM turn_cost_estimates WHERE created_at >= 1790495990000 AND created_at <= 1791100790000 GROUP BY session_id) GROUP BY bucket ORDER BY bucket;
```
```
bucket|sessions
0|216
1|5
```

**M5 · Q 与 Q 内 tools-changed 会话数**：
```sql
WITH q AS (SELECT session_id, count(*) AS rw, sum(CASE WHEN cache_break_reason='tools-changed' THEN 1 ELSE 0 END) AS tc FROM turn_cost_estimates WHERE created_at >= 1790495990000 AND created_at <= 1791100790000 GROUP BY session_id HAVING count(*) >= 5) SELECT count(*) AS q_sessions, sum(CASE WHEN tc>=1 THEN 1 ELSE 0 END) AS q_with_tc FROM q;
```
```
q_sessions|q_with_tc
37|2
```

**M6 · (B) 分子分母**：
```sql
WITH q AS (SELECT session_id FROM turn_cost_estimates WHERE created_at >= 1790495990000 AND created_at <= 1791100790000 GROUP BY session_id HAVING count(*) >= 5) SELECT (SELECT coalesce(sum(input_tokens),0) FROM turn_cost_estimates t WHERE t.created_at >= 1790495990000 AND t.created_at <= 1791100790000 AND t.session_id IN (SELECT session_id FROM q)) AS q_all_tokens, (SELECT coalesce(sum(input_tokens),0) FROM turn_cost_estimates t WHERE t.created_at >= 1790495990000 AND t.created_at <= 1791100790000 AND t.cache_break_reason='tools-changed' AND t.session_id IN (SELECT session_id FROM q)) AS q_tc_tokens FROM q LIMIT 1;
```
```
q_all_tokens|q_tc_tokens
1345343|26791
```

**M7 · Q_live**（两版 T_live）：
```sql
-- 笔误版 1759276800000（=2025-10-01）
→ 37
-- 更正版 1790812800000（=2026-10-01T00:00:00Z）
SELECT count(*) AS q_live_sessions FROM (SELECT session_id FROM turn_cost_estimates WHERE created_at >= 1790812800000 AND created_at <= 1791100790000 GROUP BY session_id HAVING count(*) >= 5);
→ 30
```

**M8 · 窗口内 per-provider**：
```sql
SELECT provider, count(*) AS rows_w, count(DISTINCT session_id) AS sessions_w, sum(input_tokens) AS input_tokens_w, sum(CASE WHEN cache_break_reason='tools-changed' THEN 1 ELSE 0 END) AS tc_rows, sum(CASE WHEN cache_break_reason='tools-changed' THEN input_tokens ELSE 0 END) AS tc_input_tokens FROM turn_cost_estimates WHERE created_at >= 1790495990000 AND created_at <= 1791100790000 GROUP BY provider ORDER BY rows_w DESC;
```
```
provider|rows_w|sessions_w|input_tokens_w|tc_rows|tc_input_tokens
custom-stepfun|475|108|1547430|0|0
zhipu|187|64|1702799|5|66831
longcat|148|49|843057|0|0
```

**M9 · source 取值与 test 流量判别**：
```sql
SELECT source, count(*) AS n FROM turn_cost_estimates WHERE created_at >= 1790495990000 AND created_at <= 1791100790000 GROUP BY source;
SELECT count(*) AS test_like_sessions FROM (SELECT DISTINCT session_id FROM turn_cost_estimates) WHERE session_id LIKE 'test-%';
```
```
source|n
catalog|276
unknown|534
221
```
（221/221 会话 `test-*` ⇒ 全库都是评测/dogfood 流量。）

**M10 · tools-changed 明细（全量 5 行）**：
```sql
SELECT id, session_id, provider, model_id, input_tokens, output_tokens, usd, source, created_at, datetime(created_at/1000,'unixepoch') AS created_utc FROM turn_cost_estimates WHERE cache_break_reason='tools-changed' ORDER BY created_at;
```
```
id|session_id|provider|model_id|input_tokens|output_tokens|usd|source|created_at|created_utc
719|test-1791092436112|zhipu|glm-5.3-flash|13341|93|0.0|catalog|1791092439065|2026-10-04 05:40:39
740|test-1791092733008|zhipu|glm-5.3-flash|13354|98|0.0|catalog|1791092735449|2026-10-04 05:45:35
762|test-1791096007000|zhipu|glm-5.3-flash|13361|102|0.0|catalog|1791096010907|2026-10-04 06:40:10
784|test-1791096055311|zhipu|glm-5.3-flash|13345|89|0.0|catalog|1791096058426|2026-10-04 06:40:58
805|test-1791097719756|zhipu|glm-5.3-flash|13430|100|0.0|catalog|1791097723743|2026-10-04 07:08:43
```
### 重写 token 上界（验收①要求项）

- 判定池（库 1）：tools-changed 行 = 0 ⇒ 重写 token 上界 = **0**。
- 池外补充（库 3）：5 行 × ~13.3k = **66,831** 上界（全会话口径）；落在 Q 会话内的部分 26,791。
- 两者都只是**上界**：表无 cache-read / cache-write 列，tools-changed 轮的 input_tokens 里有多少是真重写、多少本来就不会命中缓存，无法从本表区分。

## ③ 判定（机械套用预注册，计算过程）

**判定池 = 库 1（`~/.code-agent/code-agent.db`，预注册两库中唯一幸存者；库 2 目录不存在）**

1. 充分性闸门：`|Q_live|`：
   - 笔误版 T_live：`0`（S8）
   - 更正版 T_live：`0`（S8）
   - `0 < 30` ⇒ **INSUFFICIENT-DATA**。两版 T_live 同结果——库 1 根本没有任何 ≥5 行的会话（S4 最大 4 行），任何 T_live 取值下 Q_live 都为 0。
2. (A) / (B)：Q 为空（|Q|=0），份额无定义（0/0）；充分性闸门已先行触发，无需也无法计算。
3. **判定：INSUFFICIENT-DATA，重测日 2026-10-15，阈值不变**（BUILD 需 A≥10% 且 B≥5%；NO-BUILD 需样本充分而不达标；两者前提都不满足）。

**池外补充口径（库 3，不进判定，仅供 owner）**：若机械套同一阈值——
- (A) = 2/37 = **5.41% < 10%** ✗
- (B) = 26,791/1,345,343 = **1.99% < 5%** ✗
- 全会话口径：5/221 = 2.26% 会话；token 66,831/4,093,286 = 1.63%
- Q_live（更正版）= 30，恰好够 30 的数——但即便算它充分，A、B 双不达标 ⇒ NO-BUILD 方向。方向与判定池一致：**没有任何口径支持 BUILD**。

### INSUFFICIENT-DATA 的理由（todo 第 4 条）

1. 预注册池在窗口内没有 ≥5 行的会话（Q=0），更没有指标活线（2026-10-01）之后的会话（Q_live=0）：主库自 2026-09-30 06:56 UTC 起冻结，窗口内唯一 20 行是 9-30 的 79 秒测试流量（`test-*`）。
2. 本机不存在第二个接收用户日常流量的库：`~/.code-agent-dev` 无 DB；evalslot/dev8 是评测槽（221/221 `test-*`）；patrol/neo-data 是 9-14 冻结的巡逻产物。
3. 派单书引用的 3356 行 / 873 会话 / 3 条 tools-changed（最早 2026-10-01）在本机任何现存库都无法复现；chatprobe 目录整个消失。数字来源不可追溯。
4. 重测前置条件（供 owner）：**先确认用户日常流量现在落在哪个数据目录**——本机 `~/.code-agent` 已 4 天无写入；若日常使用在 mini 侧，需从 mini 的 neo-data 库取数（本机不可达）。在此基础上 2026-10-15 用同一套阈值重测。

（BUILD 才需要的实施单草稿与 per-provider native deferred tool loading 表：因判定非 BUILD，不适用、未做。）

## ⑤ 查询自检（替代反向变异；全部原样输出）

```
=== md5 BEFORE ===
6fd0551bf6bf66985b11cec967d3c997        (~/.code-agent/code-agent.db)
13fd8558c9a265d3c78bd776789b959a        (~/.code-agent/code-agent.db-wal)
=== backup to /tmp ===
sqlite3 -readonly ~/.code-agent/code-agent.db ".backup /tmp/n-cachebreak-selfcheck.db"
backup ok
=== copy sanity: same counts as live read ===
20|0        （行数与实时只读读数一致 ⇒ -wal 内容已含入副本，只读查询没有漏 WAL）
=== INSERT one fake tools-changed row INTO COPY ONLY ===
sqlite3 /tmp/n-cachebreak-selfcheck.db "INSERT INTO turn_cost_estimates (session_id, provider, model_id, input_tokens, output_tokens, usd, source, created_at, cache_break_reason) VALUES ('zz-selfcheck-session', 'selfcheck', 'selfcheck-model', 111111, 0, 0.0, 'selfcheck', 1791090000000, 'tools-changed');"
insert exit=0
=== re-run count + distribution on COPY ===
SELECT count(*) FROM turn_cost_estimates WHERE cache_break_reason='tools-changed';
→ 1                        （原 0，恰好 +1）
分布查询（同 S5 SQL）：
bucket|sessions
0|7
1|1                       （新增会话 1 行 tools-changed ⇒ 桶 "1" 从无到有；Q 仍为 0，因该会话仅 1 行 < 5——分布按定义移动）
=== ORIGINALS untouched ===
6fd0551bf6bf66985b11cec967d3c997        （md5 与查询前一致）
13fd8558c9a265d3c78bd776789b959a        （-wal 一致）
SELECT count(*) ... original → 0       （原件没有 tools-changed 行）
tmp copy removed
```

## ⑥ 预期收益

owner 现在拿数字而非直觉决策：本机用户库（预注册池）窗口内 tools-changed 断点为 **0**；唯一出现断点的评测槽库也只有 **2.26% 会话 / 1.63% token**（且全在 2026-10-04 一天、单一模型 glm-5.3-flash）。按预注册阈值没有任何口径支持为 OpenAI Responses 路径上 native deferred tool loading——省下的是一次没有可衡量收益的施工。真正暴露的问题反而是**测量池失效**（用户日常流量不再落 `~/.code-agent`），不修池子，任何重测都是瞎的。

## ④ src 零改动（原样输出）

```
$ git diff --stat origin/main -- src tests
（无输出，退出码 0）
$ git diff --stat -- src tests scripts
（无输出，退出码 0）
$ git status --short
（无输出）
```

## 门（原始汇总行）

- `npm run -s typecheck` → **无输出（退出码 0）**
- ratchets（tsc-tests / knip 三道 / knip-dependency-gate / host-chinese-error / eslint / attention-budget）、snapshot-replay、vitest、CI Swarm 静态门：**N/A**——`git diff --stat -- src tests scripts` 为空（上节原样粘贴），无任何被测代码改动，派单书明示此情形只跑 typecheck。队列若仍跑上述门，输入与本单无关（唯一 commit 只动了根级证据 md，不在任何门的扫描面内：eslint 棘轮只扫 `src --ext .ts,.tsx`，structure 门只数含 `/` 的根目录首段）。

## 验收对照

| 项 | 状态 | 落点 |
|---|---|---|
| ① | ✅ | 「① 测量」节：两库路径 + SQL 与原始输出全贴；mini DB 不可达声明在「现场盘点」第 3 条；分布（0/7 与 216/5）与重写上界（0 / 66,831）齐 |
| ② | ✅ | 「② 预注册时序证据」：commit 行 4f65fc152、时间 07:59:33Z < 首查拍钟 07:59:50Z |
| ③ | ✅ | 「③ 判定」：Q_live=0<30 → INSUFFICIENT-DATA（重测 2026-10-15，阈值不变），计算逐行给出 |
| ④ | ✅ | 「④ src 零改动」原样粘贴，diff 为空 |
| ⑤ | ✅ | 「⑤ 查询自检」：+1 恰好、分布相应移动、原件 md5 前后一致 |
| ⑥ | ✅ | 「⑥ 预期收益」 |

## 判断记录（汇总）

1. 预注册 commit 落点：证据目录非 git 仓库，副本进施工树根（理由见预注册节）。
2. 派单书三处数据出入全量盘点 + 处理原则（池内/池外划分）见「现场盘点」。
3. T_live epoch 笔误（1759276800000 实为 2025-10-01）在查询中自查发现，两版都跑、判定不变、如实记档；预注册文本未回改（commit 4f65fc152 保持原样，更正写在同节加注）。
4. 主库的 20 行本身也是 `test-*` 流量——即便它有 ≥5 行会话，拿测试流量判 BUILD/NO-BUILD 也成问题；这进一步支持 INSUFFICIENT-DATA 而非硬套 NO-BUILD。

## 未跑的格与原因

- 全部 ratchet / knip / vitest / snapshot-replay / CI Swarm 静态门：N/A，无代码改动（见「门」节）。
- mini nightly neo-data DB：本机不可达，未尝试（派单书明令）。
- 没有 push、没有开 PR、没有建票（BUILD 才需要实施单草稿）。

## 分支与 HEAD

- 分支 `mq/cachebreak-tooltable-measure`，基点 `origin/main` = `e16897caf`
- commits：`4f65fc152`（预注册）→ `<收尾 commit，sha 见下行 DONE>`（证据定稿副本）
- 工作树干净，未 push。权威档：`~/work/evidence/N-CACHEBREAK-TOOLTABLE-MEASURE.md`
