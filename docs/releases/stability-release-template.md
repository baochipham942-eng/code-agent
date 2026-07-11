# Agent Neo Stability Release `<version>`

> 构建 commit：`<full git SHA>`  
> 冻结证据 artifact：`stability-release-evidence-<full git SHA>`

## 用户问题与行为变化

- 用户原先遇到的问题：`<只写用户可观察的问题>`
- 本版行为变化：`<写清触发条件、旧行为和新行为>`

## 默认行为

- 默认行为是否变化：`是 / 否`
- 若变化：`<默认值、迁移影响和兼容边界>`

## 长会话性能

- 结论和环境从 [long-session-gold-latest.json](../perf/long-session-gold-latest.json) 读取。
- 发布说明只引用其中的 `generatedAt`、`environment.gitHead`、`gates` 和 `passed`，不手抄另一套阈值或结果。

## Stop / Recovery

- 工具停止证据：[tool-cancel-smoke-latest.json](../stability/tool-cancel-smoke-latest.json)
- RunRegistry 与 renderer 停止证据：[agent-runtime-app-host-smoke-latest.json](../stability/agent-runtime-app-host-smoke-latest.json)
- 发布说明引用报告的 `gitHead`、`generatedAt`、`scenarios` 和 `passed`；脚本路径本身不算已运行证据。

## Provider 能力与验证状态

- 能力定义只引用 [Provider × Runtime 矩阵](../capabilities/provider-runtime-matrix.md)。
- verified / unverified / failed 状态只引用 [live smoke ledger](../capabilities/provider-runtime-live-smoke-ledger.json)。
- 不在 Release Note 手写能力表；冻结 artifact 中的矩阵事实源与 ledger 共同决定可声明范围。

## 实验能力

- 从矩阵中筛选 `experimental` 项，并引用对应坐标与证据；不得改写成正式支持。

## 已知问题

- `<用户影响、触发条件、规避方式、跟踪 Issue>`

## 有意暂缓项

- `<暂缓内容、原因、重新决策条件>`
- AI SDK 7 的状态引用 [采用 Spike](../architecture/sdk-7-adoption-spike.md)，保持其 `hold / adopt` 原始结论。

## 回滚方式

- 应用回滚：`<上一稳定版本和执行入口>`
- 配置或数据兼容：`<是否需要迁移；若不需要，明确写无需迁移>`
- stable promotion 回滚：`<恢复上一版 latest.json / release.json 的操作与负责人>`

## 正式发版前的证据确认

- [ ] `npm run check:provider-runtime-release-evidence -- --mode full` 在构建 commit 上通过。
- [ ] artifact 名与构建 commit 完全一致。
- [ ] 长会话和两个 Stop 报告都来自真实 smoke，且没有被相关代码变更判定为 stale。
- [ ] 需要付费或订阅额度的 Provider live smoke 已获得人工授权；未授权项继续标为 unverified。
