# N-CTXPANEL · 分桶面板接回电 + 摘要独立成桶（决策与证据记录）

日期：2026-08-21 ｜ 工单：N-CTXPANEL（稳定线，爸 08-21 拍板开单）｜ 施工：基拉（Kimi CLI）｜ 基点：origin/main@461e7ca32

## 决策

1. **复用现成标记**：压缩摘要消息已有 `message.compaction`（`CompactionBlock`）标记，不新造。病 C 的根因是 `contextHealthService.update()` 的三个调用方在 map 消息时把该字段丢了，逐一补传。
2. **summary 是派生桶**：与 conversation 同口径——`update()` 每轮按摘要消息 content 的 `estimateTokens` 重算，不接受 `recordSourceContribution` 直接写入；conversation 扣减法同步排除 summary。
3. **明细入口复用不新造**：明细弹层（`ContextHealthDetailPopover`）直接挂载现成 `ContextHealthPanel`；ContextPanel 的 navigate/unload/compact 三个 handler 抽成 `useContextHealthActions` 共享 hook，ContextPanel 与弹层共用，逻辑零改动（原 compactAction 测试用例不改仍绿）。
4. **交互口径（爸 08-21 二轮+四轮拍板）**：hover 圆环出只读气泡（% + token 数 + 压缩反馈）；点击圆环展开**长在输入框上方的明细弹层**（`ContextHealthDetailPopover`，bottom-full 锚在圆环上，Cursor 同款不割裂形态——四轮拍板否掉了居中 modal）。分桶条、累计费用、压缩钮（≥70% 门槛不变）全部收进明细弹层；弹层关闭时清压缩反馈。🚫不恢复右栏 tab（守 #627 口径）。
5. **深链改落点**：`OPEN_CONTEXT_HEALTH_EVENT` 从「只开弹层」改为「直接开明细弹层」。
6. **分桶条**：bySource 七桶（rules/skills/mcp/subagents/fileReads/summary/conversation），在明细弹层顶部，0 值段不渲染；颜色用显式 zinc/accent 色（深浅主题都可读），不走主题变量。
7. **弹层内压缩入口唯一化**：弹层操作区承担压缩（≥70%），不再给面板传 `onCompact`，避免 critical 时操作区与面板内按钮重复。
8. **压缩摘要横幅降级（爸 08-21 三轮拍板）**：消息流里整条「上下文已压缩」横幅退役，降级为压缩点所在轮操作行（复制/点赞/点踩/分叉）最右端的 Archive 标记，点开仍可读摘要原文；操作行不渲染的轮（流式/语音在飞）降级为右对齐独立小行，信息不消失。
9. **CI 修复**：`hoverActionsKeyboardVisibility` 的 bySource fixture 补 `summary` 字段（契约新增必填字段导致 Swarm CI 的 tests typecheck ratchet 超基线）。
10. **明细弹层 Cursor 化（爸 08-21 五轮拍板）**：0 值桶不占位（`BreakdownItem`/`NestedGroup` tokens≤0 不渲染——全是 0 (0.0%) 的空桶占位看着就像数据坏了）；面板在弹层语境下 `hideHeader`+`hideProgressBar`，弹层标题栏 + 分桶总条 + 大数字行各就各位，不再有重复横条/重复头部。
11. **平铺清单定稿施工（爸 08-21 六轮拍板，按对比页 After 稿）**：弹层不再挂载 ContextHealthPanel，九桶平铺清单——组装序（系统提示→工具定义→规则→技能→连接器→子代理→文件读取→摘要→对话，与 prefix cache 命中方向同构、行序逐轮稳定）；聚合类目走 i18n（技能/连接器/子代理），不列具体挂载名、无跳转/卸载（覆盖工单验收①的「可跳转卸载」，面板的 NestedGroup 跳转卸载能力保留在组件里）；配色：摘要 rose / 系统提示浅灰 / 对话深灰 / 规则 teal / 挂载能力鲜色。设计稿：`code-agent-private-archive/docs/competitive/2026-08-21-cursor-vs-neo-context-panel.html`。

## 验收证据（私档 `code-agent-private-archive/docs/evidence/2026-08-21-N-CTXPANEL/`）

- 终版（六轮反馈后，构建指纹 kimi/N-CTXPANEL@fc97304）：`after-dark/` `after-light/`——九桶平铺清单真机（压缩会话=摘要 rose 408(32.6%) + 对话深灰 844(67.4%)，0 值桶不占位；未压缩对照=对话一行）。
- 五轮版（Cursor 化但未平铺，@9de42e5）：`final2-dark/` `final2-light/`——`01-bubble` hover 只读气泡；`02` 明细弹层 Cursor 化：大数字行 + 一条分桶总条 + 只列非零桶（压缩会话=摘要 408(32.6%) + 对话 844(67.4%)，未压缩对照=对话 840(100%) 一行）；`03`/`04` 压缩横幅消失、操作行最右端 Archive 标记点开读摘要原文。
- 四轮版（弹层刚落地、面板头部/进度条未让位，@3539e4c）：`popover-dark/` `popover-light/`，仅存档对照。
- 三轮版（横幅降级时还是居中 modal，@65c6e7f）：`marker-dark/` `marker-light/`，仅存档对照。
- 中间版（交互修正，@b1bba3f）：`final-dark/` `final-light/`，hover 气泡 + 点击开明细。
- 初版（交互修正前，@b91c6a7）：`dark/` `light/`，仅存档对照。
- 种子与驱动脚本：`seed-verify-session.py`（合成带/不带 compaction 标记的两条对照会话，零付费调用）、`take-shots.mjs`（playwright 驱动 web standalone :8182）。

## 验收点逐条

| 工单验收 | 结果 |
|---|---|
| ① 圆环入口见分桶条；明细见 bySource + 可跳转卸载 | ✅ 终版截图 01/02（交互按爸二轮口径：hover 气泡、点击开明细弹层） |
| ② context 深链落到明细 | ✅ 单测 + 代码路径（pill 监听直接 setDetailOpen） |
| ③ 压缩后摘要桶出现且数字=摘要消息估算 | ✅ 摘要桶 408 tok（32.6%）与 conversation 844 tok 分列 |
| ④ 反向变异：拆挂载点/去 summary 标记测试立红 | ✅ 实测变异：摘 modal 挂载 4 用例红、摘分桶条 1 用例红、去 host summary 检测红，均恢复 |
| ⑤ i18n zh/en 齐 | ✅ `chatI18nRatchet` 106 用例绿（顺手清了因交互修正变死的 viewDetails/windowLabel 两 key） |
| ⑥ 双主题截图 | ✅ final-dark/final-light 各两张 |

## 已知限制（留给后续，不阻塞本单）

- 「压了 N 轮」的 N 来自运行时压缩统计（autoCompressor），合成会话无运行时统计故截图显示 0 轮；真实压缩后 N 由 `compression.ts` 每轮回写，链路未改。
- 摘要消息 role=system 的每条约 4 token 角色开销仍留在 conversation 桶（量级可忽略）。
- 分桶条的占比相对「各桶合计」，明细面板 BreakdownItem 的占比相对 currentTokens，两处口径各自自洽。
- 气泡在浅色主题下仍是深色卡片（沿用原弹层既有设计语言，本单未改）。
- 未跑真实付费压缩调用（真机验收用合成数据驱动，零付费）。
