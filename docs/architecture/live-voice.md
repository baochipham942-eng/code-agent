# Live Voice 架构

> As-built 基线：2026-08-05。会话级产品语义由 [ADR-054](./decisions/ADR-054-session-as-command-center.md) 约束；权限沿用 [ADR-053](./decisions/ADR-053-live-voice-permission-follows-session.md)。

## 1. 会话内的职责

实时语音是会话指挥台的第二种输入方式。文字与语音共用 `SessionTaskService`、任务槽位、审批回注、状态投影和 steer/stop 控制，不各自维护任务队列。前台通话只负责听说、字幕和窄工具派活；耗时执行进入后台槽位，用户可以继续发文字或讲话。

`voiceCallBridge.ts` 是 Renderer 对媒体 WebSocket 的唯一消费者，`voiceCallStore.ts` 是通话 UI 的单一状态源。字幕只由 Host 落库，Renderer 的 partial 只负责播放期间的临时揭示。

## 2. 随时开口

`voice.callToggle` 保持高级风险能力且默认不绑定。设置 → 语音 → 实时语音提供绑定引导：

1. 用户点“按下要绑定的快捷键”；
2. `eventToAccelerator` 归一化按键；
3. `detectKeybindingConflicts` 和 `detectKeybindingSystemWarnings` 在写设置前检查应用内冲突与系统保留键；
4. 无冲突才持久化并触发全局快捷键重新注册；
5. 再次触发同一个动作会结束当前通话。

默认空绑定是安全边界，升级不会替用户抢占系统快捷键。

## 3. 用量、预估成本与单通上限

上游在 `response.done.usage` 返回按模态拆分的 token。Host 归一化为 `VoiceTokenUsage`，Renderer 按通话累计并调用 `estimateRealtimeVoiceCost`。价格只从 `REALTIME_VOICE_PRICING_PER_1M` 读取；没有可审计价目的模型显示“预估 —”，也不执行金额上限。

当前 Qwen3.5 Omni Flash Realtime 使用阿里云百炼北京地域刊例价。金额是刊例估算，不代替供应商账单；多轮对话的历史上下文会被上游重复计入输入 token，UI 按上游已报告 usage 累计，因此不再用通话分钟数猜费用。

`VoiceLiveSettings.callCostLimit` 是单通金额上限，`callCostLimitAction` 有两档：

- `warn`：默认，到限时只提醒，通话继续；
- `hangup`：用户显式选择后，到限提醒并调用同一 `hangUp()` 收尾链。

上限每通在 `dialStarted` 后重新装载，首次跨线只提醒一次。未知价格和缺失 usage 都 fail-open 到“继续通话但不显示伪金额”，不会把未知当成 0。

## 4. 验收锚点

- 共享价表与计算：`src/shared/constants/pricing.ts`、`src/shared/pricing/estimateRealtimeVoiceCost.ts`
- 通话累计与到限动作：`src/renderer/services/voiceCallBridge.ts`、`src/renderer/stores/voiceCallStore.ts`
- 时长和金额：`src/renderer/components/features/voice/VoiceChrome.tsx`
- 快捷键引导与限额设置：`src/renderer/components/features/settings/tabs/VoiceLiveSettingsSection.tsx`
- 协议用量真源：`src/shared/contract/voice.ts`

静态和 hermetic 测试只能证明合同与事件投影；发布验收还要在真实运行时完成快捷键注册/唤起、真实 `response.done.usage` 金额更新、到限提醒和可选自动挂断。
