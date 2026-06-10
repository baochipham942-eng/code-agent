# ADR-021: Computer Use 底座 argus → cua-driver

> 状态: accepted
> 日期: 2026-06-09

## 背景

Neo 的桌面 GUI 自动化（computer use）原底座是 **argus**（源自 Anthropic Chicago 的闭源快照，`CODE_AGENT_ENABLE_ARGUS_MCP=1` 以 MCP server 接入）。三个硬伤：

- **冻结快照**，跟不上上游，能力停滞。
- **以像素坐标为主**，对分辨率/布局脆弱，token 成本高。
- 后台操作只在 macOS（CGEvent），**Windows 无后台能力**。

2026 年四个独立团队（DeepChat / Yansu / Alma / Peekaboo）已收敛到同一套范式：**AX 可访问性树优先 + 后台投递不抢焦点 + 像素仅兜底 + 快照-动作-再快照硬约束**。argus 的"像素为主"已落后。

## 决策

用开源 **trycua/cua 的 `cua-driver` 模块**（MIT，17.7k★，活跃维护）替换 argus 作为 computer-use 底座。三条关键决策：

1. **接法走 stdio MCP（学 DeepChat），不走 CLI+daemon（Yansu）**。Neo 已有成熟 MCP 架构，MCP server 进程天然持有 per-pid element_index 缓存，零额外进程管理。
2. **按任务类型分工，不做运行时 fallback**：原生桌面 App → cua-driver；浏览器/网页 → Neo 现有 Playwright `browser_action`（保留不动）。cua 唯一短板是 Chromium DOM 后台点击会退化抢前台，正好让 Playwright 接住。禁止两个 computer-use 引擎运行时互切。
3. **分发走重签名内嵌（方案 A）**：用自有 Developer ID 把 cua-driver 重签为 `Agent Neo Computer Use.app`（自有 bundle id `com.agentneo.computeruse`），解决 macOS TCC 按 bundle 归属导致的"授权弹窗显示 CuaDriver / 误命中 Yansu 品牌"问题。

完整提案见 [docs/proposals/computer-use-cua-migration.md](../proposals/computer-use-cua-migration.md)。

## 选项考虑

### 接法：stdio MCP vs CLI+daemon
- MCP（选）：掉进现有 `src/main/mcp/` 链路 + per-tool 权限映射，element 缓存活在 server 进程里。
- CLI+daemon：每次 fork 新进程，per-pid 缓存跨调用即死，必须自管常驻 daemon 生命周期。

### 分发：重签名内嵌 vs 按需下载
- 重签名内嵌（选）：弹窗显示 "Agent Neo Computer Use"、离线可用、版本可控、消除多 CuaDriver 冲突。代价 CI 加签名步骤 + bundle 体积。
- 按需下载：轻量，但品牌混乱（显示 CuaDriver / Yansu）+ 首用需联网。

## 后果

### 积极影响
- mac + Windows 双平台原生后台操作（argus 只有 mac）。
- AX 树优先，多屏/窗口大小/坐标系问题由 cua 原生解决，`coordinateTransform.ts` 那套缩放逻辑可退役。
- 差异化 UI 渲染：`cuaNarration.ts` 把 `element_index` 反查成人话（「点击『7』」）+ 真实 app 图标，超越 DeepChat 的通用工具胶囊。
- 授权门槛降低：默认 `capture_mode=ax` 只需 Accessibility，录屏可选。

### 消极影响 / 风险
- cua 是快速迭代上游，需建立 vendor 版本锁定 + 定期同步纪律（`fetch-cua-driver.sh` 校验 `CUA_DRIVER_VERSION`）。
- 重签后 team id 变化触发 hardened runtime 的 Library Validation 运行时 SIGKILL，靠 `disable-library-validation` entitlement 解决。
- 灰度期 argus 保留一个 release 周期作回退（`CODE_AGENT_ENABLE_CUA=1` 默认关）。

## 相关文档

- [技术提案：Computer Use 底座迁移](../proposals/computer-use-cua-migration.md)
- [竞品分析 deepchat-vs-neo](../competitive/deepchat-vs-neo.html)
- 锚点代码：`src/main/mcp/mcpDefaultServers.ts`、`src/main/mcp/mcpToolRegistry.ts`、`src/main/tools/vision/cuaNarration.ts`、`src/renderer/utils/computerUseWorkbench.ts`、`scripts/fetch-cua-driver.sh`
