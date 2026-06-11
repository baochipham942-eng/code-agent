# Codex Audit Report — mimocode-phase1-quick-wins

**Date**: 2026-06-11
**Scope**: HEAD~11..HEAD（MiMoCode 借鉴路线图阶段一全部 10 项 + roadmap 备注，11 commits）
**Starting commit**: c3b35bec8
**Rounds run**: 4 / 4
**Converged**: ❌ no（跑满上限；R4 仍出 1 MED，但严重度与数量持续单调下降：7 → 2 → 1 → 1）

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     | 1    | 6   | 2   | 8c7f8a892  |
| 2     | 1    | 1   | 2   | 764fe639e  |
| 3     | 0    | 1   | 0   | 82fec3c22  |
| 4     | 0    | 1   | 0   | 3c7776ad2  |

合计：2 HIGH + 9 MED + 4 LOW，0 false positive（Codex 四轮全部命中真实问题）。

## Findings by Round

### Round 1（8 维度发散）

#### 🔴 HIGH — BlockAnchorReplacer 单候选阈值 0.0 误匹配嵌套错误块
**Finding**: 单候选场景锚点命中即接受（阈值 0.0），首行锚点 + 最近的 `}` 形成的错误嵌套块会被当成匹配，multiEdit 替换后腐蚀源码。
**Resolution**: ✅ fixed in 8c7f8a892 — 单候选阈值收紧到 0.3（与 roadmap 1.1 设计值一致；MiMo 上游原值 0.0 是带病移植）。

#### 🟡 MEDIUM — goal IMPOSSIBLE 止损后无解释 + terminal 状态错误
**Finding**: IMPOSSIBLE 分支注入 system 消息后直接 break，没有后续推理产出解释；run 收尾只映射 met，aborted 的 goal 显示为 completed。
**Resolution**: ✅ fixed in 8c7f8a892 — 改走 forceFinalResponse 通道（禁工具 + 强制解释三要素）返回 continue；conversationRuntime 收尾把 goal aborted 映射为 terminal aborted。

#### 🟡 MEDIUM — taskGate 漏掉 TaskManager facade
**Finding**: 只记录 task_create/task_update 工具名，`TaskManager({action:"create"})` 创建的任务不触发收口检查。
**Resolution**: ✅ fixed in 8c7f8a892 — 新增 isTaskMutationToolCall 纯函数，覆盖 facade 的 create/update action；只读 action 仍刻意排除（防旧任务劫持）。

#### 🟡 MEDIUM — doom loop L2 行动签名对顺序敏感
**Finding**: 并行调用换序（[Read a, Read b] vs [Read b, Read a]）绕过 repeated-step 检测；同批次 4 个相同调用只 nudge 不阻断。
**Resolution**: ✅ 换序问题 fixed in 8c7f8a892（签名改 multiset 排序）。同批次执行后再升级 abort 属设计内行为（中途阻断需要 tool_use/tool_result 协议级手术），记录为接受项。

#### 🟡 MEDIUM — fuzzy replace_all 的 split/join 缩进腐蚀
**Finding**: 模糊候选可能是其它缩进行的子串（'  a();' 是 '    a();' 的子串），split/join 全量替换产生缩进腐蚀。
**Resolution**: ✅ fixed in 8c7f8a892 — fuzzy 回退整体禁用于 replace_all（NOT_FOUND），仅单点替换允许（歧义由 occurrences 检查兜住）。

#### 🟡 MEDIUM — retry sleep 不可中断
**Finding**: retry-after 60s 等待期间 abort 无效，取消后还会继续等满并重试。
**Resolution**: ✅ fixed in 8c7f8a892 — abortableSleep + 醒后 signal 检查抛原错误。

#### 🟡 MEDIUM — retry-after 只认数字秒
**Finding**: HTTP-date 形式与 fetch Headers.get() 风格对象被忽略。
**Resolution**: ✅ fixed in 8c7f8a892 — 双格式支持，60s 上限不变。

#### 🟢 LOW — taskGate 通知分母显示 (3/2)
**Resolution**: ✅ 同 commit 顺手修（nudgeManager 本轮已开）。

#### 🟢 LOW — truncateMiddle maxLength < 60 时预算为负
**Resolution**: ℹ️ recorded only — 现有调用方均传大预算，信息性记录。

### Round 2（回归/完整性/对称应用聚焦）

#### 🔴 HIGH — BlockAnchorReplacer 仍有截断块腐蚀路径
**Finding**: tail anchor 收集止于每个 start anchor 后的**首个**命中；嵌套结构里首个 `}` 是内层闭合，截断候选凭前段中间行全等胜出，multiEdit 拼接后留下原块残尾。R1 的阈值修复挡不住这个形态（截断候选得分可达 1.0）。
**Resolution**: ✅ fixed in 764fe639e — 收集全部锚点对 + scoreBlockCandidate 按完整 search 中间行数归一（缺失行计 0 分）。Codex caught a real issue I missed twice。

#### 🟡 MEDIUM — forced-final 空输出泄漏 forceFinalResponseReason
**Finding**: forced-final 推理返回空文本时绕过 handleTextResponse 的清理，flag 泄漏到下一次用户输入导致工具持续被禁用。
**Resolution**: ✅ fixed in 764fe639e — run() finally 无条件清理（任何退出路径）。

#### 🟢 LOW — goal_complete impossible 事件 turns:0/tokensUsed:0
**Resolution**: ❌ deferred — 需要把 run 计数器穿进 gate 签名，UI 暂显 0；已记录。

#### 🟢 LOW — aiSdkAdapter/modelRouter 的同类非可中断 sleep
**Resolution**: ❌ deferred — 同对称类，延迟短（1-2.5s），已记录待统一抽共享 helper。

### Round 3

#### 🟡 MEDIUM — 64 候选上限的前缀偏置保留腐蚀路径
**Finding**: 按出现序硬截断 64 个候选对，巨型块（64+ 内层 `}` 在前）的真实外层闭合永远不被打分，截断候选以高分胜出。
**Resolution**: ✅ fixed in 82fec3c22 — 每个 start anchor 按块长接近 search 块长选前 8 个 tail（真实外层块长与 search 几乎一致，与排位无关）；start anchor > 64 时 fail-closed。

### Round 4（最终轮）

#### 🟡 MEDIUM — 去尾空行晚于行数门，两行 + 尾换行 old_text 吞中间行
**Finding**: `'a\nb\n'` split 后长度 3 骗过 `< 3` 检查，去尾后只剩两行纯锚点，`scoreBlockCandidate` 对零中间行返回 1.0，`'a\nx\nb'` 被当成全匹配吞掉中间行。MiMo 上游原序，移植时未察觉。
**Resolution**: ✅ fixed in 3c7776ad2 — 去尾空行提前到行数门之前；scoreBlockCandidate 零中间行改 fail-closed。
**R3 修复本身**: Codex 确认无误（块长数学、top-8 选择均正确），no finding。

## Deferred Items (not fixed this cycle)
- goal_complete impossible 事件的 turns/tokensUsed 真实值（需 gate 签名改造，UI 显 0）
- aiSdkAdapter.ts / modelRouter.ts 的非可中断 retry sleep（短延迟，待抽共享 abortable helper）
- doom loop 同批次重复调用的执行中阻断（当前为 nudge → 下批次升级 abort 的设计内行为）
- MiMo subagent taskGate 上限 2（依赖 owner 语义，并入阶段二 2.6）

## LOW Findings (informational, no commit)
- truncateMiddle maxLength < 60 时预算为负（调用方均传大预算）

## Convergence Analysis

严重度与数量单调收敛（1H+6M → 1H+1M → 1M → 1M）但未到零——四轮 5 个 replacer 相关 finding 全部落在 **BlockAnchorReplacer 一个函数**上，这是教训的核心：从竞品"逐字移植"的代码会把上游的潜伏 bug 一起搬进来（单候选 0.0 阈值、首 tail 截断、行数门顺序全是 MiMo 上游带病行为），而移植者对这类代码的 confirmation bias 比对自写代码更强（"上游跑了这么久应该没问题"）。后续凡直接移植的算法代码，Round 1 就应该把"上游行为本身是否正确"列为显式审查维度，而不是只查移植保真度。

symmetric application 类 finding 本轮 2 个（retry sleep 的 sibling 路径、forceFinal 清理的退出路径覆盖），均在 Round 2 按预期出现，验证了 Felix 理论。

基础设施备注：审计期间 codex 全局安装两次损坏（缺平台二进制/签名失效），均以带代理干净重装修复；R3/R4 各有一次 25 分钟超时无输出（网络中断），重试后正常。

## Fix Commits
- Round 1: `8c7f8a892`（1H+6M+1L，15 files，TDD 12 新测试）
- Round 2: `764fe639e`（1H+1M，5 files，TDD 4 新测试）
- Round 3: `82fec3c22`（1M，2 files，TDD 2 新测试）
- Round 4: `3c7776ad2`（1M，3 files，TDD 2 新测试）

全部修复经 typecheck + agent/tools/model 套件（3578 tests）验证通过；未 push。

---

# 复核 Cycle（同日第二轮独立审计）

**Scope**: HEAD~7..HEAD = 上述 4 个审计修复 commit + 3 个遗留项修复 commit
（ff49bbdc0 goal_complete 真实计数 / a6d76740f abortableSleep 对称应用 /
05014d944 truncate 负预算降级，由独立会话按本报告 Deferred 清单完成）
**Rounds**: 2 / 4
**Converged**: ✅ yes（R2 明确 "converged — no findings"）

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     | 0    | 1   | 2   | 0c7ba8948  |
| 2     | 0    | 0   | 0   | —（收敛）  |

## 复核 Findings

### 🟡 MEDIUM — modelRouter 取消被折叠成"重试耗尽"
**Finding**: artifact 重试退避中 abort 唤醒后返回 null，caller 当成重试耗尽
带着已 abort 的 signal 跑完整条跨 provider fallback 链，最终把取消错报成
原始 provider 错误（502）。原测试只打私有 helper，盖不住公共入口行为。
**Resolution**: ✅ fixed in 0c7ba8948 — retry null 后 / fallback 每次尝试前
检查 abort 抛取消错误（cause 挂原错误）；fallback catch aborted 时原样上抛；
新增 inference() 公共层回归测试。R2 确认修复正确且未破坏非 abort 的 null
正常降级路径。

### 🟢 LOW（记录未修）
- runFinalizer.ts:234 failed-goal 路径的 goal_complete 仍用裸
  totalInput+totalOutput，漏 swarm 记账（与 ff49bbdc0 的口径统一类，
  建议下次顺手把 goal_complete payload 构造收口到单一处）
- truncateMiddle 小预算时输出可超 maxLength 23 字符（hard-cap vs
  content-budget 的契约设计决策，现有调用方均传大预算）

## 复核结论

衍生修复（fixes-to-fixes）经独立 cycle 验证收敛：唯一 MED 是遗留项会话
abortableSleep 对称应用时的上层语义缺口（睡眠可中断了，但"中断后向上
传播什么"没有跟着定义），属同一对称类的纵向延伸。基础设施备注：codex
stdin 等待是此前多次"超时无输出"的根因（$(cat) 读空 → codex 转等 stdin），
已固化为 stdin 重定向调用（`codex exec - < promptfile`）。
