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

## 重录确认

（行为不可见改动在此追加：日期 / PR / 说明）
