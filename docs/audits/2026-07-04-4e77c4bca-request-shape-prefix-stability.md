# Adversarial Audit Report — request-shape prefix stability + L0 active tool-result prune

**Date**: 2026-07-04
**Scope**: 64ceadf2f..HEAD（feat/request-shape-prefix-stability，P1 cache 经济学下半场批）
**Rounds run**: 3 / 4
**Converged**: ✅ yes（Round 3 "converged — no findings"，消毒器经 4 个绕过向量实测）
**审计配置**: ⚠️ Codex CLI 配额耗尽（ChatGPT 账号 usage limit 至 2026-08-02，gpt-5.4 fallback 不支持 ChatGPT 账号）→ 按既定备选栈改用 **Gemini（antigravity CLI）+ Claude skeptic 独立子 agent** 双路对抗，Round 2/3 由 skeptic 承担聚焦复审。非 /codex-audit 原教旨，但保留了"独立 context 反方律师 + 多轮收敛 + symmetric application 检查"全部要素。

## Summary

| Round | 审计方 | HIGH | MED | LOW | Fix commit |
|-------|--------|------|-----|-----|------------|
| 1 | Gemini + skeptic（并行双路） | 5（去重后 3 真 + 1 部分存量 + 1 误报） | 4（1 存量 deferred） | 5 | 1f694a8a1 + 4306d1c08 |
| 2 | skeptic（聚焦：回归/对称） | 1 | 1 | 2 | 4e77c4bca + 3c17dc516 |
| 3 | skeptic（收敛判定） | 0 | 0 | 0 | — |

## Findings by Round

### Round 1（双路合并 triage）

#### 🔴 A1 — `<system-reminder>` 边界可伪造（双路同时命中）
**Finding**: transient 尾巴内容（git commit message / 子代理输出等攻击面）未消毒直接内插包装，`</system-reminder>` 可提前闭合边界伪造顶级指令。
**Resolution**: ✅ 统一 `wrapTransientSystemReminder` helper（providers/shared.ts），包装前中和哨兵；五处转换路径共用。Round 2 发现单遍 replace 可被拆分哨兵绕过（见 R2-1），已固定点化。

#### 🔴 A2 — forceFinalResponsePrompt 在 legacy claude 路径被静默丢弃 / aiSdk 路径打前缀（Gemini）
**Resolution**: ✅ 改 `transient: true` 走统一尾巴转换。部分存量问题（legacy claude 丢弃行为改造前即存在），本批顺手修复。

#### 🔴 A3 — legacy gemini：尾巴展开成 user+假 model 回复收尾 → 400（Gemini）
**Resolution**: ✅ convertToGeminiMessages 补 transient 分支（单条 user + reminder，无假 model）。

#### 🔴 Gemini H2 — 默认路径连续 user 400
**Resolution**: ℹ️ **false positive** — skeptic 实证 @ai-sdk/anthropic 的 groupIntoBlocks 会合并连续 user；legacy 路径由 A4 修复覆盖。

#### 🔴 Gemini H4 / 🟡 skeptic M2 — L0 把模型未看过的当前步大结果直接换 placeholder
**Resolution**: ✅ 当前步豁免（最后一条 assistant 之后的 tool results 本轮走 L1 head+tail，下一步才被 L0 收编）。H4 的"placeholder 路径触发 Read 守卫"部分为误报（L1 spill notice 同路径已是生产行为）。

#### 🟡 A7/M1 — L0 每次 evaluate 同步重写同一批大归档文件（双路命中）
**Resolution**: ✅ archiveRef 复用（state.budgetedResults），只在首次落盘；mtime 黑盒测试锁定。

#### 🟡 A8/M3 — trimPreamble 只看稳定前缀，尾巴必需块可超预算而 preamble 永不裁
**Resolution**: ✅ trimPreambleBeforeRequiredArtifactBlock 加 extraTokens 合并口径。

#### 🟡 Gemini M7 — buildModelMessages 的 appendedBlocks 空 map 使跨缓存 trim candidates 不可达
**Resolution**: ⏸ deferred — 逐行核对为**存量行为**（origin/main 同样如此），非本批引入；单独立项再议。

#### 🟡 skeptic M5 — "字节稳定"是条件成立（契约块留 system 随意图开合）
**Resolution**: ✅ ADR-032 增设「边界」披露段；设计取舍不改码。

#### 🟢 LOW（5）
- preview 代理对切分 → ✅ 码点安全 slice（随 M 修捆绑）
- plugin 块 / deferred summary MCP 段跨进程顺序漂移 → ✅ 字节序排序
- environmentBlockCache/gitContextCache 无上限 → 📝 记录（桌面 app 工作目录数有界）
- modelMessageSourceIds 死代码 → 📝 存量，记录
- APPEND_SYSTEM 位次/丢弃优先级变化 → 📝 有意（GAP-023 能力优先），报告披露

### Round 2

#### 🔴 R2-1 — 消毒器可被拆分/嵌套哨兵绕过（`</system-reminder<system-reminder>>` 重新拼合出活边界，node 实证）
**Resolution**: ✅ 固定点化（do/while 至零匹配；每遍严格缩短必收敛）。Round 3 用 4 个向量（原始绕过/双层嵌套/大小写混合/重构开标签）实测全部失败。

#### 🟡 R2-2 — A4 的连续 user 合并没对称应用到 gemini 转换器
**Resolution**: ✅ pushUserPart 构造性保证严格交替（transient/tool/真 user 全走合并）。典型 symmetric application 类 finding。

#### 🟢 R2-3 — 豁免结果被 L1 先归档时 ledger 归因记为 tool-result-budget
**Resolution**: 📝 cosmetic，记录不修。

#### 🟢 R2-4 — archiveRef 复用盲信文件存在（周清理 cron 可致 Read 归档失败）
**Resolution**: ✅ existsSync 校验 + 回落重 spill（同 hash 同路径，placeholder 字节不变）。

### Round 3
**converged — no findings**。R2-1/R2-2 修复经独立验证 sound；对称面扫描（五处 transient→text 转换、两个严格交替 provider 的合并）全覆盖。

## Deferred Items
- appendedBlocks 跨缓存边界 trim 不可达（存量，Gemini M7）
- ledger 归因 cosmetic（R2-3）
- environmentBlockCache 无 LRU（有界，低风险）

## Convergence Analysis

三轮单调收敛（HIGH+MED：8 → 2 → 0）。两类模式印证既往经验：①**symmetric application 依旧是 Round 2 的第一大类**（A4 修了 claude 没修 gemini）；②**安全修复本身必须再审**——R2-1 证明"修了"和"修对了"是两回事，单遍 sanitize 是经典可绕过形态，以后所有 sentinel 消毒一律固定点化并测拆分向量。双路 Round 1（Gemini+skeptic 并行）在去重后的互补率不错：Gemini 独家 3 条（forceFinal/gemini legacy/重复落盘之一路）、skeptic 独家 3 条（M3 trim 口径/M5 过度承诺/若干 verified-clean 反向排除），两路同时命中 2 条核心（reminder 注入、L0 当前步）。skeptic 的"verified clean"清单（tail 不落库/token 记账正确/advisory 注入条件逐字节对照 origin/main）对报告可信度贡献显著。

## 附：改后实测与残留归因（dogfood 三连跑）

- **验收数字：会话级 cache 命中率 55.84% → 78.13%（+22.3pp）**，DeepSeek 真会话、同 prompt 5 轮、PR#302 记账口径（cacheRead/(input+cacheRead)）。开轮 call 从稳定 33-40% 提升到 98-99%（turn1/3/5），轮内续跑保持 93-99%。
- 残留 miss 归因（带 DEBUG 日志的第三次跑）：
  1. turn4 开轮 = **存量 bug 误伤**：deferredToolPreload.ts 的 COMPUTER_INTENT_RE 含 `\bnotes\b`，对文件名 "notes.md" 误命中 → Computer 工具预载 → 工具表 17→18 → 合法前缀失配。**不在本批 diff 内，单独立 bug**（任何带 "notes" 的文件名都会触发）。
  2. active-prune 本场零触发（token 量低于全部压缩阈值）——L0 flip 不是残留 miss 的原因。
  3. 反复出现的 cacheRead=8448 地板值（baseline 6/11 次同样存在）：toolCallId normalizer 经核查前缀稳定、无字节级嫌疑；最合理解释为 **DeepSeek 缓存写入异步**（快速连发命中不到刚写入的长前缀）。生产侧可用已落库的 requestShapeHash（WP2-2b）遥测区分"字节变了"vs"provider 时序"。
  4. 数据可信度：turn1 开轮数字受 provider 缓存预热时序污染（两跑 99.4% vs 22.5%），turn2-5 逐位可复现，引用时以 turn2-5 为准。
