# Adversarial Audit Report — design-model-switcher P1 backend

**Date**: 2026-06-21
**Scope**: `origin/main..HEAD`（高风险后端簇：注册表 / gptimage engine / 价表 / SSRF 守卫 / model 路由 / listVisualImageModels IPC）
**Starting commit (audited)**: ebe8fbaf → 修复后 HEAD dee064c16
**Reviewer**: 独立 fresh-context 子 agent（对抗式反方律师）。
**Codex 路径**: 尝试 `/codex-audit` 真 codex CLI，Round 1 跑满 600s 产出 0 字节（已知 codex-exec 长任务挂起，见 `infra_codex_exec_cli_flakiness`）→ 按 codex-audit skill 指定的 fallback 改用独立子 agent 当反方。
**Rounds run**: 1（per-task 两段审查 + 1 轮 holistic 簇审）
**Converged**: ✅ yes（0 HIGH；MED 已修；2 LOW 信息项）

## Summary

| 阶段 | HIGH | MED | LOW | 处置 |
|------|------|-----|-----|------|
| per-task 审查（Task 9 质量） | 0 | 2 | 1 | 全修（错误体透出 / 测试隔离 config / slot 注释），commit e00b77c9 |
| per-task 审查（Task 10 安全） | 1 | 1 | 0 | 全修（IPv6 字面量 SSRF 绕过 + 公网域名误杀 + IPv4-mapped），commit 3a29b3dc |
| holistic 簇审（本轮） | 0 | 1 | 2 | MED 已修 commit dee064c16；2 LOW 信息项不改 |

## Holistic 簇审发现（origin/main..HEAD）

逐区结论：**A SSRF 对称应用 / B 计费正确性 / C engine 枚举穷尽 / D key 信任边界** 全部 clean。

### 🟡 MEDIUM — 空白 prompt 触发付费空调用（已修）
`handleGenerateDesignImage` 原仅拦空字符串 prompt（`!payload?.prompt`），`"   "` 为 truthy 通过，wanx/gptimage 用 raw prompt 直发，触发真实 ¥0.14/¥0.25 无意义出图。renderer 的 `generate` 已 `trim()`，故只伤直连 IPC / 未来调用方 → 定 MED。
**Resolution**: ✅ fixed `dee064c16` — 主进程兜底 `!payload?.prompt?.trim()`，新增测试断言空白 prompt 抛错且 `generateImage` 0 次调用。

### 🟢 LOW（信息项，不改）
1. gptimage 取 `GPTIMAGE_PROXY_BASE` 配置 base 发请求未过 `isSafeImageUrl` — 但该 base 是用户 BYOK 配置（env/config），非模型响应，不在 SSRF 威胁模型内（威胁是恶意**模型响应**指向内网）。可接受。
2. gptimage `resp.json()` 解为 untyped `any` 再读 `data[0].b64_json` — 抛错被 IPC try/catch 兜住，安全，但与文件内 zhipu/openrouter/wanx 的 `isRecord`/`parse*` 守卫风格不一致。可选对齐，非必须。

## 关键正向确认（反方逐项核实）

- **SSRF 对称覆盖**：枚举全部 url 下载点（downloadImageAsBase64 / wanx t2i+edit+expand+removeWatermark 结果 url / cogview / flux / gptimage），**唯一下载入口是 downloadImageAsBase64，守卫是其首条语句**，无 fetch-before-guard、无旁路。gptimage 走 inline b64 无 url 下载。
- **计费对齐**：4 engine 的 actualModel 全部命中价表显式键（wanx 0.14 / cogview-4-250304 0.06 / gpt-image-2 0.25 / flux.2-klein-4b 0.10），无一回落 default。
- **engine 穷尽**：`ImageEngine` 与注册表 `ImageEngineId` 一致（wanx|cogview|flux|gptimage）；`generateImage` 四分支全覆盖；旧消费者（illustrationAgent / imageGenerate）只经 `determineImageEngine()` 取 cogview|flux，新增 gptimage 不影响其 else 分支。
- **key 边界**：`handleListVisualImageModels` 仅返回 `{id,label,provider,available:boolean}`，`providerKeyConfigured` 全 `!!` 布尔化；新代码 0 处 console/logger，gptimage key 仅出现在 Authorization header。

## Convergence Analysis

per-task 阶段已抓掉两个真实高/中危（Task 10 的 IPv6 SSRF 绕过是 Critical，Task 9 的错误体吞掉是运维盲点），holistic 簇审在 4 个对抗维度（对称应用 / 计费 / 枚举 / 信任边界）零新增 HIGH，仅 1 个 MED 边角（空白 prompt）+ 2 LOW。趋势单调收敛。**symmetric application 这次反向验证为 clean**——SSRF 守卫收口在单一下载入口是好设计（无需在 N 个 url 返回点逐一加固）。

## 备注
- 报告未自动 commit（留待拍板）。
- 真 codex CLI 本轮不可用（长任务挂起），fallback 子 agent 审查已覆盖同等维度。
