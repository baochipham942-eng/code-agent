# ADR-032 — 请求前缀稳定与主动工具结果裁剪（cache 经济学下半场）

- 状态: accepted
- 日期: 2026-07-04
- 相关: PR#302（cache-aware 记账，WP2-1）、`contextAssembly/messageBuild.ts`、`context/layers/activeToolResultPrune.ts`、maka-agent 借鉴批 P1

## 背景：记账之后，命中率本身就是问题

PR#302 让 Neo 会算 cache 账（cacheRead/cacheCreation 进预算层，LongCat 实测缓存口径成本约为无缓存口径的 1/6）。但审计请求组装链路发现，Neo 的请求形状让 provider 前缀缓存**大量落空**：

OpenAI-compat provider（DeepSeek/Kimi/Zhipu/LongCat）的自动前缀缓存以 system 消息开头逐字节匹配——**system 任何一个字节变化 = 整个会话历史 cache miss**。而 Neo 的 system 消息里混着三类每轮/每步都在变的内容：

1. **轮内易变**（一轮 10-30 步，每步一次请求）：git 状态（dirty 文件数，agent 自己写文件就变，TTL 仅 30s）、后台 agent 完成通知（出现一次即消失）、persistentSystemContext（LRU re-push 会改序）、活跃子代理状态。
2. **跨轮易变**：advisory 意图块（skills/memory index/repo map/recent conversations/generative UI 等）按最新 userQuery 正则进出——`之前|文件|代码` 这类高频词让块进出成为常态。
3. **慢变但无谓**：env block 里的 `Today's date`。

另外工具表顺序依赖 registry 插入序 + MCP 连接时序（跨进程不确定），大 tool result 反复以 L1 的 2000-token 有损截断驻留上下文。

## 决策

### 1. system 消息 = 会话内字节稳定的可缓存前缀

- env block 按 workingDirectory 冻结（date 定格首次构建；caps 探针就绪允许一次性重建）；git 易变明细移出。
- 意图条件块拆两类：**契约类留 system**（artifact brief / game contract / game skill knowledge / active skill / provider variant / SYSTEM.md / APPEND_SYSTEM——行为高敏且这些轮次本来就重建上下文）；**advisory 类全部移出**（skills / session metadata / failure journal / memory index/hint / repo map / recent conversations / generative UI / question form），注入条件逐条保持不变，只换位置。
- 预算/丢弃可见化（GAP-023）语义保留：advisory 块仍在「稳定前缀 + 尾巴」合并视图上做预算核算。

### 2. 动态尾巴 = 历史末尾的 transient 消息

所有每请求变化的内容（advisory 轮上下文、git 状态、活跃子代理、完成通知、persistent context、repair focus）收进一条 `transient: true` 的尾部 system 消息：

- 位于全部历史之后 → 它的变化只影响自身字节，system+全史前缀保持可缓存。
- 成本模型：尾巴每步重发（不可缓存，约 0.2-3K tokens），换掉的是「每步/每轮整个历史重读」的 miss；长 agentic 轮净收益一个量级以上。
- **provider 边界统一转成末尾 user + `<system-reminder>` 包裹**（Claude Code 模式）：aiSdk 路径会把所有 system 消息无条件提升到最前（DeepSeek 也一样受害）、claudeProvider 只保留首条 system——不转换则尾巴要么被提到前缀里打掉缓存、要么被静默丢弃。Neo 运行时层面仍是 system role，能力检测（`filter(role==='user').pop()`）不受影响。

### 3. 工具表确定性排序

`inference()` dedupe 后按 name 字节序稳定排序，消除 registry/MCP 时序漂移；同一账号跨会话/跨进程的 system+tools 前缀由此可复用（DeepSeek 缓存是账号级的）。

### 4. L0 active tool-result prune（在 L1 之前）

超过阈值（默认 4096 tokens，`ACTIVE_TOOL_RESULT_PRUNE`）的工具结果：先经既有 spill 基建整体落盘归档，再把上下文里的内容替换成**确定性 placeholder**（无时间戳；含 archive 路径 + Read/Grep 取回指引 + 前 200 字符 preview）。

与既有三层的关系：**prune 是主动、即时、无损可回取**（归档失败保留原文）；L1（2000 tok head+tail）/L2 snip/L3 microcompact 仍是阈值触发的有损压缩。2000-4096 之间的结果仍走 L1；>4096 的不再以有损摘要形态驻留。placeholder 与轮次无关、同内容同字节——压缩层不再反复改写内容打前缀。

## 后果

- 正向：轮内请求 system+历史字节级稳定（有回归测试锁字节相等）；跨轮意图块进出不再打掉全史；大结果占用从 2000 tok 降到 ~80 tok 且可完整取回（优于有损截断的"取不回"）。
- 代价：advisory 块从"system 靠前"变为"历史末尾"，位置语义变化经 GAIA L1 子集回归验证；尾巴每步重发的小额固定成本；跨零点长会话 date 陈旧（可接受）。
- 度量口径：改前/改后用 PR#302 记账的 cacheReadTokens/inputTokens 实测（DeepSeek 真会话，同 prompt 5 轮），是本批唯一真验收。
