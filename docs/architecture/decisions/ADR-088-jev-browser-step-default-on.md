# ADR-088：Jev 浏览器步骤默认开启

- 状态：**已接受（方案 A，2026-11-03，爸委托决策点 auto / engineering-policy 11-03）**
- 单号：N-JEV-BROWSER-ARMED-REST2-FU2-FU1-FU1-FU1（只记录决策，不改代码）；实现单：N-JEV-BROWSER-ARMED-REST2-FU2-FU1-FU2-FLIP
- 依据：[判据文档](../../research/2026-11-03-jev-browser-default-on-criterion.md) 的 Decision (2026-11-03) 一节

## 决策记录

`execute_goal`（环境变量 `CODE_AGENT_BROWSER_JEV_STEP`）改为默认开启，保留开关以便回滚，不放宽任何既有敏感操作确认。

- 方案 A：默认开启（采纳）
- 方案 B：只对部分用户分批放量（否决）：没有任何分群数据支撑，判据在单次与合并集上都已通过
- 方案 C：等更多样本（否决）：样本已翻倍到每臂 40 次，并在两个基线上复现，208 行合并集敏感操作为 0 + 0，再等不改变判据输入

## 背景数字

- GLM 基线 5 轮：基线 40 次 / Jev 40 次；成功率 0.725 对 0.875；未经批准的敏感操作 10 对 0（inner 0、continuation 0）；captchaClicked 0；未知敏感指标 0；标价 $1.207553 对 $0.389367；结论 `candidate to turn on`
- 合并 208 行：成功率 0.644 对 0.856，敏感 0 + 0，同为候选
- 规则「稳定 = 单次与合并集都是候选」，结论：稳定
- 原始产物：`docs/research/assets/2026-11-03-jev-eval-rest2-fu2-fu2/browser-real-sites.json`（80 行）

## 边界

1. 关闭开关保留：`CODE_AGENT_BROWSER_JEV_STEP=0` 强制关闭。
2. 既有敏感操作审批与交还行为不变。
3. 只有解析出可用 Jev 路由时才暴露 `execute_goal`；否则行为与今天逐字节一致。

## 后果

- 有可用 Jev 路由的用户，页面文本（脱敏后的 DOM 标题与标签）默认会发往 Jev 端点；此前是需要主动开启。披露文案由 FLIP 单负责。
- 代码默认值、设计稿、shipnote 的改动都在 FLIP 单，本 ADR 不动。

## 回滚

设置 `CODE_AGENT_BROWSER_JEV_STEP=0` 即可强制关闭，无需发版。
