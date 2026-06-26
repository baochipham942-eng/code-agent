# Codebase Navigation 长期方案

> 🔗 **集成修订（2026-06-26 审计回写）** — 统一排期与证据契约见 [`2026-06-26-00-INTEGRATION-evidence-and-resequencing.md`](./2026-06-26-00-INTEGRATION-evidence-and-resequencing.md)。本篇**拆成两半**：
> - ✅ **code_search 修复 → WP-G**（`codeIndexServer.ts:331` 确返回 "memory service removed"，修它真 P0；只做 lexical/FTS+symbol，**不引 embedding**），优先级 **7（独立小件，导航痛点浮现时插入）**。
> - **candidate/read/stale 规则 → 并入 WP-B**：candidate/read/stale 直接是统一 `EvidenceRef.freshness.state`（见 WP-A），"候选不进结论、必经 Read 绑定" = 结论只接受 `state==='read'` 的 ref。
> - ⏸️ **Tree-sitter repo map / LSP symbol graph / semantic index + 混合排序 → DEFERRED**：深度 coding-agent 基建，对非程序员协作者边际价值远低于"产物可信"，整体押后。
> 下文 P1/P2 大部分属押后项，**实际开工以集成文档 WP-G + WP-B 为准**。

## 判断

Codebase navigation 的长期方向不是再堆一个万能搜索工具，而是把 Neo 的代码库理解能力做成一套分层导航系统。

主流 coding agent 到 2026 年的稳定形态已经很清楚：`Glob` 找候选文件，`Grep` 找字符串和模式，`Read` 绑定精确证据，`LSP` 验证符号关系，`repo map / code index / symbol graph` 负责大仓下的召回和结构压缩。Cursor 偏强索引，Aider 偏 repo map，Claude Code 和 OpenCode 把 LSP 做成高精度工具，Gemini CLI 和 Codex CLI 仍然证明 `grep + read` 是最可靠的基础底盘。

Neo 当前不是缺工具，而是缺导航编排。工具各自存在，但 agent 什么时候该用 grep、什么时候该升级到 LSP、什么时候需要 repo map/code index、什么时候必须重新 Read，还没有被产品化成稳定策略。大仓 token budget 下，这会导致两类问题：搜索成本高，证据新鲜度不清。

## 目标形态

Neo 的目标形态是“候选召回”和“事实证据”分层明确的代码库导航系统。

- `Glob/ListDirectory`：用于文件名、目录结构、语言/后缀范围和入口候选发现。
- `Grep`：用于错误文本、配置键、API 名、字符串常量、测试名、日志名和跨语言弱结构搜索。
- `Read`：作为唯一可进入结论和编辑的源码事实来源，必须携带路径、行号、摘要、digest 和 freshness。
- `LSP`：用于已定位符号的 definition、references、hover、documentSymbol、workspaceSymbol、implementation、call hierarchy。
- `repo map`：用于陌生功能、大仓架构、入口粗定位和低 token 结构概览。
- `code index`：用于跨文件候选召回，先 lexical/symbol，后 semantic；索引结果必须标记为 candidate。
- `symbol graph`：用于影响面分析、调用链、实现关系和重构风险判断。
- `context fidelity ledger`：记录每条事实来自 candidate 还是 read evidence，压缩后哪些仍可信，哪些必须重读。
- `investigator 子 agent`：承担高噪声探索，把主会话只喂结构化 evidence table。

这套系统的核心约束是：repo map、code index、grep 只能产生候选；任何用于结论、计划或编辑的事实都必须经过 `Read` 绑定到精确范围。

## Neo 当前状态

Neo 已经具备基础工具能力。

- `src/main/tools/modules/file/read.ts` 已支持 offset/limit、行号、长行截断、binary redirect、fileReadTracker 和 token contribution。
- `src/main/tools/modules/file/glob.ts` 已有默认 ignore、glob 匹配和结果上限。
- `src/main/tools/modules/shell/grep.ts` 已优先使用 ripgrep，并支持 context、include/type filters、pagination 和 fallback。
- `src/main/tools/modules/lsp/lsp.ts` 已覆盖 definition、references、hover、documentSymbol、workspaceSymbol、implementation 和 call hierarchy。
- `src/main/tools/lsp/diagnosticsHelper.ts` 已能在编辑后做非阻塞 diagnostics feedback。
- `src/main/context/repoMap` 已有 repo map builder、cache、ranker 和 token budget 格式化。
- `src/main/context/layers` 已有 tool result budget、snip、microcompact、contextCollapse 等压缩层。
- `src/main/context/compactionService.ts` 和 survivor manifest 已经开始强调路径、摘要、digest、stale 和 needsReRead。

主要差距有四个。

第一，`src/main/mcp/servers/codeIndexServer.ts` 的 `code_search` 当前不可用，实际返回 memory service removed。`find_references` 仍是正则扫描，不足以支撑稳定影响面分析。

第二，repo map 目前偏被动，主要在 `src/main/agent/runtime/contextAssembly/messageBuild.ts` 里按 intent pattern 注入，budget 固定为 1500 tokens。它还不是 agent 可显式调用、可分档预算、可解释来源的导航资源。

第三，repo map 的符号抽取偏 regex，短期够用，但对大型 TS/JS/Python/Go/Rust 仓的结构理解不够稳。它需要逐步升级到 Tree-sitter 优先、regex fallback。

第四，context compression 能减少 token，但还没有统一的 evidence ledger。压缩后路径、摘要、候选、已读证据、过期状态和重读要求没有贯穿导航链路。

## 长期路线

### P0：把现有能力变成稳定导航闭环

1. 增加 navigation policy。
   - 文件名、路径模式、目录结构：优先 `Glob/ListDirectory`。
   - 错误文本、配置键、API 名、字符串常量、日志名：优先 `Grep`。
   - 已知符号且有文件位置：优先 `LSP`。
   - 陌生功能、架构问题、大仓入口定位：先 `repo map/code index` 召回，再 `Grep/Read` 验证。
   - 输出规则：候选不能直接进入结论；进入结论前必须有 `Read` evidence。

2. 修复 `code_search`。
   - P0 先做 lexical/FTS + symbol search，不引入 embedding。
   - 返回字段固定为 `path`、`line`、`symbol`、`snippet`、`score`、`freshness`、`source`。
   - 所有结果标记为 `candidate`，并提示下一步应该 `Read` 哪些范围。

3. 把 repo map 变成显式导航资源。
   - 从“系统提示偶尔注入”升级为 agent 可请求的资源。
   - budget 分为 1k、3k、8k 三档。
   - 输出只包含路径、关键符号、关系摘要和 token cost，不输出大段源码。
   - 每次 repo map 输出都附带生成时间和 root hash 或可替代 freshness 标识。

4. 建立 candidate vs read evidence 规则。
   - `grep`、`repo map`、`code index`、`workspaceSymbol` 默认都是 candidate。
   - `Read` 产物才是 read evidence。
   - 编辑前必须确认目标文件已经被 `Read`，压缩后标记 `needsReRead` 的文件必须重读。

5. 加导航评测。
   - 入口定位：给一个功能名，找到主入口和调用路径。
   - 错误定位：给错误文本，找到源头和修复区域。
   - 配置影响面：给配置键，找到读取、默认值、测试。
   - 符号影响面：给函数/类名，找到 references 和 tests。
   - 大仓预算：限制 4k/8k context，看是否仍能保留准确路径和证据。

### P1：提升结构理解和大仓召回质量

1. repo map 改为 Tree-sitter 优先。
   - TS/JS、Python、Go、Rust 先覆盖。
   - regex 作为 fallback，不阻塞语言覆盖。
   - 输出类、函数、导出符号、import/export、局部调用摘要。

2. 做 LSP-enriched symbol graph。
   - LSP 可用时，补 definition、references、implementation、call hierarchy。
   - LSP 不可用时，回退 import graph + grep references。
   - 图节点带来源：`lsp`、`repo_map`、`grep`、`manual_read`。

3. 建立 context fidelity ledger。
   - 每个事实记录 `sourceTool`、`path`、`lineRange`、`digest`、`freshness`、`evidenceState`。
   - `evidenceState` 至少包含 `candidate`、`read`、`stale`、`needs_re_read`。
   - 压缩层只压缩内容，不抹掉证据状态。

4. 加 investigator 子 agent。
   - 子 agent 负责高噪声搜索、候选归并和证据表整理。
   - 主会话只接收结构化结果：候选路径、推荐读取范围、置信度、未决点。
   - 子 agent 不直接产出最终结论，不直接改文件。

### P2：引入 semantic index，但保持证据回读

1. 引入 semantic code index。
   - 按 syntactic chunks 建索引。
   - 使用 content hash 做增量更新。
   - embedding 只负责候选召回，不作为最终事实。

2. 做混合排序。
   - query relevance、符号重要度、依赖 PageRank、git changed files、recent read files、test proximity 一起参与排序。
   - 输出解释每个候选为什么排在前面。

3. 做编辑前影响面报告。
   - 给出将要改的文件、直接 references、相关 tests、疑似配置入口。
   - 报告中区分 LSP 证据、grep 证据和 read evidence。

4. 把 diagnostics、typecheck、test feedback 接入导航循环。
   - 编辑后 diagnostics 触发相关符号和文件的局部重查。
   - test failure 触发 error grep、stack path read、candidate 更新。

### Later：产品化为 Neo 的代码理解工作台

1. 在 UI 或调试面板里展示 navigation trace。
   - 哪些工具被用过。
   - 哪些结果只是 candidate。
   - 哪些源码已经 read。
   - 哪些证据压缩后需要重读。

2. 做跨会话 repo intelligence cache。
   - 不缓存敏感源码原文。
   - 缓存结构摘要、符号图、hash、mtime 和可重建索引。
   - checkout 变化后自动失效。

3. 做可回放导航 eval。
   - 每个导航任务保存工具调用序列、候选变化、最终证据和错误原因。
   - 用于比较不同 policy、repo map budget 和 index ranking 的效果。

## 关键实现区域

- `src/main/tools/modules/file/read.ts`
- `src/main/tools/modules/file/read.schema.ts`
- `src/main/tools/modules/file/glob.ts`
- `src/main/tools/modules/file/glob.schema.ts`
- `src/main/tools/modules/shell/grep.ts`
- `src/main/tools/modules/shell/grep.schema.ts`
- `src/main/tools/modules/lsp/lsp.ts`
- `src/main/tools/modules/lsp/lsp.schema.ts`
- `src/main/tools/modules/lsp/diagnostics.ts`
- `src/main/tools/lsp/diagnosticsHelper.ts`
- `src/main/mcp/servers/codeIndexServer.ts`
- `src/main/context/repoMap/repoMapBuilder.ts`
- `src/main/context/repoMap/repoMapRanker.ts`
- `src/main/context/repoMap/repoMapCache.ts`
- `src/main/context/repoMap/types.ts`
- `src/main/agent/messageHandling/contextBuilder.ts`
- `src/main/agent/runtime/contextAssembly/messageBuild.ts`
- `src/main/agent/runtime/contextAssembly/compression.ts`
- `src/main/context/layers/toolResultBudget.ts`
- `src/main/context/layers/snip.ts`
- `src/main/context/layers/microcompact.ts`
- `src/main/context/layers/contextCollapse.ts`
- `src/main/context/compressionPipeline.ts`
- `src/main/context/compactionService.ts`
- `src/main/context/survivorManifest.ts`
- `docs/guides/tools-reference.md`
- `docs/architecture/agent-core.md`
- `docs/architecture/tool-system.md`
- `tests/unit/tools/modules/file/read.test.ts`
- `tests/unit/tools/modules/file/glob.test.ts`
- `tests/unit/tools/modules/shell/grep.test.ts`
- `tests/unit/tools/modules/lsp/lsp.test.ts`
- `tests/unit/context/compressionPipeline.test.ts`
- `tests/unit/context/layers/toolResultBudget.test.ts`
- `tests/unit/context/survivorManifest.test.ts`
- `tests/unit/context/compactionService.test.ts`

## 验收标准

P0 验收标准：

- `code_search` 不再返回 unavailable，能对本仓返回 lexical/symbol 候选。
- navigation policy 有明确测试覆盖：grep 场景、glob 场景、LSP 场景、repo map 场景、大仓预算场景。
- repo map 可作为显式资源请求，支持至少 1k/3k/8k 三档 token budget。
- `grep/repo_map/code_search` 结果进入最终回答前会被 `Read` 绑定到精确行号。
- 压缩后保留 `path`、`lineRange`、`digest`、`needsReRead`，不会把旧摘要伪装成新鲜源码。
- 关键文档同步更新，避免 `docs/guides/tools-reference.md` 继续描述旧 code_index schema。

P1 验收标准：

- TS/JS、Python、Go、Rust 至少有 Tree-sitter repo map 覆盖，regex fallback 有测试。
- symbol graph 能合并 LSP 和 repo map 结果，并在 LSP 不可用时降级。
- evidence ledger 能展示 candidate/read/stale/needs_re_read 的状态变化。
- investigator 子 agent 能在大仓探索任务里把主会话 token 消耗降下来，并返回结构化 evidence table。

P2 验收标准：

- semantic index 只作为候选召回，不允许绕过 `Read` 进入最终事实。
- 混合排序在导航 eval 中优于纯 grep 或纯 repo map。
- 编辑前影响面报告能覆盖直接 references、相关 tests 和配置入口。
- diagnostics/test failure 能触发局部重查，不需要 agent 重新全仓盲搜。

## 风险与未决问题

- LSP 可用性不稳定。很多仓没有 language server 或初始化很慢，所以 LSP 只能作为高精度增强，不能当唯一索引。
- Tree-sitter 语言覆盖会带来维护成本。P1 需要先覆盖高价值语言，避免一次性铺太宽。
- semantic index 容易让 agent 过度相信相似结果。必须在产品规则上把 semantic result 固定为 candidate。
- context fidelity ledger 可能增加消息体和工具结果复杂度。需要控制字段数量，优先保留 path、lineRange、digest、freshness、state。
- investigator 子 agent 的结果可能丢细节。需要强制它返回可复查的路径和行号范围，而不是自然语言总结。
- 现有 docs 中 code index 描述和实现已经不完全一致。P0 修复时要同步文档，不然工具行为会继续漂。

## 证据来源

外部官方资料：

- Claude Code Tools Reference: https://code.claude.com/docs/en/tools-reference
- Claude Code Subagents: https://code.claude.com/docs/en/sub-agents
- Aider Repository Map: https://aider.chat/docs/repomap.html
- Gemini CLI Tools: https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/tools.md
- Gemini Codebase Investigator: https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/agents/codebase-investigator.ts
- OpenCode Tools: https://opencode.ai/docs/tools/
- OpenCode LSP Servers: https://opencode.ai/docs/lsp/
- Cursor Search: https://cursor.com/docs/agent/tools/search
- Cursor Secure Codebase Indexing: https://cursor.com/blog/secure-codebase-indexing
- OpenAI Codex CLI: https://developers.openai.com/codex/cli
- OpenAI Codex Prompt: https://github.com/openai/codex/blob/main/codex-rs/core/gpt_5_codex_prompt.md

本仓证据：

- `src/main/tools/modules/file/read.ts`
- `src/main/tools/modules/file/glob.ts`
- `src/main/tools/modules/shell/grep.ts`
- `src/main/tools/modules/lsp/lsp.ts`
- `src/main/tools/lsp/diagnosticsHelper.ts`
- `src/main/mcp/servers/codeIndexServer.ts`
- `src/main/context/repoMap/repoMapBuilder.ts`
- `src/main/context/repoMap/repoMapRanker.ts`
- `src/main/context/repoMap/repoMapCache.ts`
- `src/main/agent/runtime/contextAssembly/messageBuild.ts`
- `src/main/context/layers/toolResultBudget.ts`
- `src/main/context/compactionService.ts`
- `src/main/context/survivorManifest.ts`
- `docs/guides/tools-reference.md`
- `docs/architecture/agent-core.md`
- `docs/architecture/tool-system.md`
- `tests/unit/tools/modules/file/read.test.ts`
- `tests/unit/tools/modules/file/glob.test.ts`
- `tests/unit/tools/modules/shell/grep.test.ts`
- `tests/unit/tools/modules/lsp/lsp.test.ts`
- `tests/unit/context/compressionPipeline.test.ts`
- `tests/unit/context/layers/toolResultBudget.test.ts`
- `tests/unit/context/survivorManifest.test.ts`
- `tests/unit/context/compactionService.test.ts`
