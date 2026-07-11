# Provider × Runtime 能力矩阵

## 单一事实源

矩阵唯一事实源是 `src/host/model/providerRuntimeCapabilities.ts`。本文只说明读取方式，不复制每个能力格，避免文档与请求门控漂移。

矩阵与 web search 的 `src/host/tools/web/search/providerCapabilityMatrix.ts` 无关。前者约束模型请求和外部 Agent Runtime，后者只描述搜索 Provider。

覆盖的 Runtime：

- Native
- Codex CLI
- Claude Code
- MiMo Code
- Kimi Code

覆盖的协议族：

- Anthropic Messages
- OpenAI Chat Completions
- OpenAI Responses
- OpenAI-compatible gateway
- Ollama / LiteLLM 类本地端点
- Google Generative Language（覆盖现有 Gemini 专用 adapter）
- opaque CLI：外部 Runtime 自己拥有上游协议，Neo 无法诚实声明其实际 Provider 协议

能力状态只允许 `supported`、`experimental`、`unknown`、`unsupported`。当前矩阵没有 `supported` 格：自动测试与 request fixture 已建立，但 Provider / CLI live smoke 尚未获得额度授权。已有实现因此保持 `experimental`，没有实现或已知不支持的能力保持 `unknown` / `unsupported`。

## 证据结构

- 脱敏 request-shape fixtures：`docs/capabilities/request-shapes/`
- 自动测试：`tests/unit/model/providerRuntimeCapabilities.test.ts`
- live smoke ledger：`docs/capabilities/provider-runtime-live-smoke-ledger.json`

任何格提升为 `supported` 前，必须同时满足：fixture 存在、自动测试存在、ledger 中对应记录为 `verified`。测试会机械检查这三项。

## 请求前门控

Native 在 `aiSdkAdapter` 创建 Provider model 和发送请求前检查流式、reasoning、tool choice、图片、abort 和 timeout 能力。`unknown` / `unsupported` 会抛出 `PROVIDER_RUNTIME_CAPABILITY_BLOCKED`，不会静默透传。

模型级图片能力继续以 `providerRegistry` 的 `supportsVision` 为准。协议族允许图片但所选模型声明不支持时，请求仍会在 Provider 构造前失败。

四个外部 Runtime 在 spawn 前通过同一矩阵拒绝附件，保留原有用户错误文案。它们当前没有 Run-scoped abort、首 token timeout、stream idle timeout 或可信 usage 契约，矩阵不会把总进程 timeout 包装成这些能力。

## 审计发现但本阶段不扩修的边界

- AI SDK Native 路径只有 Xiaomi body transform 会实际发送统一 reasoning 控制；其他 Provider 的 `reasoningEffort` 配置不能据此宣称上游支持。
- `custom` Provider 在 AI SDK adapter 中固定走 OpenAI-compatible provider；`ModelConfig.protocol='claude'` 不会把它变成 Anthropic Messages 请求。矩阵按实际 adapter 路径归入 gateway，不替现状背书。
- Native 的 `requestTimeoutMs` 是整次非流式请求 watchdog，不能当成独立 TCP connect timeout；矩阵明确标为 unsupported。
- 外部 Runtime 的 stall warning 只提示慢启动，不会中止请求，不能当作 first-token timeout。

## Live smoke 状态

本机只做了不读取凭据值的配置发现：Native 有多个已配置 Provider；Codex CLI、Claude Code、MiMo Code 已安装，Kimi Code 未安装。所有可能消耗 API 或订阅额度的 smoke 都记录为 `unverified/not_run`，未发起真实模型请求。

P0 的 Bash/http_request、RunRegistry 和 UI Stop smoke 在 ledger 中单独记为已验证，但它只证明本地控制面停止收敛，不会把 Provider `stop_abort` 提升为 `supported`。

## P2 Release Governance 准确入口

P2 应从以下位置实施，不需要改 Agent Engine 或 UI：

1. 新增 `scripts/check-provider-runtime-release-evidence.ts`，读取矩阵、fixture、ledger 与当次长会话报告，拒绝缺证据或过期的 release candidate。
2. 在 `package.json` 增加 `check:provider-runtime-release-evidence`，与现有 `check:capability-evidence` 并列。
3. 在 `.github/workflows/release.yml` 的 macOS/Windows 打包步骤之前运行该命令；Gate 失败时不得进入签名、上传和 stable promotion。
4. 在 `.github/workflows/capability-evidence.yml` 增加 PR 级静态检查，只校验矩阵结构、fixture 脱敏和 ledger 引用，不运行付费 smoke。
5. 在 `docs/releases/` 增加 Stability Release 模板，固定填写默认行为变化、性能报告、Stop smoke、Provider ledger、实验能力、已知问题、暂缓项和回滚方式。
6. Release artifact 保存 `docs/perf/long-session-gold-latest.json` 与冻结后的 provider-runtime ledger 副本，避免发版说明只有文字结论。

Release blocker 的首版验收证据：任一 `supported` 格缺 verified ledger、长会话报告失败、Stop smoke 缺失或 ledger 含凭据形态时，检查脚本非零退出；完整证据集返回 0。
