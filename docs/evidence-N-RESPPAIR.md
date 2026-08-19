# N-RESPPAIR 验收证据

## 结论

Responses 请求出口现在强制维护 `function_call` 与 `function_call_output` 的配对及顺序不变量：

- 正常配对原样保留，并把 output 紧邻放到所属 assistant output 组之后。
- 孤儿 `function_call` 补说明性失败 output。
- 孤儿 `function_call_output` 丢弃。
- `responsesOutput` 丢失但结构化 `toolCalls` 尚在时，从 `toolCalls` 重建原始 call。
- 所有自愈均以 WARN 留痕，包含 `callId`、缺失侧、历史 `messageIndex`；原始 output 内的孤儿 call 另含 `responsesOutputIndex`。

Dev2 真机最终通过：前台发起 Write、人工点“拒绝”、工具未执行，agent 本轮正常回复“写入被拒绝”，同一 session 后续继续回复“拒绝后同一会话继续成功”，新增运行失败数为 0。

## 开工检查

- `wtready`：通过；node_modules-scope WARN 为预期软链状态。
- `df -h /`：根盘可用 12 GiB，高于 10 GiB 停工线。
- worktree：`/Users/linchen/Downloads/ai/wt/N-RESPPAIR`
- branch：`fix/responses-toolcall-pairing`
- 基线：`origin/main@0680eac0a`

## 两个待查项

### 审批拒绝路径

查实拒绝结果会进入历史：

- `toolExecutor` 返回 `success:false` 与 `Permission denied by user`。
- `messageProcessor` 把结果持久化为 `role='tool'`，保留原 `toolCallId`。
- Dev2 数据库中的 DENY-FIVE：assistant call `call_00_uy6Xx71Bc5GB2ABYSmYS6671` 后紧跟同 ID 的失败 tool result。
- `permission_decisions.id=5`：`final_outcome=deny`、`history_outcome=ask-denied`、`reason=user`。

因此①类 400 的拒绝结果并未在 executor/messageProcessor 源头消失；真正断点发生在 Responses 请求组装顺序。

### Chat Completions

Chat Completions 共享出口已经通过 `repairOpenAIToolMessagePairing` 维护同类不变量，并已有孤儿 call 补结果、孤儿 output 降级的断言。本单相关回归包含 `tests/unit/model/providers-shared.test.ts`，无需把 Responses wire-format 修复上提到共享层。

## 根因与源头修复

最终请求 payload 证明存在三层问题：

1. `messages` 表此前不保存 `responsesOutput`，session 重载后 assistant 只剩结构化 `toolCalls`，原生 Responses `function_call` 丢失。
2. L4 context collapse 此前可以拆开结构化 call/result 对。
3. 拒绝后运行时在 assistant call 与 tool result 之间插入 `<strike-1-guidance>` / `<thinking>` system 消息。兼容端要求 output 紧邻 call 组；即便稍后存在同 call_id，仍返回 `No tool output found`。

对应修复：

- 数据库 schema、message CRUD、fork、conversation projection/branch 全链路持久化 `responses_output`。
- L4 collapse 把匹配的结构化 call/result message ID 一并保护。
- Responses 出口从持久化 `toolCalls` 重建缺失 call，并 fail-loud 记录来源。
- Responses 出口按出现顺序匹配 call/output；output 在 call 之前不算配对。
- 已匹配 output 移到 assistant output 组之后、运行时 system 提示之前。

对 commit `01b97fd0f` 的定点核查显示其删除的是 realtime voice assistant item，没有直接改动文本 ModelMessage 历史；排除为本单直接根因。

## Hermetic 测试

命令：

```text
npx vitest run \
  tests/unit/model/responsesProvider.test.ts \
  tests/unit/model/providers-shared.test.ts \
  tests/unit/context/compressionPipeline.test.ts \
  tests/unit/services/SessionRepository.remoteMessageIdempotency.test.ts \
  tests/unit/services/SessionRepository.runtimeState.test.ts \
  tests/unit/tools/toolExecutor.decisionTrace.test.ts
```

计数：**92 passed / 0 failed / 0 skipped**，6 test files 全通过。

Responses 专项覆盖：正常成对、孤儿 call、孤儿 output、两类孤儿同时存在、output-before-call、system 插入导致非紧邻、`responsesOutput` 丢失后的 durable `toolCalls` 重建；失配断言均检查 WARN 中的 call_id 与位置。

## 反向变异

临时把 `buildResponsesInput` 的返回值改为未修复的 located items：

- 变异态：**0 passed / 1 failed / 18 skipped**。
- 精确复现：`Responses API (400): No tool output found for tool call call_mutation_probe.`
- 还原源码后：**1 passed / 0 failed / 18 skipped**。
- `git diff --check` 通过，变异代码未残留。

## Dev2 真机

- 槽位：Dev 2。
- 起跑前原 `~/.code-agent-dev2` 不存在；后续为重复干净启动，创建态曾可恢复地移到 `/tmp/code-agent-dev2-nresppair-preauth-20260819-0950`。
- 构建：`npm run build:web` 通过；直跑 `dist/web/webServer.bundle.cjs`，未打包应用。
- session：`session_1787104321201_7413aa5d`，全程未点“新任务”。

第一次真机暴露 output 非紧邻问题，未当作通过：payload 中 call 与 output 之间存在运行时 system guidance，供应商仍报 400。补回归与相邻排序修复后重新构建并复验。

最终链路：

1. 同一旧坏 session 回复“旧拒绝历史恢复成功”。
2. 发起 Write `/tmp/n-resppair-dev2-deny5.txt`。
3. 前台选择“拒绝”并确认。
4. `permission_decisions.id=5` 记录用户拒绝；`rtk proxy test -e` 证明目标文件不存在。
5. agent 本轮正常回复“写入被拒绝”。
6. 同一 session 再发消息，正常回复“拒绝后同一会话继续成功”。
7. 浏览器断言：`failuresBefore=0`、`failuresAfterDenial=0`、`failuresFinal=0`。

截图：`/tmp/n-resppair-dev2-acceptance.png`。

## 门禁

修正新增 max-lines 与 tests TypeScript 错误后，取证轮结果：

- `npm run typecheck`：通过。
- `node scripts/eslint-ratchet.mjs`：errors 0/0，warnings 414/414，通过。
- `node scripts/tsc-tests-ratchet.mjs`：errors 0/0，通过。
- `node scripts/knip-ratchet.mjs`：2620 symbols，baseline 2632，未新增。
- `node scripts/knip-ratchet.mjs --profile production`：3864 symbols / baseline 3904；不可达文件 125 / baseline 130，未新增。

本证据档提交后，上述五项会作为交付前最后动作原样重跑；最终有效结果以交接中的最后门禁记录为准。

## 阶段提交

- `5fee99509` `fix(responses): preserve tool call pairing`
- `13c5a6488` `fix(responses): reconstruct lost durable tool calls`
- `9d8940821` `fix(responses): keep tool outputs adjacent`
