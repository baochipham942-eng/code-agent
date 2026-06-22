# Codex Audit Report — design-video-paid-path

**Date**: 2026-06-22
**Scope**: `735fd76f3..HEAD`（P2 视频 Task 3 service + Task 4 IPC 的付费链路）
**Starting commit**: cebc53c3b（审计时 HEAD，后续 hardening 落于 f2e0faa92）
**Rounds run**: 1 / 4（独立反方审查充分，1 轮收敛）
**Converged**: ✅ yes
**Reviewer**: 因 Codex CLI 当晚不稳定（流式 reasoning 截断 2 次 + gpt-5.5 回退 gpt-5.4，始终未吐出结构化 findings），按 `infra_codex_exec_cli_flakiness` 既定 fallback 改用**独立 fresh-context Claude skeptic（opus）**作反方律师，覆盖同样 8 维攻击面。Codex 流式输出中确实命中一条线索（上游错误 body 拼进 Error.message → renderer），已纳入 skeptic 复核。

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     |  0   |  4  |  5  | f2e0faa92  |

付费路径整体**守门严密**：无「guard 拒绝前付费 fetch 已发」的泄漏路径；SSRF 守卫已应用于 video_url 下载；outputPath/baseImagePath 双路径越界守卫齐全；costCny 取 service 真实回传的 actualModel+durationSec（非请求参数）；API key 在 Authorization header，不随错误 body 泄漏。

## Findings by Round

### Round 1

#### 🟡 MEDIUM (a) — 提交即终态被吞，丢失审核 message
**Finding**: `submitAndPollWanxVideo` 提交后仅检查 `!taskId`。DashScope 可在提交时返回 HTTP 200 + `output.task_status:'FAILED'`（如内容审核拒绝）+ message，旧逻辑要么误抛「未返回 task_id」，要么 sleep 后去轮询一个空 id。属沿袭自图像路径 `submitAndPollWanx` 的同款行为（非本次新引入）。
**Resolution**: ✅ fixed in f2e0faa92。解析提交响应后、`!taskId` 检查前插入终态守卫：FAILED/CANCELED/UNKNOWN 立即抛出带 message 的错误（省一次无谓轮询往返）；极少见的「提交即 SUCCEEDED 且有 url」优雅返回。TDD：先写失败测试「提交即 FAILED 抛 message 且不轮询」→ 实现 → 绿。
**Symmetric note**: 图像兄弟路径有同款模式但已合并/超范围，本轮不动，仅记录。

#### 🟡 MEDIUM (b) — costCny 以「权威」姿态呈现，但单价是估值（视频按秒，误差随时长放大到 ¥10.5）
**Finding**: `VIDEO_PRICING_CNY_PER_SEC` 注释自承「官方未披露单价，保守上界估值」。视频按秒计费、wan2.7-t2v 可 clamp 到 15s，UI 可能显示 `0.7×15=¥10.5` 像事实。比图像（固定 ¥0.14/张、误差有界）更敏感。
**Resolution**: ℹ️ 设计层已缓释，不改代码。① Task 7/8 的 UI 层显式用「预估/成本预估」措辞 + 生成前 confirm 框（spec D3 要求），不以事实姿态呈现；② Task 8 付费 dogfood 明确以真实账单校正价表。新增 `isEstimate` 标志仅给视频会与图像路径不对称，YAGNI，不加。
**Why defer**: 整条视频成本本质即估值，缓释落在表达层 + dogfood 校正闭环，符合 spec。

#### 🟡 MEDIUM (c) — 轮询失败路径无测试覆盖
**Finding**: 最脆弱的 while 轮询（`!ok continue` / 终态 / 「SUCCEEDED 但无 video_url」/ 提交 !ok）此前仅测了立即 SUCCEEDED + 立即 FAILED。
**Resolution**: ✅ 补测 in f2e0faa92（CANCELED、UNKNOWN、SUCCEEDED-无 url、提交 HTTP !ok 四例）。四例均对**现有代码**直接通过——是覆盖缺口而非逻辑缺口，锁定既有正确行为。abort/总超时需 fake timers，价值/复杂度比偏低，本轮不补。
**Why**: 现有轮询逻辑（deadline 每轮重算、sleep 在 poll 前故 !ok 不忙等、终态齐全）经审查确认正确。

#### 🟡 MEDIUM (d) — 无测试守「costCny 用 service 时长而非请求时长」
**Finding**: 若回归把 costCny 错接 `payload.durationSec`（未 clamp 的请求值），现有测试不会发现。
**Resolution**: ✅ 补测 in f2e0faa92：请求 99s、service 回传 5s，断言 costCny == 价表×5。验证现有 IPC 实现**已**用 service 回传值（destructured `durationSec`），非缺陷，仅加回归守卫。

## LOW Findings (informational, no commit)
- 未知终态状态会轮询到总超时（10min）才抛——每次轮询免费，仅延迟；family-wide（图像路径同）。
- `assertWithinDesignDir` 仅词法判断，design/ 内的 symlink 可逃逸（readFile 跟随软链）——pre-existing family-wide（audit M1 已界定范围），本地 renderer 威胁模型下可接受，未来可 `fs.realpath` 全家族加固。
- 上游错误 body 拼进 Error.message 回 renderer——key 在 header 不泄漏、与图像路径documented 行为一致；仅 request_id 等略显粗糙，LOW。
- `200` + 非 JSON body（代理 HTML 错误页）会抛不友好的 SyntaxError——family-wide，可 try/catch 美化。
- `wanx2.1-i2v-turbo` 固定 5s 上限——若真实模型支持更长则用户预期落差；按 DashScope i2v 文档「wan2.2/wanx2.1 部分模型固定 5s」属实，MVP 接受。

## Convergence Analysis
1 轮收敛。0 HIGH 是因作者已内化前序审计教训（M1 路径越界、付费 no-op 闸），双层守门（handler belt + service suspenders）正确。4 个 MED 中：1 个真修（a，且属继承自图像路径的潜伏行为——印证「移植代码 Round 1 应显式审上游行为本身」）、1 个设计层缓释（b，本次唯一比图像路径更严重处，落在表达层+dogfood）、2 个为覆盖缺口（c/d，现有逻辑本已正确）。无假阳性。Codex CLI 不稳定，改用独立 Claude skeptic 完成反方审查——独立 context 价值得以保留。
