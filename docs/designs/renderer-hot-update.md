# 前端热更（Renderer Hot Update）设计

> 状态：设计已对齐，实现中（批 2）
> 目标：改前端 UI 不用整包发版。前端 bundle 独立推 OSS（~1min），不碰 cargo build/公证（~25min）。

## 决策（已拍）

- **生效时机**：下次启动生效（首版求稳）。webServer 后台拉取+验签+切换到 `active/`，当前会话不动，用户下次重启 app 加载新前端。热重载留作第二期。

## 可行性基石

前端是 webServer serve 出去的（Tauri WebView 拉 `localhost:8180`），**不是 Tauri 直读 bundle 文件**。所以热更只需让 webServer 换 serve 目录，**Tauri 壳/签名/公证完全不动**。

## 双包模型

- **包内基线** `dist/renderer/`：随整包签名发布，永远可信兜底。
- **云端 overlay**：OSS 拉取的 bundle，校验通过后放 `~/.code-agent/renderer-cache/active/`。

## 数据面（serve）— 钩子点 `src/web/routes/static.ts`

`staticDir` 改运行时解析：`renderer-cache/active/` 存在且健康 → 用云端版；否则 fallback 包内 `dist/renderer`。配套：
- index.html 内存缓存（static.ts:29-55）切换时 reset。
- token 动态注入逻辑保留（云端包**不含** token，serve 时注入 `window.__CODE_AGENT_TOKEN__`）。

## 控制面（拉取/验签/切换）— webServer 启动后异步，不阻塞 health

```
拉 OSS renderer-bundle/latest/manifest.json（签名 envelope, kind=renderer_bundle）
 → 契约版本门：minShellVersion > 当前壳版本？ → 拒绝，留当前（防新前端配旧壳崩）
 → contentHash == 本地 active？        → 已最新，skip
 → 下载 bundle.tar.gz → pending/        → 校验 sha256 == manifest.contentHash
 → 验 envelope 签名（复用 controlPlaneTrust）→ 解压 pending/
 → fs.rename(pending → active)          // 同 fs inode 级原子
 → 写 active/.bundle-meta.json（version/hash）→ reset index.html 缓存
```

## 兜底铁律（与 model 路由 override 一致）

拉取失败 / 签名失效 / sha256 不匹配 / minShellVersion 不满足 / 解压失败 → **一律保持当前**，绝不 serve 半个或损坏的前端。`active/` 校验失败 → 回包内基线。包内基线永远是签名发布的可信底座。

## 契约版本门（最高风险点的解法）

IPC 契约（`src/shared/ipc/domains.ts`）当前**无版本号**，新前端配旧壳会 404/INVALID_ACTION/静默崩。`manifest.minShellVersion` vs 壳版本硬门挡住：前端要用新 IPC 就声明高 `minShellVersion`，旧壳拒绝该 bundle、留包内版本，等整包更新壳后再吃新前端。

## 签名

复用 `src/main/services/cloud/controlPlaneTrust.ts` 的 `verifyControlPlaneEnvelope`，kind=`renderer_bundle`。公钥已打包（`dist/web/control-plane-public-keys.json`）。webServer 可 `import('../main/...')`，无 main/web 分层障碍（已有大量先例）。

## CI = 省发版的真义

轻量脚本 `build renderer + 签 manifest + ossutil 传 OSS`，**独立于整包发版**。前端改动只跑这个（~1min），不走 cargo build/公证。OSS 路径：`renderer-bundle/latest/{manifest.json,bundle.tar.gz}` + 版本快照 `renderer-bundle/v${VERSION}/`。

## 实现阶段（自底向上，每步 TDD）

1. **契约门 + manifest 类型**（纯函数 `rendererBundlePolicy.shouldApplyRendererBundle`）— 决策核心，最易测
2. **完整性校验**（sha256 + envelope 验签）
3. **缓存目录管理 + 原子切换 + active 健康校验**
4. **static.ts staticDir 运行时解析改造**（含 index.html 缓存 reset）
5. **拉取器编排** + webServer 启动后异步接线
6. **网络常量** OSS renderer-bundle base url
7. **CI 脚本** build+签+传 OSS（独立发版）
8. **验证**：typecheck + 测试 + 端到端（本地起 webServer + 注入假 active/ 验证 serve 切换）
