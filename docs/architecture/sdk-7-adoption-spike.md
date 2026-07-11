# AI SDK 7 独立 Spike 与采用条件

## 判断

生产依赖保持 AI SDK 6，当前结论是 **hold**。允许后续在隔离 worktree 或临时 package alias 中做 Spike，不在本计划内升级 `package.json` / `package-lock.json`。

## 证据

- 当前生产依赖为 `ai@^6.0.191`，Provider 包处于对应的 v6 代际。
- 2026-07-11 查询 npm registry，`ai` 的 `latest` 为 `7.0.22`；其核心依赖已经切到 `@ai-sdk/provider@4`、`@ai-sdk/provider-utils@5`，并要求 Node `>=22`。
- 同日 registry 中 `@ai-sdk/anthropic` latest 为 `4.0.12`，`@ai-sdk/openai-compatible` latest 为 `3.0.7`，说明升级不是单包 patch，而是整组 Provider major 联动。
- [AI SDK 官方 migration guides](https://ai-sdk.dev/docs/migration-guides) 当前公开索引只列到 5.x → 6.0；[6.0 migration guide](https://ai-sdk.dev/docs/migration-guides/migration-guide-6-0) 明确展示过往 major 会改 usage、tool、provider metadata 和 mock model 契约。当前缺少可核对的 6 → 7 正式迁移指南。
- Neo 的 Native adapter 目前自行维护 axios transport、Provider body transform、tool-call argument accumulation、usage normalization、AbortSignal、first-token/idle watchdog 和错误分类。只升级类型版本不能证明这些自定义边界可以删除。
- Provider × Runtime ledger 尚无已授权的真实 Provider smoke，无法证明 v7 对现有绿色渠道无退化。

Registry 查询命令只读取公开元数据，不安装依赖：

```bash
npm_config_cache=/tmp/code-agent-npm-cache npm view ai version dist-tags dependencies peerDependencies engines --json
npm_config_cache=/tmp/code-agent-npm-cache npm view @ai-sdk/anthropic version dist-tags --json
npm_config_cache=/tmp/code-agent-npm-cache npm view @ai-sdk/openai-compatible version dist-tags --json
```

## Spike 范围

Spike 必须物理隔离，默认不开生产路径：

1. 用临时 package alias 或独立 worktree 安装 AI SDK 7 及同代 Provider 包，不改生产 lockfile。
2. 只复制 `aiSdkAdapter` 的最小请求边界，覆盖 Anthropic Messages、OpenAI Chat Completions、OpenAI Responses、OpenAI-compatible gateway 和本地端点。
3. 复用 P1 request fixtures，比较最终 request shape，不以“能编译”作为通过。
4. 运行 tool choice 四态、图片、流式 tool arguments、usage、abort、三类 timeout 和上游错误分类测试。
5. 对已获授权的 Provider 逐项写 live smoke ledger；未授权渠道保持 unverified。
6. 统计可删除的自定义代码行和 Bug 类别，禁止把代码搬家计为收益。

## Adopt 条件

以下条件必须全部满足才能从 hold 改为 adopt：

- 官方 6 → 7 migration guide 或等价的稳定发布说明可用，Provider major 兼容关系明确。
- 至少消除一类已知生产 Bug，或删除一组可量化的自定义 adapter 代码；建议门槛为净删 150 行以上且不新增等量 shim。
- OpenAI Responses 从当前 `unsupported` 提升时，有独立 fixture、自动测试和 verified live smoke，不改变现有 Chat Completions 默认路径。
- 当前矩阵中已验证的能力格全部保持不退化；tool call、usage、abort、timeout 和错误传播与 v6 语义一致。
- POC 默认关闭，回滚只需恢复依赖选择，不迁移持久化消息或 Session 协议。
- 定向测试、typecheck、长会话 Gate 和真实 Stop Gate 全部通过。

任一条件缺失时继续 hold。版本号更新、类型更现代或未来可能减少维护都不足以单独触发升级。
