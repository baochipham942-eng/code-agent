# N-CTXPANEL · 分桶面板接回电 + 摘要独立成桶（决策与证据记录）

日期：2026-08-21 ｜ 工单：N-CTXPANEL（稳定线，爸 08-21 拍板开单）｜ 施工：基拉（Kimi CLI）｜ 基点：origin/main@461e7ca32

## 决策

1. **复用现成标记**：压缩摘要消息已有 `message.compaction`（`CompactionBlock`）标记，不新造。病 C 的根因是 `contextHealthService.update()` 的三个调用方在 map 消息时把该字段丢了，逐一补传。
2. **summary 是派生桶**：与 conversation 同口径——`update()` 每轮按摘要消息 content 的 `estimateTokens` 重算，不接受 `recordSourceContribution` 直接写入；conversation 扣减法同步排除 summary。
3. **明细入口复用不新造**：弹层「查看明细」打开的 modal 直接挂载现成 `ContextHealthPanel`；ContextPanel 的 navigate/unload/compact 三个 handler 抽成 `useContextHealthActions` 共享 hook，ContextPanel 与 modal 共用，逻辑零改动（原 compactAction 测试 7 用例不改仍绿）。
4. **深链改落点**：`OPEN_CONTEXT_HEALTH_EVENT` 从「只开弹层」改为「直接开明细 modal」。🚫不恢复右栏 tab（守 #627 口径）。
5. **弹层分桶条**：bySource 七桶（rules/skills/mcp/subagents/fileReads/summary/conversation），0 值段不渲染；颜色用显式 zinc/accent 色，与弹层既有固定深色语言一致，不引入主题变量。

## 验收证据（私档 `code-agent-private-archive/docs/evidence/2026-08-21-N-CTXPANEL/`）

- `dark/01-popover.png` `dark/02-detail-modal.png` `light/01-popover.png` `light/02-detail-modal.png`：真机（Agent Neo Dev 2，构建指纹 kimi/N-CTXPANEL@b91c6a7）hover 圆环见分桶条，点「查看明细」见明细 modal，bySource 区出现「摘要（压了 N 轮）」桶，数字 408 tok = 摘要消息估算。
- 种子与驱动脚本：`seed-verify-session.py`（合成带 compaction 标记消息的会话，零付费调用）、`take-shots.mjs`（playwright 驱动 web standalone :8182）。

## 验收点逐条

| 工单验收 | 结果 |
|---|---|
| ① hover 圆环见分桶条；查看明细见 bySource + 可跳转卸载 | ✅ 截图 01/02 |
| ② context 深链落到明细 | ✅ 单测 + 代码路径（pill 监听直接 setDetailOpen） |
| ③ 压缩后摘要桶出现且数字=摘要消息估算 | ✅ 摘要桶 408 tok（32.6%）与 conversation 844 tok 分列 |
| ④ 反向变异：拆挂载点/去 summary 标记测试立红 | ✅ 实测 4 处变异均按预期红后恢复 |
| ⑤ i18n zh/en 齐 | ✅ `chatI18nRatchet` 106 用例绿 |
| ⑥ 双主题截图 | ✅ dark/light 各两张 |

## 已知限制（留给后续，不阻塞本单）

- 「压了 N 轮」的 N 来自运行时压缩统计（autoCompressor），合成会话无运行时统计故截图显示 0 轮；真实压缩后 N 由 `compression.ts` 每轮回写，链路未改。
- 摘要消息 role=system 的每条约 4 token 角色开销仍留在 conversation 桶（量级可忽略）。
- 弹层分桶条的占比相对「各桶合计」，明细面板 BreakdownItem 的占比相对 currentTokens，两处口径各自自洽。
- 弹层在浅色主题下仍是深色卡片（既有设计语言，本单未改）。
- 未跑真实付费压缩调用（真机验收用合成数据驱动，零付费）。
