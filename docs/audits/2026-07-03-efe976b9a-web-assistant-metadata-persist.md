# Codex Audit Report — web-assistant-metadata-persist

**Date**: 2026-07-03
**Scope**: HEAD~1..HEAD（efe976b9a — web assistant metadata 落库全链路补齐）
**Starting commit**: efe976b9a
**Rounds run**: 2 / 4（任务拍板：持久化中风险面，2 轮即可）
**Converged**: ➖ R2 剩 1 MED 已当轮 TDD 修复（走同一个已审计 helper），未跑 R3 确认轮

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     | 1    | 3   | 1   | 8b8729da1（修 2 MED） |
| 2     | 0    | 1   | 0   | 172dd85 前缀（迁移吞错对称应用） |

## Findings by Round

### Round 1

#### 🔴 HIGH — `.some()` 抑制兜底：多迭代 run 早轮已持久化 + 终轮持久化失败时，终轮内容+metadata 丢失
**Finding**: `agent.ts:256/842` hasPersistedLoopAssistantMessage 用 `.some()` 匹配任一 emitted assistant id；早轮消息已落库而终轮落库失败时，兜底被跳过。
**Resolution**: ❌ deferred — 升级拍板
**Why**: 存量逻辑（早于本 commit）。触发需双重失败（loop 主 persist + addAndPersistMessage 的 SM 二级兜底都失败）且早轮成功。修法把丢失风险换成重复风险：兜底写的是合并全文，早轮已持久化时兜底触发会重复内容。属设计取舍，建议单独立项（可选方向：collector 记录「终轮 id 是否持久化」精确判定 + 兜底只补缺失尾段）。R2 中 Codex 认可该 deferral。

#### 🟡 MEDIUM — ALTER TABLE 迁移吞掉所有错误，非 duplicate 失败后 INSERT 硬崩
**Resolution**: ✅ fixed in 8b8729da1 — `addColumnIfMissing()` 只吞 `/duplicate column name/i`，其余上抛；messages 5 列 + sessions pr_link 全走该 helper。Tests: tests/unit/cli/cliDatabaseSchema.test.ts。

#### 🟡 MEDIUM — metadata 读回裸 JSON.parse，单行损坏崩整个会话读回
**Resolution**: ✅ fixed in 8b8729da1 — `parseMessageMetadata()` 安全解析（非法 JSON/非对象回 undefined），三个 message row mapper 对称应用。Tests: cliDatabaseMetadata.test.ts 损坏行用例。

#### 🟡 MEDIUM — 持久化完整 metadata（含 memory preview/evidence）而非仅徽标数据
**Resolution**: ℹ️ by-design
**Why**: preview/evidence 有硬 cap（MAX_PREVIEW_CHARS / MAX_EVIDENCE_ITEMS=3 / MAX_SCORE_REASONS）；Electron IPC 路径（orchestrator persistMessage → SessionRepository）本来就把同样的完整 metadata 落主库，web 侧裁剪反而制造跨路径不对称、破坏开发者模式评分卡 reload 后的数据齐平。存储为本机 sqlite。

### Round 2

#### 🟡 MEDIUM — R1-MED1 修复未对称应用到兄弟迁移块
**Finding**: `migrateCliSessionsTable()` 4 列迁移 + `compaction_snapshots` 2 列迁移仍吞所有错误。
**Resolution**: ✅ fixed — 两处全改走 `addColumnIfMissing()`；新增 migrateCliSessionsTable 上抛/幂等两用例。经典 symmetric application 类 finding（批③教训再次验证）。

## Deferred Items（本轮不修）
- HIGH1（`.some()` 兜底抑制）：存量 + 丢失/重复设计取舍，待产品负责人拍板单独立项。

## LOW Findings（仅记录，无 commit）
- `src/cli/commands/export.ts:88` / `src/host/session/transcriptExporter.ts:370`：CLI 导出链仍丢 message metadata（独立文件，导出属只读展示面，必要时随导出功能迭代补）。

## Convergence Analysis

R1 的 2 个可修 MED 全在 CLI DB 层（迁移安全 + 解析安全），R2 唯一 finding 是 R1 修复的对称应用缺口（sessions/compaction 兄弟迁移块）——与批③「同修复的 siblings 必查」教训完全同型：**给某类 DDL/解析加防护时，先 grep 全文件同型 try/catch，一次修完**。R2 修复只是把兄弟块路由到已被 R1 测试覆盖的同一 helper，机械且低风险，故按任务拍板停在 2 轮。Codex 在 R2 显式认可 HIGH1 deferral 安全性，并自行跑通了 focused tests + typecheck + git hygiene。
