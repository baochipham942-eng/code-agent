# 语音批 X2：上游哑火看门狗交付报告

## 结论

已完成 transport 层 response 看门狗。上游连接仍存活、已提交用户轮次却迟迟没有创建响应时：

1. 等待 `VOICE_UPSTREAM_RESPONSE_TIMEOUT_MS`（10 秒）后发送一次 `response.create` nudge。
2. 再等待 10 秒仍无 `response.created`，发送用户可见的 `VOICE_MODEL_UNRESPONSIVE` notice。
3. 同一通电话只展示一次 notice，后续哑火仍会 nudge 和写日志。
4. 看门狗不会 teardown 通话，用户可重说或自行挂断重拨。

功能提交：`06bea80299a399f30d828594bf9cd13c51eac83d`

## 实现边界

- `input_audio_buffer.committed` 武装响应等待窗，覆盖 server VAD 自动提交与手动 commit 的上游回显。
- `response.created` 解除等待窗，正常快速响应不会产生额外动作。
- `input_audio_buffer.speech_started` 解除旧轮等待窗，用户抢话后不会对已作废轮次 nudge。
- `close()` 与 WebSocket `close` 都清理响应看门狗定时器。
- nudge 只发送 `response.create`，不创建 `conversation.item.create`，也不设置 `pendingInjectionAt`。
- 测试确认 nudge 后收到协议 error 会归类为普通 `UPSTREAM_ERROR`，不会误报 `injection.rejected`。
- 新增 `VOICE_MODEL_UNRESPONSIVE` 到 `VoiceMessageCode`，并补齐 renderer 中英文文案。

## 验证证据

### 提交前硬门

- `npm run typecheck`：通过。
- `git diff --check`：通过。
- `npx vitest run tests/unit/voiceTransportContract.test.ts`：1 个文件通过，22/22 条测试通过。

### 变异验证

变异均在功能提交后进行，验证结束已恢复到提交版本：

- 临时拆掉 `response.created` 与 `speech_started` 的看门狗解除调用：
  - 结果：2 条测试失败，20 条通过。
  - 失败用例：正常快速响应零动作、用户再次开口解除旧轮看门狗。
- 临时拆掉一通电话只提示一次的闸：
  - 结果：1 条测试失败，21 条通过。
  - 失败用例：第二个哑火轮产生第 2 条 notice，期望仍为 1 条。
- 恢复后重跑 transport 契约：22/22 通过。

### 全量单元测试

命令：`npx vitest run tests/unit`

- Test Files：1346 passed，1 skipped，合计 1347。
- Tests：12446 passed，26 todo，合计 12472。
- 失败：0。
- Vitest duration：369.93s。

## 交付状态

- 分支：`fix/voice-response-watchdog`
- 基线：`origin/main` 的 `b507625870d74a44eed16dffadfa584e7e544e4d`
- 未 push。
- 未开 PR。
