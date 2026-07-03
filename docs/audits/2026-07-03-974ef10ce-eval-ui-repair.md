# Codex Audit Report — eval-ui-repair

**Date**: 2026-07-03
**Scope**: 1eb1b12d2..HEAD（chore/eval-ui-repair，10 commits）
**Starting commit**: 0ac28f995（审计启动时 HEAD）
**Rounds run**: 2 / 4
**Converged**: ✅ yes（Round 2 = 0 HIGH / 0 MED）

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     |  0   |  1  |  2  | 1352a9c2a  |
| 2     |  0   |  0  |  2  | 974ef10ce  |

## Findings by Round

### Round 1

#### 🟡 MEDIUM — Replay event block 带 durationMs 时丢 summary
**Finding**: 去重修复把 event 的 label 收敛为常量「事件」后，`formatBlockDetail` 的 durationMs 短路分支让事件摘要（如 "permission denied once"）在 timeline 里彻底不可见。
**Resolution**: ✅ fixed in 1352a9c2a — detail 改为 `summary（·时长）`组合，去重守卫保留；测试覆盖 summary+durationMs 双渲染。

#### 🟢 LOW — check-design-system.mjs 残留已删组件 CostCalendar 的可视化豁免
**Resolution**: ✅ fixed in 1352a9c2a（删除收尾遗漏，一行删除，扫描 exit 0）。

#### 🟢 LOW — Skills/Assets/Audit/Neo 标签硬编码英文
**Resolution**: ℹ️ recorded — 有意保留的产品名词（双语一致），归 i18n 欠账批。

### Round 2

#### 🟢 LOW — Replay timeline 非 event 分支从 90 字截断改成了全文渲染
**Finding**: 本批在改 detail 逻辑时把默认分支的 `truncateContent(…, 90)` 换成 `normalizeBlockText` 全文，超大 tool_result（transcript 路径 20k+）会整段灌进弹层。
**Resolution**: ✅ fixed in 974ef10ce — 恢复行内截断（160 字符），完整正文留给下钻视图；长内容测试锚定。

#### 🟢 LOW — tab 关闭按钮 title="关闭" 硬编码且无 aria-label
**Resolution**: ✅ fixed in 974ef10ce — 走 `common.close`，title+aria-label 双补。

### Round 2 复核通过项（艾克斯主动排查未立案）

- `/api/telemetry/health` web 路径：domain fallback 会还原成 `telemetry:health` 调已注册 handler，非缺路由。
- TaskPanel active-run 空态的 live 状态集合：`RunUiStatus` 全 8 值核对，无漏（error/failed/orphaned 归 blocked）。
- 删除完整性：TelemetryPanel barrel、useIsDeveloperMode 调用、CostCalendar 豁免全清。
- event 空 summary 且无 duration：生成端 `content` 兜底 `event_type`，不会渲染空 detail。

## Deferred Items
- 无。

## Convergence Analysis

Round 1 唯一 MED 是本批去重修复自身引入的回归（改 label 逻辑没追查 detail 分支的联动），Round 2 的 LOW 同样是这次改动的副作用（截断被顺手拿掉）——两轮都命中"fix 的兄弟路径"类，印证 symmetric application 是 Round N+1 的第一优先级。删除完整性、i18n 键同步、telemetry 加固三个重点审计维度两轮均未出 finding。
