# ADR-068：首字节之后断流续接（stream resume after first delta）

- 状态：已拍板（2026-09-14 爸；刀 0–3 已合 main：#1819/#1822/#1828/#1830，刀 4 UI 信号收官中）
- 日期：2026-09-14
- 工单：N-STREAM-RESUME-ADR（RQ-214，SOTA 体检 D09-04 并入，模型合同线 P0）
- 相关：ADR-032（请求形状前缀稳定——续接重发仍吃 prompt cache 的前提）、ADR-037（durable run kernel；已知限制表「自动重发可能重复收费，不能承诺 exactly-once」同口径）、N-LOOP-DURABLE-K2（进程重启的 close-only 恢复，与本单的进程内续接分界）、N-INTERRUPT-REPLAY（中断轮 resumable 回放形态先例，2026-08-26 落地）、D09-04 / D02-01 设计草案（SOTA 体检输入，本 ADR 对其逐条重拍）
- as-built 基线：origin/main@c2d1db78b（勘察树 `feat/stream-resume-adr`）

本 ADR 只定形状，不改代码、不配基线。爸拍板后才拆施工单。

## 背景

`aiSdkAdapter.ts:1051-1054` 的 `!emittedOutput` 闸门：吐出第一个用户可见 delta（text / reasoning / tool_call_start，`:957/:970/:976/:993` 四处置 true）之后，任何断流——网络抖动、provider 5xx、看门狗超时、合盖休眠导致的 socket 挂断——直接 `onStream({type:'error'})` + throw，一次抖动 = 已生成的 output tokens 全部沉没 + 整轮重来全价 + 用户看到红色报错（RQ-214：🔴 一次网络抖动=白跑一轮）。`docs/ARCHITECTURE.md:551` 把闸门写成设计意图：「已输出内容后的流式重试受 adapter 限制，防止把两次回答拼成一次」。竞品对照（体检 D02-01）：六家对照里四家已 shipped 断流续接，艾克斯/劳拉/爸三票一致「本季做」。

本 ADR 按「取舍已过期」立论，当年两条前提逐条复核：

1. **「provider 无续接能力」**——不成立（D1 能力核查：DeepSeek / OpenRouter 有官方 prefix 合同，Anthropic ≤4.5 文档化 prefill，Gemini 有事实标准的 trailing model turn）。但也不是全量成立（OpenAI 无官方参数、Anthropic 4.6+ 直接 400），所以续接必须分档，不能当万能原语。
2. **「拼接正确性无解」**——不成立。仓库现在有 `preserveStreamedPartial`（`conversationRuntime.ts:1144`，取消/转向时把半截内容落库成带标记的 assistant 消息）、streamSnapshot 证据链（`streamSnapshot.ts:46-59`，`stableForExecution:false` / `executionToolCalls:[]`）、`StreamInterruptionReason` 中断呈现词表——「部分结果的诚实呈现」词汇齐了，边界可以定义、可以守住（D2）。

勘察发现一处与 551 行叙事不符的暴露面（as-built 备注 1）：闸门只挡 adapter 层。loop 层的网络错误重试（`inference.ts:1143-1173`，预算 1–2 次）和 artifact 非流式重试（`:1039-1066`）在**已吐 delta 后**仍会整轮重发 `ctx.inference()`：不检查已吐状态、不保留前次片段（`:760` `resetStreamedContent()` 直接清空）、renderer 消息不重置（`message_delta` 只有 append 语义）、且 `streamCallback` 没有 `error` 分支（全文件仅 `:1018` 的 overflow 事件）——中断对用户不可见，重发内容 append 进同一条消息。「防拼接」在 loop 层实际没有被完整执行。

## 北极星

首字节之后的瞬态断流，用户最多看到一行「连接中断，正在续接 n/N」，然后打字无缝（或诚实分段地）继续；已生成的 output 不因一次抖动作废；半截 tool_call 永不执行；跨次生成的内容永不冒充单次连续生成。

## 决策

### D1 provider 续接能力分档（2026-09-14 核查，逐条附来源）

| provider（仓内接入） | 接入方式 | 续接能力 | 档位 | 来源 |
|---|---|---|---|---|
| deepseek | `@ai-sdk/deepseek` | 官方对话前缀续写（Beta）：末条 assistant 消息 + `prefix:true`，但必须切 `api.deepseek.com/beta` 端点 | `prefix-param` | [api-docs.deepseek.com/zh-cn/guides/chat_prefix_completion](https://api-docs.deepseek.com/zh-cn/guides/chat_prefix_completion) |
| openrouter | openai-compatible | 官方 assistant prefill：messages 末尾 assistant 消息续写 | `trailing-assistant` | [openrouter.ai/docs/api_reference/overview](https://openrouter.ai/docs/api_reference/overview) |
| claude | `@ai-sdk/anthropic` | prefill 官方文档化，**但 Claude 4.6+ 与 Mythos Preview 返回 400**（仓内默认 `claude-opus-4-7` 中招）；≤4.5 可用；`stop_reason=max_tokens` 的「回传 assistant 消息再请求」续写模式另有文档 | `trailing-assistant`（≤4.5）/ `none`（4.6+），**按模型分档** | [platform.claude.com/docs/en/build-with-claude/working-with-messages](https://platform.claude.com/docs/en/build-with-claude/working-with-messages)、[handling-stop-reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons) |
| openai | openai-compatible | 无官方 prefix/续写参数；社区长期 feature request；部分模型直接拒绝末条 assistant（工具层实测报「This model does not support assistant message prefill」） | `none` | [community.openai.com 长期请求帖](https://community.openai.com/t/can-the-api-continue-generation-exactly-after-the-last-assistant-message-assistant-last-continuation/1354686) |
| gemini | `@ai-sdk/google`（v1beta generateContent） | contents 末尾 model 角色可续写（社区/官方支持帖证实的事实标准，非一等文档合同）；thinking 模型必须保留 thought signatures 才能续推理；新 Interactions API 的 `previous_interaction_id` 仓内未用 | `trailing-assistant`（事实标准档） | [ai.google.dev/gemini-api/docs/text-generation](https://ai.google.dev/gemini-api/docs/text-generation)、[thinking（thought signatures）](https://ai.google.dev/gemini-api/docs/thinking) |
| moonshot / kimiK25、zhipu（0ki/官方/coding）、qwen、minimax、grok、volcengine、longcat、xiaomi、groq、perplexity、local、custom | openai-compatible | OpenAI 兼容协议无公开 prefix 续写合同（2026-09-14 检索未命中官方文档） | `unknown` | 检索记录见证据档 |

落地形状：`modelCapabilityMatrix.ts` 的 `ModelCapabilityMatrixEntry` 增加 `streamResume` 档位字段（granularity 对齐现有 claude `thinking.interleaved` 的 per-model 先例）；`prefix-param` 档携带端点覆盖信息（DeepSeek 的 `/beta`）。**只有官方文档已证实的档位启用 B1 无缝续接；`unknown` 档一律走 B2 兜底**，不做运行时探针（否决理由见文末）。国产主力（kimi-zhipu-longcat）后续靠逐家真机验证升档，升档只改能力表。

### D2 部分结果的保留形态与「不拼两次回答」的正确性边界

边界定义：**用户看到的每一条 assistant 消息，其文本必须来自单次连续生成；跨次生成的内容只有两种合法呈现——(a) B1 无缝续接：续写 delta 从断点 append 到同一条消息，合法性来自 provider 的 prefix 合同（模型以传入前缀为条件继续同一次生成）；(b) B2 诚实分段：断点片段以带 `interruptionReason` 标记的 assistant 消息落库（形态对齐 `preserveStreamedPartial`），续答是新的一条消息。** 把重发的全新生成 append 到已有片段后面冒充同一次生成，即「拼两次回答」，两级都禁止。

- tool_call 累积态：断点处 `argsText` 半截的 tool_call **永不执行、永不进 prefix**（对齐 streamSnapshot `stableForExecution:false` / `executionToolCalls:[]` 的既有拍板）；只有完整（`JSON.parse` 可过，复用 `getIncompleteToolCallIds` 判据）的 tool_call 才可作为 prefix 的一部分回传，半截的丢弃让模型重发完整调用。tool_call index 映射跨 attempt 保持稳定。**（2026-09-15 施工回写：「完整 tool_call 作为 prefix 回传」在 AI SDK 路径上不可达——`convertToLanguageModelPrompt` 的 tool-call/tool-result 配对校验在请求发出前即抛 `MissingToolResultsError`（实证 `node_modules/ai/dist/index.js:1438-1449`，ai-review PR #1830 一轮 Important）。落地收敛为：B1 仅覆盖 text-only 断点（绝大多数 streaming 断流形态），断点含完整 tool_call 时回落 B2 诚实分段——partial 分段落库、模型重发完整调用，同等安全语义。）**
- B1 打破「每次尝试全新累积器」不变量（`aiSdkAdapter.ts:878-880` 的注释明说该不变量依赖闸门）：续接 attempt 的 accumulator 必须用断点态 seed（content / contentParts / reasoning / 完整 toolCalls），续写 delta 追加其上。
- 持久化：B1 成功后落库的就是一条完整 assistant 消息（前缀 + 续写，天然一体）；B2 / 预算耗尽时片段带中断标记落库——补齐现状缺口：**error 路径今天不落库 partial**（`preserveStreamedPartial` 只挂在 cancel/steer 上，`conversationRuntime.ts:1175/:1221`）。
- usage 跨 attempt 合并记账（每次尝试都是真实计费），展示层单轮 usage = Σ 各次尝试。

### D3 断流分类与可续接性

| 断流类别 | 识别（现状机制） | 处置 |
|---|---|---|
| 合盖休眠 / 网络切换 | 表现为 socket 挂断（ECONNRESET 族）或 inactivity 看门狗触发；进程活着 | 可续接（B1/B2） |
| 网络抖动 | `isRetryableModelCallError` 瞬态文案/code（`retryStrategy.ts:145`） | 可续接 |
| provider 5xx / 429 | 同上，status ∈ {429,500,502,503,504}；429 尊重 retry-after | 可续接 |
| 看门狗 first-byte 超时（`SSE_FIRST_BYTE_TIMEOUT` 60s） | `emittedOutput` 必为 false | **现有首字节前重试已覆盖，不属本 ADR** |
| 看门狗 stream inactivity 超时（120s，env 可调） | `timedOutKind='stream inactivity'`，已吐 delta | 可续接（本 ADR 主场景） |
| app 进程死 / 重启 | — | **不属本 ADR**：durable run kernel（ADR-037）+ streamSnapshot 证据回放 + N-LOOP-DURABLE-K2 close-only 恢复管辖；回来后 partial 以证据形态回填（`streamRecoveryMessage.ts`），不自动续写。本 ADR 只管进程内 in-flight 断流 |
| 用户取消 / steer | 外部 signal abort | 不续接（abort 永远优先于续接，现状语义保持） |

### D4 重试预算与幂等

- `STREAM_RECONNECT_MAX`（默认 2，env 可覆盖）从首字节前预算拆出，常量进 `shared/constants`；首字节前重试维持 `STREAM_MAX_RETRIES=4` 不变（那边没有 output 沉没成本，且用户无感）。
- **前台 / 无人值守分档**（D02-01 三票一致指向）：前台轮首次自动续接、预算耗尽即转 error 交还用户；无人值守轮（goal / cron / `--ephemeral` 等无 UI 盯守）无条件自动续跑，预算取 `UNATTENDED_STREAM_RECONNECT_MAX=5`，并以「同 run 连续断流 ≥3 次熔断」防断流-续跑死循环——熔断后不再重发，收尾成 resumable 中断态（D5 形态）。
- 退避复用 `computeRetryBackoffMs`（base 1s、±25% jitter），续接场景封顶压到 4s（打字中断要快恢复，不是越长越稳）；429 的 retry-after 优先。
- 计费与幂等：与 ARCHITECTURE.md:677 已知限制（ADR-037「自动重发可能重复收费；返回复核，不能承诺 exactly-once」）同一口径——**不承诺幂等，靠预算封顶 + usage 全量记账让成本可见**。续接重发与原请求共享逐字相同的前缀（system + history + user），ADR-032 的请求形状稳定保证 provider prompt cache 命中原前缀，增量 input 计费只有 assistant prefix 段。原次已生成 output 是沉没成本，usage 合并后如实入账。
- 安全幂等比计费幂等更硬：半截 tool_call 丢弃重生成（D2），续接永不执行不完整参数。

### D5 UI 面：一屏一个信号

- 断流续接中：聊天流里**同一条 streaming assistant 消息**内嵌一个状态行「连接中断，正在续接 n/N」（D09-04 草案原文），不新开第二条消息、不叠全局 banner；复用 `StreamInterruptionReason` 中断提示的既有词表与呈现位（`streamInterruptionPresentation.ts`）。
- 续接成功：状态行消除，delta 无缝继续（B1）或新消息起头（B2，带一次性续接说明）。
- 预算耗尽：转 error 态 + partial 按带中断标记落库保留，回放复用 N-INTERRUPT-REPLAY 已落的 resumable 回放形态（时间线工具行 + `DecisionSlot`，中断原因由落库标记派生），「重试」动作挂在 DecisionSlot——不发明第三种中断呈现。
- 语义先例：voiceCall 的 reconnecting（`voiceCallStore.ts:53`「同一通电话，work items / 计时都不重置」）——续接是同一轮回答，不重置 turn。
- CLI 可见性：复用 adapter `retryEvents` 'retry' 事件通道（`aiSdkAdapter.ts:1059` 现有先例）扩展 reconnect 语义，打一行提示。

### D6 选项对比与推荐

| 选项 | 成本 | 风险 | 适用面 | 结论 |
|---|---|---|---|---|
| A 不续接（现状） | 0 | 一次抖动 = 白跑一轮（output 沉没 + 重来全价 + 红错）；loop 层还留着不受控的已吐后整轮重发 | — | 与 09-05 三档分拣「🔴 本季做」冲突，否决 |
| **B 同 provider 续接（B1 优先、B2 兜底）** | adapter 状态机 + 能力表 + UI 信号，四刀 | 接缝正确性（D2 边界守住）、重复计费（D4 预算封顶） | B2 全 provider 兜底；B1 覆盖 deepseek / openrouter / claude≤4.5 / gemini | **推荐** |
| C 跨 provider 降级续接 | 更高 | 换模型后文风/语义/tokenizer 全变，prefix 对另一家更无合同，接缝必伪；modelRouter 的 fallback 语义是能力缺失整轮替换，不是流中续接 | — | 否决。B 耗尽转 error + 用户手动重试/换模型（已有 fallback 通知与错误呈现） |

### D7 分期刀（验收口径与反向变异门）

见「施工拆单」。每刀独立 PR；B2（刀 3）先行落地即可止损「白跑一轮」，B1（刀 2）在能力表命中的 provider 上提升到无缝。

## 否决的替代

- **运行时能力探针**（首启真发一次 `max_tokens=1` 的 prefix 请求验证不 400，结果缓存）。收益只覆盖 `unknown` 档，成本是多一条网络依赖 + 缓存失效面 + 探针本身的计费；`unknown` 档 B2 兜底已够。逐家真机验证后改静态能力表更稳。
- **断流后静默整轮重发**（不留痕不告知）。就是 loop 层 network retry 现状：中断不可见、片段丢失、append 拼缝——本 ADR 要收编的暴露面，不是方案。
- **把 durable 恢复（进程重启）并入本 ADR 一起做**。两件事的失败模型不同（进程死了 accumulator/attempt 状态全没了，只能从磁盘证据重建），durable 侧已有 ADR-037 + N-LOOP-DURABLE-K2 的 close-only 拍板，合并只会互相拖住。
- **靠 prompt 文案让模型「接着上文继续写」**（不带 prefix 合同的重发）。模型不保证衔接，重复/改写开头都是常态，正是「拼两次回答」的加强版。

## 后果

得到：

- 首字节后瞬态断流从「白跑一轮」变为最多 2 次续接，已生成 output 不作废；主力 provider 无缝，其余诚实分段。
- 中断可可见、可计量（usage 合并、reconnect 事件），loop 层不受控的已吐后重发收编进同一边界。
- 能力表成为 provider 合同的单一事实源，后续升档只改数据。

代价：

- adapter 状态机复杂化（断点态 seed、两级分支、预算双轨）；UI/CLI 各加一种状态。
- 续接期间用户等 1–4s 退避 + 请求时间；预算耗尽时体验与现状相同但 partial 不再丢。
- B2 分段会让一条回答变成两段消息——诚实但有视觉成本，靠一次性续接说明压到最轻。

不做：跨 provider 流中续接、进程重启自动续写、`unknown` 档探针、`message_delta` 协议新增 reset 语义（B1 append 天然成立，B2 新消息天然新起）。

## 施工拆单（ADR 过后开，本单不动）

| 单 | 内容 | 门 | 依赖 |
|---|---|---|---|
| 刀 0 能力表 | `modelCapabilityMatrix` 加 `streamResume` 档位（deepseek `prefix-param` 带 /beta 端点、openrouter / gemini `trailing-assistant`、claude 按模型分档 ≤4.5 可 / 4.6+ none、openai none、其余 unknown）；不改任何行为 | 单测（档位解析、claude 4.6+ 与 ≤4.5 分档正确）+ 反向变异（把 claude-opus-4-7 判成可 prefix → 分档断言红） | — |
| 刀 1 续接状态机与预算 | `STREAM_RECONNECT_MAX` / `UNATTENDED_STREAM_RECONNECT_MAX` 常量与前台/无人值守分档、连续断流熔断计数；断流识别（`isRetryableModelCallError` + `timedOutKind` + `emittedOutput`）；`emittedOutput=true` 时改走 resume 分支：accumulator 断点态 seed、abort 短路、预算耗尽回落现有 error+throw；首字节前路径零改动 | 单测（断点后第二 attempt 请求携带前缀态、abort 不续接、预算耗尽转 throw、无人值守分档取高预算、熔断计数到阈值停止重发、首字节前重试不回归）+ 反向变异（把 seed 改回全新累积器 → 断点态断言红） | 0 |
| 刀 2 B1 prefix 请求形状 | 按能力表拼末条 assistant prefix（文本前缀 + 完整 tool_calls，半截丢弃）；vendorCompat `transformRequestBody` 注入 `prefix:true` / 切 /beta 端点；claude 4.6+ 自动落 B2；messages 前缀与原请求逐字一致（prompt cache 命中前提） | 单测（per provider 请求体形状、半截 tool_call 不进 prefix、前缀逐字一致不变量）+ 反向变异（prefix 拼接错位/漏掉 → 一致性断言红） | 0, 1 |
| 刀 3 B2 兜底与计量 | 无合同档 / B1 失败：partial 以带 `interruptionReason` 的 assistant 消息落库（对齐 `preserveStreamedPartial` 形态，补齐 error 路径不落库的缺口），续答新消息不拼缝；usage 跨 attempt 合并；loop 层已吐后整轮重发路径（network retry / artifact 非流式重试）收编：先保片段再重发 | 单测（B2 两段式落库、usage 合并、loop 层重发不丢 partial 不 append 拼缝）+ 反向变异（把分段改回 append 冒充单次 → 分段断言红） | 1 |
| 刀 4 UI 信号 | 「连接中断，正在续接 n/N」内嵌同一 streaming 消息，一屏一个信号；成功消除 / B2 新消息说明 / 失败转 error 保留 partial，耗尽态回放复用 N-INTERRUPT-REPLAY 的 resumable 形态（时间线行 + DecisionSlot 挂「重试」）；`retryEvents` 扩展 reconnect（CLI 一行） | 单测（n/N 计数、终态转换）+ E2E 断流注入（信号出现 → B1 续接无缝）+ 反向变异（去掉信号事件 → E2E 断言红） | 1 |

顺序：刀 0 → 刀 1 → 刀 2 / 刀 3 可并行 → 刀 4。刀 3 先行单独落地即兑现「不再白跑一轮」的主要止损。

## 事实锚点

（行号按文首 as-built 基线计；本 ADR 索引行进 `ARCHITECTURE.md` 后，下引两处行号各 +1 漂移。）

- `src/host/model/adapters/aiSdkAdapter.ts:513-520` 重试/快照常量；`:776-805` StreamAccumulator / createAccumulator / registerToolCall；`:878-881` 「全新累积器」不变量注释与 `emittedOutput`；`:900-919` 双看门狗；`:942-1020` 流事件循环（`:957/:970/:976/:993` 四处置 emittedOutput）；`:1037-1069` catch：`:1041` abort/error 出口刷快照、`:1051-1054` 闸门、`:1055-1062` 首字节前重试、`:1066` onStream error、`:1069` throw
- `src/host/model/providers/retryStrategy.ts:103-110` 可重试状态码集合与退避封顶；`:145-157` isRetryableModelCallError；`:163-172` computeRetryBackoffMs
- `src/host/session/streamSnapshot.ts:46-59` PersistedSnapshot（evidence-only 三字段）；`:62-90` markStreamSnapshotInterruptionReason；`:230-245` getIncompleteToolCallIds；`:356-374` createSnapshotHandler
- `src/host/agent/runtime/contextAssembly/inference.ts:759-770` resetStreamedContent / 留底注释；`:851-856` onSnapshot 接线；`:943-1176` loop 层 catch：`:1039-1066` artifact 非流式重试、`:1143-1173` network retry（无已吐检查、无 'error' 分支消费，`:1018` 是 overflow 事件非 stream error）
- `src/host/agent/runtime/conversationRuntime.ts:1144-1165` preserveStreamedPartial；`:1167-1183` cancel；`:1206-1227` steer
- `src/host/agent/runtime/contextAssembly/inferenceArtifactRepair.ts:68-82` getNetworkRetryBudget
- `src/host/model/modelCapabilityMatrix.ts:22-59` 能力矩阵（claude per-model thinking 先例）
- `src/host/model/adapters/aiSdkVendorCompat.ts:1-50` vendorCompat transformRequestBody 注入点
- `src/shared/contract/message.ts:454` StreamInterruptionReason；`src/renderer/utils/streamInterruptionPresentation.ts` / `streamRecoveryMessage.ts` 中断呈现与回填
- `src/shared/constants/providers.ts:171-280` PROVIDER_REGISTRY；`src/shared/constants/defaults.ts:5-16` 超时与默认 provider
- `docs/ARCHITECTURE.md:551` 闸门设计意图原文；`:677` ADR-037 重复计费已知限制

## as-built 备注

1. **551 行叙事与实况的偏差**：「已输出内容后的流式重试受 adapter 限制」只在 adapter 层成立；loop 层 network retry（预算 1–2 次）与 artifact 非流式重试在已吐 delta 后仍整轮重发：不检查已吐状态、`resetStreamedContent()` 丢片段、renderer 侧 `message_delta` 仅 append 无 reset、streamCallback 无 'error' 分支（中断不可见）。本 ADR 刀 3 收编；施工前需一次真机复现确认 renderer 实际表现（本勘察基于代码通读，未做真机复现）。
2. 09-06 注记行号 `aiSdkAdapter.ts:1051-1063` 与 09-14 基线一致未漂移；`ARCHITECTURE.md:900 → 现为 551`。
3. **Anthropic prefill 在 Claude 4.6+ 返回 400**（官方文档 2026-09-14 核实）：D09-04 草案设想的「assistant prefix 续写」对仓内默认 `claude-opus-4-7` 不成立，能力表必须按模型分档——这是对草案的一处实质修正。
4. streamSnapshot 的 evidence-only 拍板（`stableForExecution:false`）本 ADR 不推翻：进程死回来的恢复仍是证据回放不自动续写；本 ADR 只管进程内 in-flight 断流。两者以「进程是否活着」分界。
5. DeepSeek prefix 续写在 `/beta` 端点（非仓内 `MODEL_API_ENDPOINTS.deepseek` 主端点），刀 2 需端点覆盖能力；`@ai-sdk/deepseek` 不一定暴露该形状，必要时走 vendorCompat 手搓请求体。
6. **施工落地与本文的偏差汇总**（2026-09-15 回写，细节见各刀证据档）：① D2 完整 tool_call 进 prefix 不可达，改 B1 text-only + 含 tool_call 断点落 B2（见 D2 回写段）；② 端点覆盖只替换 baseURL 末尾版本段（`…/vN → /beta`），自定义中转站的目录前缀保留（PR #1830 二轮 Important）；③ B1 attempt 首字节前瞬态失败须把 `resumeSeed` 挂回再 continue，否则断点态静默丢失；④ 刀 3 真机复现坐实了 as-built 备注 1 的 loop 层暴露面（修复前 DB 里 partial 一字不留），收编为「先保片段再重发」；⑤ 断点 partial 持久化对齐 `addAndPersistMessage` 降级链（persistMessage 缺失/失败降级 sessionManager，PR #1828 复审 Important）。
6. 台账标题（D02-01·三票一致）比任务书正文七点多两项设计指向——「无人值守轮无条件续跑、前台首次自动再失败交人」与「复用 preserveStreamedPartial 与 N-INTERRUPT-REPLAY 形态」——正文未展开，本 ADR 已分别并入 D4（分档+熔断）与 D5（回放形态复用）。
