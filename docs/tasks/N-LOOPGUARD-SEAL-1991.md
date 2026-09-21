# N-LOOPGUARD-SEAL — 强制收尾后封死工具通道（issue #1991）

工单：GitHub issue #1991（夜跑 2026-09-20 证据）。
分支：`n-loopguard-seal-tool-channel`（worktree `wt-n-loopguard-seal`，基于 origin/main a5ca056be）。

## 事故链（根因）

只读循环撞硬阈值 → `activateForceFinalResponse` 置位 → 三步失控：

1. **goal 续跑覆盖收尾 break（主环路）**：`conversationRuntime` 在文本轮先判
   `goalMode?.isPending()` 续跑、后判 `break`，强制收尾文本轮的 break 被 goal
   continuation 吃掉 → 回到带工具的推理 → 只读硬阈值反复重触发 → 每轮批内剩余
   调用被 skip 且以 `success=false` 落 `onToolCallEnd`（单会话 136 次假工具失败，
   89 秒 153 次空烧派发）。
2. **裸标记代执行**：forceFinal 禁工具推理轮（inference 层清空工具表）模型回落到
   `<longcat_tool_call>` 文本协议，`detectAndForceExecuteTextToolCall` 又把文本里的
   工具调用描述解析成真 tool_use 派发出去。
3. **裸标记上屏**：终答文本里的 `<longcat_tool_call>/<longcat_arg_key>` 残片在 host
   侧从不剥离，持久化后进转录（渲染层 filterSystemTags 只是事后兜底，headless/CLI
   路径直接漏）。

### 裸标记成因（要求 c 的发现）

LongCat-2.0 的工具调用协议是 `<longcat_tool_call>` 标记流：请求带工具表时走结构化
通道，**工具表被清空（强制收尾推理 `effectiveTools = []`）时回落到训练期的裸标记
文本协议**。旧 force-final prompt 只说 "Do not call any tool"，没有禁止输出标记本身，
模型把「不能调用」理解成「把调用写成文本」。系统提示里没有别处教这个协议（host 侧
无 longcat 标记解析），回落纯粹是模型侧先验 + 提示没堵口。小改已做：prompt 补一条
明确禁止输出任何工具调用标记（toolPreflightGuards.ts）。大改（禁工具推理改走
provider 级 response_format 约束）只记发现，不做。

## 处理（三件事）

- **a. 封口**：新 `src/host/agent/runtime/forceFinalSeal.ts`——forceFinal 置位时
  tool_use 整轮不派发 executor、不写遥测，合成 `skipped` 抑制结果落账（turnTrace
  outcome=skipped，不进 consecutiveErrors）后直接走强制收尾结论（结论从
  messageProcessor 抽出两处共用）；`detectAndForceExecuteTextToolCall` 在 forceFinal
  下不再代执行/重试；批内（硬阈值置位后同批剩余调用）只发 UI 事件收口、不写遥测；
  goal 续跑不得覆盖强制收尾文本轮的 break。
- **b. 输出兜底**：`stripToolCallProtocolMarkup`（transcriptProjection.ts）挂进
  `stripInternalFormatMimicry` 单一收口点，剥离闭合/未闭合 `<longcat_tool_call>`
  及 arg_key/arg_value 残片，与渲染层 SYSTEM_TAG_PATTERNS 对齐；9 条单测。
- **c. 成因小改**：force-final prompt 明确「禁止输出任何工具调用标记，纯文本」。

## 反向变异

变异 1：`stripToolCallProtocolMarkup` 改成 `return content`（不剥离）→ 6 红：

```
 FAIL  tests/unit/agent/stripToolCallProtocolMarkup.test.ts > stripToolCallProtocolMarkup > strips a complete <longcat_tool_call> block and keeps surrounding prose
AssertionError: expected '先给出结论。\n<longcat_tool_call>{"name": "…' not to contain 'longcat_tool_call'
 FAIL  tests/unit/agent/stripToolCallProtocolMarkup.test.ts > stripToolCallProtocolMarkup > strips an unclosed <longcat_tool_call> through end of string
AssertionError: expected '结论如下。\n<longcat_tool_call>{"name": "R…' to be '结论如下。' // Object.is equality
      Tests  6 failed | 3 passed (9)
```

变异 2：messageProcessor 封口条件改成 `if (false && ...)`（forceFinal 置位时照常
派发）→ 3 红：

```
 FAIL  tests/unit/agent/messageProcessor.forceFinalSeal.test.ts > forceFinal 封口（issue #1991） > forceFinal 置位时 tool_use 整轮不派发 executor、不计工具失败遥测（defer 原因）
TypeError: Cannot read properties of undefined (reading 'length')
      Tests  3 failed | 1 passed (4)
```

两处变异恢复后全绿。

## 测试证词

- 新增：`messageProcessor.forceFinalSeal.test.ts` 4 条（不代执行 / defer 封口不派发
  不计失败 / 非 defer 就地收尾 break / turnTrace 记 skipped）；
  `stripToolCallProtocolMarkup.test.ts` 9 条；`toolExecutionEngine.hooks.test.ts`
  新增 1 条（批内抑制不写遥测，硬阈值本身仍落遥测）。
- 回归：toolExecutionEngine.hooks / messageProcessor.persistence(38) / stopHook /
  deferredAutoExecute / deliveryCritic / cancelClosure / conversationRuntime /
  contextAssembly / artifactRepairAdmission / forceExecute / antiPatternDetector(±extended)
  / agent/runtime 目录 / agentLoop(±turnSystemContext) / goalCompletionGate /
  inference.artifactRetry / inference.maxMode —— 合计 12+52 文件 950+ 用例全绿
  （runtime/browser 下 2 条 artifactPreviewHealthParity/designPreviewRepairInApp
  为基线既有 hook 超时 flake，未改代码的干净树上同样红，与本单无关）。
- `npm run typecheck` 绿。
- gates:fast 回执行见 PR 描述（ship pr 复核）。

证据档位：static-contract（typecheck + gates:fast 静态格）+ hermetic-protocol（单测全 mock 隔离，无真模型/真网络）。


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=ebfd520177e263a1e6e755d386dcf1a6057410b0 base=7f353a4fec5d2526531dbbf93c5f086fec8ad664 receipt=91fc25f4-2162-488c-a450-bb3b41ab40e5
