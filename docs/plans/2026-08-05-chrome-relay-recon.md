# Chrome Relay 摸底报告（P2 · 只摸不建）

**日期**：2026-08-05  
**范围**：全量 H（附着用户日常 Chrome）的底子盘点；**本单不实施 Relay 产品化改造**。  
**关联**：ADR-041、ADR-046、`docs/acceptance/browser-login-reuse-parity.md`、`docs/architecture/surface-execution.md`

---

## 1. 现状：能附着什么

| 项 | 现状 |
|----|------|
| 附着对象 | **用户本机 Chrome 中已打开、且经扩展显式批准的标签**（lease + placement） |
| 是否整窗/整 profile | **否**。不是挂载 user-data-dir，也不是接管整个 Chrome 进程 |
| 登录态来源 | **真实标签当前态**（用户已登录的 Cookie / localStorage 等随该 tab 文档生效） |
| 协议 | `BROWSER_RELAY_PROTOCOL_VERSION_V2 = '2.2'`（host `browserRelay.ts` ↔ 扩展 `protocol-v2.js`） |
| 能力清单 | lease.request / cancel / return、tab.agent_window、tab.navigate、screenshot、dom/ax snapshot、network.metadata、dialog、file.upload、input.mouse/keyboard |
| 动作目录 | navigate/back/forward/reload、click/type/scroll/hover/drag、dialog、upload、screenshot、get_content、snapshots、wait、logs |

**不能做的（当前设计）**

- 不自动附着未批准标签  
- 不挂载用户日常 `user-data-dir`（ADR-041 硬边界）  
- 不在未 handshake / 未 lease 时执行动作（fail-closed）  
- stop relay 时若仍有 active lease 会拒绝（须先归还 tab）

---

## 2. 怎么启动

```
用户/LocalOps「启动 Relay」
  → desktop.ipc startBrowserRelay
  → BrowserRelayService.ensureStarted(port=23001, fallback 0)
  → 127.0.0.1 HTTP + WebSocket upgrade（token 鉴权）
扩展加载
  → openBrowserRelayExtensionDirectory 打开 resources/browser-relay-extension
  → Chrome「加载已解压的扩展程序」
  → 扩展 hello(protocol 2.2 + capabilities) → host hello_ack
附着
  → RelayBrowserProviderAdapter / requestTabLease
  → 扩展侧用户批准 → lease.approved（domain/action/time + placement）
  → 后续 command 校验 owner / lease / domain / action / expiry
归还
  → lease.return / surface end / orphan recovery
```

**关键文件**

| 层 | 路径 |
|----|------|
| Host 服务 | `src/host/services/infra/browserRelayService.ts` |
| Surface 适配 | `src/host/services/surfaceExecution/RelayBrowserProviderAdapter.ts` |
| 审批边界 | `src/host/services/infra/browserRelayApprovalBoundary.ts` |
| 动作 facade | `src/host/services/infra/browser/relayActionFacade.ts` |
| 合同 | `src/shared/contract/browserRelay.ts` |
| 扩展 | `resources/browser-relay-extension/*` |
| IPC | `startBrowserRelay` / `stopBrowserRelay` / `getBrowserRelayState` / `openBrowserRelayExtensionDirectory` |
| Doctor | `src/host/diagnostics/checks/browserRelay.ts` |

---

## 3. 可靠性判断（基于代码 + 既有验收）

| 维度 | 判断 | 证据线索 |
|------|------|----------|
| 协议完备度 | **高（骨架已产品级）** | v2.2 capability 全集、稳定错误码、lease 生命周期 |
| 安全默认 | **高** | 显式批准、scope 子集、过期/错 owner fail-closed、upload 另批 |
| 安装/连接体验 | **中** | 需手动加载未打包扩展；token/端口/连接态在 LocalOps；缺一键安装向导 |
| 单连接模型 | **中** | 单 socket；重连会替换；多 Chrome profile/多实例未一等支持 |
| 与 managed 共存 | **中高** | dual-engine router；auto 路由依赖附着态；两引擎共享 action 名 |
| 真机 dogfood | **有历史 PASS** | 2026-07-17 ADR-041 dogfood A/B/C；surface-execution relay smoke 套件存在 |
| 日常可运维 | **中** | 扩展未上架、签名/更新路径未产品化；开发态 path 依赖 bundle resources |

**一句话**：Relay **不是空壳**——协议、lease、动作、审批边界已齐；缺口主要在**安装/连接产品体验**与**全量 H 的安全运营面**（审计、默认拒绝策略、账号风险分级），不是「从零建传输层」。

---

## 4. 全量 H 安全边界设计草案（本单不实施）

目标：Agent 可在用户明确授权下操作**日常 Chrome 真实账号态**，同时与「managed 隔离哲学」共存。

### 4.1 三层授权

1. **连接授权**：用户加载扩展并完成 pairing（token + localhost）；断开即失效。  
2. **标签授权（lease）**：每次任务对具体 tab + domainScopes + actionScopes + 时间窗二次批准；批准不得扩大待批范围（已有 approval boundary）。  
3. **敏感动作升级批**：支付/改密/删数据/下载上传/跨域导航出 scope → 额外确认或硬拒绝。

### 4.2 与隔离哲学的调和

| 模式 | 登录态 | 默认场景 |
|------|--------|----------|
| Managed 个人 profile（本单 P0） | Neo 自有 `managed-browser-profile`，Cookie 导入快照 | 日常用户浏览 + 多数 Agent 可复用便利 |
| Managed 隔离 profile | run 级临时目录 | Agent 后台批任务 / 不可信站点 |
| Relay 全量 H | 用户真实 Chrome 标签 | 必须用现网 MFA 会话 / 无法导出 Cookie 的站点 |

原则：

- **默认不进 Relay**；auto 仅在「已附着 + 任务声明需要真实账号」时选 relay。  
- **禁止** user-data-dir 挂载、静默附着、后台批任务批量借真实标签。  
- Managed 个人 profile 解决「每次重登」的 80% 体验；Relay 留给 20% 必须真窗的场景。

### 4.3 审批点（建议产品 checklist）

- [ ] 扩展连接首次确认（显示端口 / token 提示 / 本机-only）  
- [ ] 每个 lease：站点列表、动作列表、TTL、归属会话  
- [ ] 上传文件、处理原生 dialog、跨 domain 导航  
- [ ] 会话结束 / 用户点「归还标签」/ app 退出时的 tab return  
- [ ] 组织策略（若有）：禁 relay、只允许某 domain 后缀

### 4.4 审计（建议）

- 记：conversationId / runId / agentId / leaseId / origin / actionScope / 批准时间 / 归还结果  
- **永不记**：Cookie value、token 全文、页面密码字段、截图中的敏感区默认 redaction  
- 导出：session export 已有 browser redaction 路径，relay 证据走同一 proof finalizer

### 4.5 风险与缓解

| 风险 | 缓解 |
|------|------|
| Agent 在已登录邮箱/银行页误操作 | domain/action 窄 scope + 敏感动作升级批 + 默认短 TTL |
| 扩展被恶意页面探测 localhost | token 鉴权 + 仅 127.0.0.1 + 不回显完整 token |
| 标签未归还 / orphan | lease.return 强制路径 + stop 前拦截 + recovery 码 |
| 用户误以为「开了 Relay = 整个 Chrome 被控」 | UI 文案强调「仅批准的标签」；附着态可视化 |

### 4.6 建议落地顺序（后续单，非本单）

1. 安装/连接向导（一等 UI，少 LocalOps 深链）  
2. 「附着当前标签」产品入口 + 清晰 scope 预览  
3. auto 路由规则文档化 + 默认拒绝矩阵  
4. 审计时间线进会话导出  
5. 可选：扩展打包分发（非 unpacked）

---

## 5. 与本单 P0/P1 的关系

- **P0 个人 profile** 降低对 Relay 的依赖：多数「别每次登录」问题在 managed 内解决。  
- **P1 Cookie 导入** 是「快照进个人 profile」通道；Relay 是「不复制、直接用真标签」通道。  
- 全量 H = P0/P1 + Relay 产品化；本报告只冻结 Relay 边界，不写代码。
