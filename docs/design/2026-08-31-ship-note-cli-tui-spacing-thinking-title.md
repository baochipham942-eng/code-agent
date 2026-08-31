# Ship note: CLI TUI 行距收紧 + Thinking 闪烁根治 + 标签页会话标题

行距回摆：消息块 marginTop 2→1、去掉 paddingBottom，输入框去 paddingY（单行 composer 5 行→3 行）。
layout 成本常数同步（每条消息 overhead 3→1），预算分配语义不变。

Thinking… 闪烁：临时埋点（NEO_DEBUG_EVENTS）实测一轮「你好」211 个事件，reducer 层标签全程稳定，
闪源在渲染层——spinner 133ms 整帧重写 + 耗时 0.1s 粒度（这行每 100ms 必变一次）。
修法：spinner 降频 250ms、运行中计时改整秒（封口的 Thought for Xs 仍保留 0.1s）。
另一个真标签闪：「生成回复中」在最终文本到手后才发，只活 0.4s 就消失，并入 TRANSIENT_STEP 噪音抑制
（task_progress / agent_thinking 两通道，有标签时不许盖）。

终端标签标题（OSC 0）带会话标题：空闲显示标题，运行中 `活动 · 标题`，排队 `标题 · N queued`。
默认占位标题（CLI Session * / New Chat / 新对话）不展示，等 quick model 自动命名后才出现；
App 在 turn 边界/消息数变化时经 `agent.getSessionTitle()` 重取。
