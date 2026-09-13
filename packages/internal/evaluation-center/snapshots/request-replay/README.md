# request-replay 快照语料（N-SNAPSHOT-REGRESSION / DSH P1-M2）

keyless 确定性假模型（`CODE_AGENT_E2E_LOCAL_AGENT_MODEL=1`）真会话的录制回放语料。
每条用例跑真 AgentLoop + StandaloneAgentAdapter，逐轮落：

```
<caseId>/
  index.json                 用例元信息：标题、覆盖工具路径、假模型 env、turn 清单
  ledger.json                账本消息（白名单字段，id 规范化 msg-NN，时间戳归零）
  blobs.json                 该用例全部内容寻址 blob（content/systemPrompts/toolSchemas）
  turn-NN/manifest.json      request_manifest（requestId/账本 id 规范化）
  turn-NN/canonical-request.json   重建请求的 canonical 字节（回放逐字节咬它）
  turn-NN/expected-response.json   假模型 canonical 响应（回放用当前假模型重推导再咬）
```

## 纪律

- **回放（默认，可进 PR CI）**：`npm run acceptance:snapshot-replay`
- **重录（覆写本目录）**：`npm run acceptance:snapshot-replay:record`
- 动了 `src/host/agent/runtime/contextAssembly/**`、`src/host/prompts/**`、
  `src/host/testing/e2e/**`、`requestReplay*.ts` 这类模型可见行为，必须同 PR
  重录——`scripts/ci/snapshot-replay-sync-gate.mjs` 守。
- 若改动确认行为不可见（注释/重命名），重录后字节无变化时，在本文件末尾
  「重录确认」追加一行说明（PR 号 + 原因）作为同 PR 快照目录更新。
- 生成器确定性：同机同代码重录必须字节一致（已双录验证）；id 全规范化、
  时间戳归零、家目录/仓路径擦洗成 `<HOME>`/`<REPO_ROOT>`/`<RECORD_DATA_DIR>`。
- 系统提示词的 `<session_metadata>` 块含会话计数、天然跨机不确定，录制时
  通过只读 memory 目录排掉；`Today's date` 随录制日变化属预期（重录即刷新）。

## 口径边界：往返一致 ≠ 与现场一致

录制器落盘后做一次当场回放自验，但录制与回放共用同一套重建/推导函数
（`reconstructRequest` / `deriveSnapshotResponse`），所以自验只证明
**往返一致**——manifest + 账本 + blob 能被同一份重建代码读回来；它**不**证明
**与现场一致**——不证明快照字节等于推理现场真实跨过引擎边界的那一份
（ai-review #1721 Nit 2）。

现场一致性由两道既有闸守，本目录不重复承担：

1. **生产录制侧**：`request_manifest` 在 `inference.ts` 记录的是实发视图，
   canonical 内容哈希对齐 `content_cache`；对不上即 degraded，录制器遇
   degraded 直接 fail-loud，不许带病入库。
2. **现场对照挂点**：`npm run acceptance:request-replay`
   （`scripts/acceptance/request-replay-smoke.ts`）把重建视图与 ModelRouter
   实发消息逐字节咬住，双向变异控制齐全。分工：它守「现场 vs 重建」，
   本快照体系守「跨时间重放」。

后续若要给快照本体加现场对照，挂点在 `deriveSnapshotResponse`：把录制时真
收到的 ModelResponse（需要可注入的 ModelRouter 包装点，目前不存在，为它可以
再动生产代码）与推导值并排落盘比对。

## 重录确认

（行为不可见改动在此追加：日期 / PR / 说明）
- 2026-09-11 / PR #1740 / `src/host/agent/runtime/contextAssembly/inference.ts` 的改动只调整 turn.streamedContent 的累加时机与 finish 时的清空顺序（abort 时留住半截正文），不改请求拼装。本机 `acceptance:snapshot-replay:record` 重录 6 会话 13 轮，与已提交快照的差异仅为环境字段：系统提示里的今日日期（09-08→09-11）与 `Default Shell`（bash→zsh），无任何消息或工具表内容漂移。
- 2026-09-13 / PR #1769 / `contextAssembly/shared.ts` 与 `contextAssembly/systemContextStack.ts` 只把两个预算字面量（system prompt 预算下限 6000、持久系统上下文 1200）改成经 `getHarnessKnob` 读取，默认值就是原字面量，无 profile 时逐字不变。本机 `acceptance:snapshot-replay:record` 重录 6 会话 13 轮，与已提交快照的差异只有 `今天的日期`（09-08→09-13）与 `Default Shell`（/bin/bash→/bin/zsh）两类环境字段，canonicalTools 仅日期串变化；`acceptance:snapshot-replay` 回放 13 轮字节级一致。
