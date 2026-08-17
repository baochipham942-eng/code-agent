# N-L7-SAYDO3 施工证据

## 基线与边界

- 分支：`l7/saydo3`
- 开工 HEAD / `origin/main`：`33b4ea84cc59109ab37b5d753302b7ae14898c8c`
- 开工工作树：干净
- `wtready`：首次因主仓共享 `node_modules` 的 4 个 Shiki 版本漂移退出 1；改为 worktree 内实体依赖后全 PASS，退出 0
- `npm ci`：首次写用户级 npm cache 被 workspace-write 沙箱以 `EPERM` 拒绝；使用 `/tmp/saydo3-npm-cache` 后完成。该 `EPERM` 是工单声明的边界，没有写主仓或重试写沙箱外路径
- 磁盘：开工可用 7.9 GiB；安装依赖后 7.1 GiB；清理本单临时目录后 9.6 GiB，始终未跌破 5 GiB 停工线
- 未运行 `voice-eval`、付费语音调用或 replay；未碰 `fleet`、`ship`、主仓和其他 worktree

## 落地形状

1. `voiceSayDoGuard` 复用既有 `hasExplicitExecutionClaim(assistantText)`，把工具观察分成：
   - 有工具、无执行声称：保持 `skip: 'tool_observed'`
   - 有工具、有执行声称：产生 `remove_context_pollution`，把对应 assistant item 交给 transport 延迟删除
   - 无工具、有执行声称：保持既有分类器 / 确定性兜底补派路径
   - 无工具、无执行声称：保持 `normal`
2. 新增 `assistantContextSanitizer.ts` 管理待删 assistant item；`realtimeTransport` 只在下一轮用户 ASR final 已到、Host 调用 `respond()` 明确请求回复时，先发 `conversation.item.delete`，再发 `response.create`。没有在旧 `response.done` 当刻删除。
3. `voiceSessionService` 将 assistant `itemId` 交给 guard，并把 guard 判出的污染项排进 relay transport。
4. 删除帧真正发出后记录既有语音审计日志事件 `voice say/do context pollution removed`；`voiceCallAudit` 将它纳入 N-L7-AUDIT 的 `sayDo` 段，没有另建审计系统。

审计事件关键内容：

```json
{
  "summary": "本轮模型违规输出执行声称，已从上游对话上下文剔除",
  "violation": "execution_claim_with_tool_call",
  "action": "assistant_item_removed_from_upstream_context"
}
```

该事件与正常派单的 `action: host_routed_delegate_task` 可直接区分。

## 分支与时序测试

定向测试命令：

```text
TMPDIR=/tmp/saydo3-vitest node_modules/.bin/vitest run \
  tests/unit/voiceSayDoGuard.test.ts \
  tests/unit/voiceTransportContract.test.ts \
  tests/unit/voiceCallAudit.test.ts \
  tests/unit/voiceSessionService.instructions.test.ts
```

结果：4 个文件、81 条测试全部通过，退出 0。Vitest 临时目录随后删除。

Guard 四个行为格各有 1 条直接断言通过：

| 行为格 | 直接断言 | 结果 |
|---|---|---|
| 有工具 + 无执行声称 | 不跑分类器、不补派、不排队删除 | 1/1 通过 |
| 有工具 + 有执行声称 | 排队删除 assistant item；删除回调后落审计 | 1/1 通过 |
| 无工具 + 有执行声称 | 既有 `SAY_GAP` 路径只补派一次 | 1/1 通过 |
| 无工具 + 无执行声称 | 既有 `NORMAL` 路径不补派、不删除 | 1/1 通过 |

另有两条接线证据：

- transport 时序测试证明：旧 `response.done` 后不删，当前用户 ASR final 单独到达仍不删；Host `respond()` 后才按 `conversation.item.delete` → `response.create` 顺序发送。
- session 测试证明：同轮原生工具调用与执行声称并存时，真实 assistant `itemId` 被交给 transport 删除队列。

## 反向变异

临时把新分支恢复成：

```ts
if (state.toolObservedVersion === auditedVersion) return { kind: 'skip', reason: 'tool_observed' };
```

运行 `tests/unit/voiceSayDoGuard.test.ts`，真实结果为退出 1，15 条中 1 条失败：

```text
有工具调用且有执行声称时排队剔除 assistant item，并在真正删除后留审计事件
AssertionError: expected queueAssistantItemDeletion to be called with
['a-polluted', Any<Function>]
Number of calls: 0
```

随后恢复生产分支，四文件定向测试再次 81/81 通过，退出 0。

## 五道本地门

| 门 | 有效结果 |
|---|---:|
| `node scripts/eslint-ratchet.mjs` | `EXIT=0`（3187 文件，0 errors，414 warnings，均持平） |
| `node scripts/check-design-system.mjs` | `EXIT=0` |
| `node scripts/knip-ratchet.mjs` | `EXIT=0`（2623 符号，未新增） |
| `node scripts/knip-ratchet.mjs --profile production` | `EXIT=0`（3867 符号、125 个生产不可达文件，均未新增） |
| `node scripts/tsc-tests-ratchet.mjs` | `EXIT=0`（tests+scripts TypeScript errors 0） |

失败也入账：

- eslint 首轮在实现尚未收口时真实 `EXIT=1`，命中 `realtimeTransport.ts` 与 `voiceSessionService.ts` 的既有 1000 行上限；把队列收进生产可达模块并压缩调用点后，最终有效门 `EXIT=0`。
- knip 首轮因用户级 npm cache 写入被沙箱拒绝，真实 `EXIT=1`，没有产生有效扫描；改用 `/tmp/saydo3-npm-cache` 后两档均 `EXIT=0`。没有修改 knip 基线。

## 禁区核对

- 未修改 `voiceRouting.ts` instructions，也未增加第四遍嘱咐。
- 未增加第二层补派 guard；无工具路径保持原实现。
- 未修改 `detectVoiceReceptionAmbiguity`、WAIT 或轮 1/2 追问行为。
- 未放宽断言、门槛或 knip 基线。
- 未进行 live 行为验证或任何付费调用。
