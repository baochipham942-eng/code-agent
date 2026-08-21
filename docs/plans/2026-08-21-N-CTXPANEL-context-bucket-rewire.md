# N-CTXPANEL · 分桶面板接回电 + 摘要独立成桶（决策与证据记录）

日期：2026-08-21 ｜ 工单：N-CTXPANEL（稳定线，爸 08-21 拍板开单）｜ 施工：基拉（Kimi CLI）｜ 基点：origin/main@461e7ca32

## 决策

1. **复用现成标记**：压缩摘要消息已有 `message.compaction`（`CompactionBlock`）标记，不新造。病 C 的根因是 `contextHealthService.update()` 的三个调用方在 map 消息时把该字段丢了，逐一补传。
2. **summary 是派生桶**：与 conversation 同口径——`update()` 每轮按摘要消息 content 的 `estimateTokens` 重算，不接受 `recordSourceContribution` 直接写入；conversation 扣减法同步排除 summary。
3. **明细入口复用不新造**：明细 modal（`ContextHealthDetailModal`）直接挂载现成 `ContextHealthPanel`；ContextPanel 的 navigate/unload/compact 三个 handler 抽成 `useContextHealthActions` 共享 hook，ContextPanel 与 modal 共用，逻辑零改动（原 compactAction 测试用例不改仍绿）。
4. **交互口径（爸 08-21 二轮拍板）**：hover 圆环出只读气泡（% + token 数 + 压缩反馈），点击圆环直接展开明细窗口——原弹层里的「查看明细」按钮退役，点击链路少一跳。分桶条、累计费用、压缩钮（≥70% 门槛不变）全部收进明细 modal；modal 关闭时清压缩反馈。🚫不恢复右栏 tab（守 #627 口径）。
5. **深链改落点**：`OPEN_CONTEXT_HEALTH_EVENT` 从「只开弹层」改为「直接开明细 modal」。
6. **分桶条**：bySource 七桶（rules/skills/mcp/subagents/fileReads/summary/conversation），在明细 modal 顶部，0 值段不渲染；颜色用显式 zinc/accent 色（深浅主题都可读），不走主题变量。
7. **modal 内压缩入口唯一化**：modal 操作区承担压缩（≥70%），不再给面板传 `onCompact`，避免 critical 时操作区与面板内按钮重复。
8. **压缩摘要横幅降级（爸 08-21 三轮拍板）**：消息流里整条「上下文已压缩」横幅退役，降级为压缩点所在轮操作行（复制/点赞/点踩/分叉）最右端的 Archive 标记，点开仍可读摘要原文；操作行不渲染的轮（流式/语音在飞）降级为右对齐独立小行，信息不消失。
9. **CI 修复**：`hoverActionsKeyboardVisibility` 的 bySource fixture 补 `summary` 字段（契约新增必填字段导致 Swarm CI 的 tests typecheck ratchet 超基线）。

## 验收证据（私档 `code-agent-private-archive/docs/evidence/2026-08-21-N-CTXPANEL/`）

- 终版（三轮反馈后，构建指纹 kimi/N-CTXPANEL@65c6e7f）：`marker-dark/` `marker-light/`——`03-marker-action-row` 横幅消失、标记在操作行最右端；`04-marker-expanded` 点开标记读摘要原文；`05-clean-session-modal` 未压缩对照会话明细无摘要桶（对话 100%），与压缩会话（摘要 32.6%）对照证明「压缩完成后面板直接看出变化」。
- 中间版（交互修正，@b1bba3f）：`final-dark/` `final-light/`，hover 气泡 + 点击开明细。
- 初版（交互修正前，@b91c6a7）：`dark/` `light/`，仅存档对照。
- 种子与驱动脚本：`seed-verify-session.py`（合成带/不带 compaction 标记的两条对照会话，零付费调用）、`take-shots.mjs`（playwright 驱动 web standalone :8182）。

## 验收点逐条

| 工单验收 | 结果 |
|---|---|
| ① 圆环入口见分桶条；明细见 bySource + 可跳转卸载 | ✅ 终版截图 01/02（交互按爸二轮口径：hover 气泡、点击开明细） |
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
