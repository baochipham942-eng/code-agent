# Codex Audit Report — in-app update download URL 修复

**Date**: 2026-06-29
**Scope**: `fd497f73e`（in-app updater 拿真安装包直链 + 发布补 sha256）起的修复链
**Starting commit**: fd497f73e
**Rounds run**: 4 / 4（MAX）
**Converged**: ❌ 严格意义未收敛——第4轮仍有 1 MED（已修，但按 MAX_ROUNDS 不再经第5轮独立复审）。所有 findings 均已处理。
**审计执行**: Codex（官方插件 codex-rescue / codex 0.142.4，ChatGPT 登录）独立 context，0 假阳性。

## Summary

| Round | 🔴 HIGH | 🟡 MED | 🟢 LOW | Fix commit |
|-------|--------|--------|--------|------------|
| 1     | 1      | 5      | 2      | 44905e1dc（MED/LOW）；HIGH 升级待人决策 |
| 2     | 0      | 2      | 1      | 8beb02dd9 |
| 3     | 0      | 2      | 0      | 5d2b41c07 |
| 4     | 0      | 1      | 0      | e8b7be1e5（未再经 codex 复审） |

收敛趋势（MED+LOW+HIGH）：8 → 3 → 2 → 1，严重度单调下降，Round1 后再无 HIGH。

## 核心主线

一个原始 bug（`check` 返回 release 网页 URL 而非安装包直链）引出一条贯穿性不变量：
**`(downloadUrl, sha256, version)` 三者必须同源，否则 fail-closed**。四轮把它在所有路径上焊死：

- R1：downloadUrl 取选中资产直链；发布脚本补 per-asset sha256；6 项健全性硬化。
- R2：sha 与 URL 严格同源（env-policy 服务端 + release-policy 客户端两个旁路）。
- R3：version 与 URL 同源（policy 抬版超过 manifest → fail-closed，服务端 + 客户端）。
- R4：`action=download` 端补齐 R3 的 version 守卫（与 `check` 端对称）。

## Findings by Round

### Round 1（1 HIGH / 5 MED / 2 LOW）
- 🔴 HIGH — `updateMetadata.ts` 读未签名 OSS `release.json`，信任其中 downloadUrl+sha256。OSS 写权限被攻破者可投毒「恶意包 URL + 匹配 hash」，客户端 sha 校验仍通过。**ℹ️ 升级待人决策（见下）**——预存架构属性，本修复链未改。
- 🟡 MED1 — env `UPDATE_DOWNLOAD_URL` override 与资产 sha 跨源配对 → ✅ 44905e1dc（同源原子化）
- 🟡 MED2 — 发布脚本对 200 的 HTML 错误页也算 sha → ✅ 44905e1dc（content-type/≥1MB 闸）
- 🟡 MED3 — sha 计算失败 warn+continue 静默发出无 sha 的 release → ✅ 44905e1dc（重试 3 次；保留 fail-soft，理由见下）
- 🟡 MED4 — `selectAsset` 不要求 browser_download_url，url-less 资产遮蔽有效资产 → ✅ 44905e1dc（服务端+客户端均加 url 过滤）
- 🟡 MED5 — 客户端 OSS 直连 fallback 丢弃 per-asset sha256 → ✅ 44905e1dc（解析+透传）
- 🟢 LOW1 — `normalizeSha256` 假设 string，非 string sha 会 throw→502 → ✅ 44905e1dc（typeof 守卫）
- 🟢 LOW2 — 无资产时 check 给网页 URL（与 download 404 不对称）→ ℹ️ 良性：sha 闸下客户端无 sha 即拒绝下载 HTML，记录不改。

### Round 2（2 MED / 1 LOW）
- 🟡 MED — 游离 `UPDATE_SHA256`（无 URL override）被 `envSha ?? asset.sha` 盖到 asset/网页 URL → ✅ 8beb02dd9（严格三分支同源）
- 🟡 MED — 客户端 `applyReleasePolicyToUpdateInfo` 的 policySha256 无条件应用，policy URL 仅条件应用 → policy sha 跨源 → ✅ 8beb02dd9（policy sha 仅与 policy URL 原子成对）
- 🟢 LOW — auto-download fire-and-forget 无 catch，sha 缺失 reject 成 unhandled → ✅ 8beb02dd9（两处加 .catch）

### Round 3（2 MED）
- 🟡 MED — 服务端：policy 抬版超过 manifest 但无 URL → 下发旧 asset URL+sha 配新版本号 → ✅ 5d2b41c07（assetMatchesAdvertisedVersion 守卫）
- 🟡 MED — 客户端：同类，policy 版本赢但保留旧 asset URL+sha → ✅ 5d2b41c07（advertisedBeyondSource fail-closed）
- 已确认 R2 三处修复无回归。

### Round 4（1 MED）
- 🟡 MED — `action=download`（302）绕过 R3 的 version 守卫，仍重定向旧包 → ✅ e8b7be1e5（共享 policyAdvertisesBeyondManifest，download 端对称 fail-closed）。客户端不调此端点，但端点公开，对称性须保证。
- 已确认 R3 两处守卫无回归（正常路径、版本相等、hasUpdate=false 均正确）。

## 升级待人决策（HIGH）

**release.json 未签名 → in-app 更新的完整性靠 OSS 桶访问控制，不是密码学签名。**

- 原生 Tauri 更新器走 `latest.json` + minisign 签名 + 内嵌 pubkey，OSS 写权限被攻破也伪造不了（需私钥）——这条是真 anti-tamper。
- 自研 in-app updater 走 `release.json`（未签名），本修复链让它从「下 HTML 装不上」变成「下真 dmg 并按 manifest sha 校验」——但 sha 来自同一个未签名 manifest，所以它是**防损坏/截断的完整性校验**，不是**防篡改**。攻破 OSS 桶写权限者可投毒。
- **本修复链不改变这条信任边界**（原生路径仍是真安全边界），但 B 层确实激活了一条信任未签名 manifest 的下载路径。
- **可选根治**（ADR 级）：用仓库已有的 `controlPlaneTrust`/`verifyControlPlaneEnvelope` 信封机制（runtime-assets manifest 已在用）给 `release.json` 签名，客户端验签后再信任其 downloadUrl+sha。
- **建议**：作为独立 ADR 评估，不阻断本次 0.22.2 发版（威胁模型 = OSS 桶写权限被攻破，此时 latest.json 的版本/notes 也可改；真正的纵深仍是原生路径的 minisign）。

## 决策记录（非 finding，但留痕）

- **MED3 保留 fail-soft（不 fail-hard 整次发版）**：原生 Tauri 更新器主路径不读 `release.json`，因 in-app 次路径的 hash 偶发失败而 fail 掉整次发版（含原生路径）代价过大。改为重试 3 次收窄窗口；真失败则该平台 in-app 直连退回 fail-closed（客户端缺 sha 拒绝下载），原生路径不受影响。
- **一处旧测试更新**：`updateServiceVerifyDigest.test.ts` 原断言「policy sha 无条件应用」正是 R2 修掉的 cross-pair 行为，已改为修正后契约。

## 验证

- 相关套件（vercel/updateMetadata + scripts/buildStableReleaseJson + services/cloud/* + scripts/releaseMacosGates）共 **105 测全绿**。
- 主仓 + vercel-api 双 `tsc --noEmit` 通过。
- 端到端实证：本地 http 服务证明带 `--compute-asset-sha256` 的 CLI 算出的 sha256 与 `shasum -a 256` 逐字节一致。
- 预存无关红：`designSystemGate`（renderer bare-button 739>736）在 clean main 同样红，非本改回归。

## Convergence Analysis

未达「0 finding 收敛」，但跑满 MAX_ROUNDS=4，严重度单调下降（8→3→2→1），且后三轮全是同一族不变量（同源/fail-closed）在不同路径的对称缺口——典型的 symmetric-application 类 round-N finding。R4 的 download 端缺口是最后一块对称拼图。若要 0-finding 确认，可在本报告基础上再跑一轮 codex 复审 e8b7be1e5（本次按 MAX_ROUNDS 停）。
