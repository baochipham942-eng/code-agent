# ADR-054：会话=指挥台——前台永不被执行占用，文字与语音统一到同一套派活语义

- 状态：accepted
- 日期：2026-08-04
- 取代：C1/C2 批的 `queued_next_turn` 默认语义（2026-07-31，仅取代其「等前台 run 结束再作为下一轮发出」的 UX 语义，底层投递基建保留并改名分，见下）
- 关联调研：`code-agent-private-archive/docs/competitive/qwen-audio-agent-借鉴清单.md`（含拍板记录）

## 背景

Neo 当前存在两套「会话」语义：

- **语音路已是指挥台**：`voiceAgentCoordinator` 只产 Intent（即答/派活/steer/取消/查状态），执行走 TaskManager 后台，进度以 `[BACKEND]` 注入播报，通话永不因任务阻塞。
- **文字路是工作线程**：run 进行中新消息走 `queued_next_turn` 排队（`useAgentIPC.ts` `queueForNextTurn`），会话被执行占用。

同一产品，用户换个输入方式，「会话」的含义就变了。竞品 qwen-audio-agent（阿里 Qwen 团队，前台 7 工具 + spawn 即接即转后台 FIFO）的调研照亮了这一不对齐。产品负责人 2026-08-04 拍板：**聊天式 agent 价值太低，Neo 的会话统一为指挥台**——这与对标 Manus 的产物主轴同向。

## 决策

1. **前台 brain = 前台 turn 本身**。文字消息照旧由主模型流式响应（秒回不变），但给它窄工具面（`spawn_task` / `steer_task` / `cancel_task` / `task_status`），在本 turn 内要么直接答、要么移交后台并口头/文字预告。不加独立分诊模型，不用纯规则分诊；语音路四档分诊 prompt 移植到文字侧。
2. **执行全部走账本任务**。每件活 = backgroundTaskLedger 一条任务（内部可 swarm 子 agent），任务终态写入会话消息记录（供指代消解与追问），结果经既有四通路回流（注入会话 / 通话播报 / 系统通知 / 飞书 TG）。
3. **多槽并发**：通话与文字会话均支持多件活并行。并发上限进 `shared/constants`：全局 4、每会话 2（采用 qwen-audio-agent 生产验证值，其 `task-scheduler.mjs` 硬顶同为 4/2）。同主题后续任务经 **lane 串行**（laneKey + laneLimit=1，防「改 v2 的活和 v1 打架」）；spawn 带 **submissionKey 幂等**（同轮重复工具调用返回既有任务，不重复派活）。每任务有模型起的**短名**，播报、指代、取消一律用短名。
4. **输入分发 = 模型判断**：后台有活时用户新输入，由 brain 判定是 steer 某件活、新任务、还是即答；歧义时走**既有 askUserQuestion 工具**确认——文字渲染为现有选项卡，语音渲染为模型把问题念出来、用户语音回答映射到选项。不新造确认交互。
5. **`queued_next_turn` UX 语义退役，投递基建保留并改名分**（2026-08-04 专项调研定论）：
   - **退役删除**：renderer `queueForNextTurn` 分支、契约里的 `delivery: 'queued_next_turn'` 标记、「排队中/立即发送」UI、drain 的「会话 idle 才触发」语义。
   - **保留（steer 的内脏，非兼容分支）**：`steerOrQueue`（收口在 `agentOrchestrator.ts`，语音 steer_task 最终也走它）、`QueuedInputRepository`、`queuePendingSteerMessagesOrWarn`（取消/打断时消息保全）、drain 泵（重试上限+失败告警+重启扫描）。统一名分为**输入投递层**（deliver-or-buffer）：向任何 run 投递消息，投不进就缓冲，可投即投。
   - **brain turn 流式中的连发**：走同一投递层（brain turn 也是 run）——能 steer 就并入当前思考，不能就缓冲数秒后自动投递，无用户可见排队态。
   - **目标任务已终态时缓冲区内未投递的 steer 消息**：不静默丢、不自动转新任务——带任务终态上下文回流给前台 brain 判断，歧义走 askUserQuestion。
6. **迁移：直接切，不灰度，不留回滚 flag**（研发期禁兼容分支；回滚 = git revert）。存量会话零数据迁移，新语义只作用于新 run。

## 不做 / 边界

- 不实现 ACP（server 或 client）；外接 Agent 维持 CLI stream-json 路线。
- 不学 qwen-audio-agent 的「无 steer」（其只能取消重派）与「重启即 fail 活跃任务」（Neo recoveryPlan 保留）。
- 不做悬浮球 / always-on-top 独立小窗；「随时开口」靠既有托盘 + 全局热键的入口显性化（onboarding 引导绑键）解决。
- 通话内播报仍受叙述队列节流与发言人协议约束；多槽不改变「用户说话时压住播报」的优先级。

## 后果

- 文字与语音共享同一会话内核（brain 分诊 + 账本任务 + 投递层 + 回流），概念从「排队语义 + steer 缓冲」两个收敛为一个。
- 播报回流升级为送达确认制（播放开始才算送达 + 指数退避，参考 qwen-audio-agent `announcement-manager.mjs` 语义），修复现状「注入被拒重试 1 次即丢」（`voiceNarrationQueue.ts`）。
- 实施拆四批，工单见 `code-agent-private-archive/docs/plans/2026-08-04-会话指挥台四批工单.md`。
