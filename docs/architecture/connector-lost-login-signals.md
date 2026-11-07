# Connector lost-login signals

本表记录 host 实际能观察到的连接器降级信号，供后续失联卡片选择 reason code。审计基线为 `1824419671300f8821de0730d42f88b894b9054a`；复现全部使用仓外假 CLI、SDK 错误对象、假 `osascript` 和内存 OAuth store，没有访问真实账号。

等级含义：

- **CONFIRMED**：信号可区分且已做 hermetic 复现。只证明该行 reason code，不自动证明“登录失效”。
- **AMBIGUOUS**：同一信号可对应多种原因；不得从中选择单一原因展示。
- **NOT-OBSERVABLE**：host 没有可区分该原因的信号。

`stale` **不是** lost-login 证据。`getCachedStatus` 在缓存超过 TTL 时仅给旧值加 `stale`；`readFreshStatus` 在超时、非零退出、非法 JSON 等未分类探测失败时复用旧值并加 `stale`。复现中一次已连接探测随后超时，结果为 `{ connected: true, identity: 'user', stale: true }`。

| family | reason code | signal | source file:identifier | grade | what the user can be told truthfully |
|---|---|---|---|---|---|
| CLI | `cli_not_logged_in` | 状态命令 exit 0，但 Feishu `identities.user.available !== true`，或 TMEET 输出不匹配 `Logged in`；返回 `connected:false`，无 `stale` | `src/host/connectors/cli/cliConnector.ts:readFreshStatus`；`src/shared/constants/cliConnectorDescriptors.ts:feishuCliDescriptor`、`tmeetDescriptor` | CONFIRMED | “CLI 当前未报告已登录，请重新连接。”不要进一步说过期或撤销。 |
| CLI | `cli_missing_configuration` | 非零退出或错误文本命中 descriptor 的 `not_configured` / `profile ... not found` / `not configured` / `user config is empty` / `not logged in`；`connected:false`，无 `stale` | `src/host/connectors/cli/cliConnector.ts:isMissingConfiguration`、`readFreshStatus`；`src/shared/constants/cliConnectorDescriptors.ts:missingConfigurationPattern` | CONFIRMED | “CLI 报告配置缺失或未登录，请重新连接。” |
| CLI | `cli_install_failed` | 状态探测得到 ENOENT/exit 127，自动修复安装又失败；返回 `connected:false, installState:'failed'` | `src/host/connectors/cli/cliConnector.ts:readFreshStatus`、`ensureInstalled` | CONFIRMED | “CLI 安装或修复失败。”这不是登录失效证据。 |
| CLI | `cli_probe_failed` | `CliConnectorTimeoutError`、未匹配的非零退出、启动错误或非法 JSON；复用缓存/默认状态并加 `stale:true` | `src/host/connectors/cli/cliConnector.ts:waitForChild`、`readFreshStatus`、`getCachedStatus` | AMBIGUOUS | 不要声称登录失效、过期、撤销或网络故障；只能说探测未完成。 |
| CLI | `cli_token_expired` | 没有独立的过期分类；可能与未登录、配置缺失、普通非零退出或超时相同 | `src/host/connectors/cli/cliConnector.ts:readFreshStatus`、`isMissingConfiguration` | NOT-OBSERVABLE | 不要显示“token 过期”。 |
| CLI | `cli_token_revoked` | 没有独立的撤销分类；与过期及其他 CLI 失败共用上述信号 | `src/host/connectors/cli/cliConnector.ts:readFreshStatus`、`translateConnectionError` | NOT-OBSERVABLE | 不要显示“token 被撤销”。 |
| MCP | `mcp_oauth_authorization_required` | SDK `UnauthorizedError`、`SdkHttpError` 401、`SdkErrorCode.ClientHttpAuthentication`，或对象 `status:401`；格式化为 `oauth-authorization-required` | `src/host/mcp/mcpErrors.ts:isOAuthAuthorizationRequiredError`、`formatMcpConnectionError`；`src/host/mcp/mcpClient.ts:connect` | CONFIRMED | “MCP 服务端要求重新授权（401），请重新授权。”不要断言过期或撤销。 |
| MCP | `mcp_insufficient_scope` | `InsufficientScopeError`、403 / `ClientHttpForbidden`、`WWW-Authenticate: insufficient_scope`，或明确 missing-scope 文本 | `src/host/mcp/mcpErrors.ts:isMcpInsufficientScopeError`；`src/host/mcp/mcpClient.ts:callToolInternal` | CONFIRMED | “当前账号权限不足，请补授权或换账号。”这不是登录丢失的同义词。 |
| MCP | `mcp_credentials_missing` | `MCPCredentialsMissingError` / `code:'MCP_CREDENTIALS_MISSING'`，在发送请求前发现 secretRef 无法解析或字段为空 | `src/host/mcp/mcpErrors.ts:MCPCredentialsMissingError`、`formatMcpConnectorErrorExit`；`src/host/mcp/secretRef.ts:resolveSecretRefs` | CONFIRMED | “凭据未附上，请重新填写。”不要声称服务端撤销了授权。 |
| MCP | `mcp_service_unavailable` | HTTP 405/501、JSON-RPC `METHOD_NOT_FOUND`，或明确的不支持/区域/账户可用性文本 | `src/host/mcp/mcpErrors.ts:isMcpServiceUnavailableError`、`formatMcpConnectorErrorExit` | CONFIRMED | “服务端不支持或无法提供此连接器的请求。”不要声称登录失效。 |
| MCP | `mcp_session_expired` | 会话期 HTTP 404 或 JSON-RPC `-32001`；被归为可重连中断并清理/重建会话 | `src/host/mcp/mcpTransport.ts:isMcpToolConnectionInterruptionError`；`src/host/mcp/mcpClient.ts:callToolInternal` | CONFIRMED | “MCP 会话已过期或中断，请重连。”不要声称登录失效。 |
| MCP | `mcp_rate_limited` | HTTP 429；或 `MCP_RATE_LIMIT_DEFERRED_CODE` 带 `serverName`、`waitMs` | `src/host/mcp/mcpTransport.ts:isRetryableRemoteMCPConnectionError`；`src/host/mcp/mcpErrors.ts:rateLimitDeferredWaitOf`、`formatMcpConnectorErrorExit` | CONFIRMED | “服务端正在限流，请稍后重试。”不要声称登录失效。 |
| MCP | `mcp_transport_unavailable` | `RequestTimeout`、`ConnectionClosed`、`SendFailed`、408、5xx、ECONNRESET/ETIMEDOUT 等会走重连；可与其他会话中断共用路径 | `src/host/mcp/mcpTransport.ts:isRetryableRemoteMCPConnectionError`、`isMcpToolConnectionInterruptionError`；`src/host/mcp/mcpClient.ts:callToolInternal` | AMBIGUOUS | 不要声称登录失效、过期、撤销或确定的对端故障。 |
| MCP | `mcp_token_expired` | 过期与撤销、无效 token、缺失认证通常都表现为 401/`UnauthorizedError` | `src/host/mcp/mcpErrors.ts:isOAuthAuthorizationRequiredError` | AMBIGUOUS | 不要显示“token 过期”；只能使用 `mcp_oauth_authorization_required`。 |
| MCP | `mcp_token_revoked` | 与过期及其他 401 原因共用信号；renderer 的正则匹配消息文本也不是撤销凭证 | `src/host/mcp/mcpErrors.ts:isOAuthAuthorizationRequiredError`；`src/renderer/utils/mcpRecovery.ts:MCP_AUTH_FAILURE_PATTERNS` | AMBIGUOUS | 不要显示“token 被撤销”。 |
| native | `native_automation_permission_denied` | 假 `osascript` exit 1，stderr 含 `not authorized` / `-1743`；Photos 转为 `failed`，Mail/Calendar/Reminders 保留原始错误并转为 `failed` | `src/host/connectors/native/photos.ts:probePhotosAccess`；`mail.ts:probeMailAccess`；`calendar.ts:probeCalendarAccess`；`reminders.ts:probeRemindersAccess`；`osascript.ts:runAppleScript` | CONFIRMED | 仅在原始信号含 `not authorized` / `-1743` 时说：“macOS 自动化权限被拒绝，请在系统设置中授权。” |
| native | `native_probe_failed` | Photos 非权限错误转为 `unavailable`；Mail/Calendar/Reminders 任意 AppleScript 错误（含超时、应用未运行、权限错误）都转为 `failed` | `src/host/connectors/native/photos.ts:probePhotosAccess`；`mail.ts:probeMailAccess`；`calendar.ts:probeCalendarAccess`；`reminders.ts:probeRemindersAccess` | AMBIGUOUS | 不要仅凭 `failed`/`unavailable` 声称权限被拒或登录失效；必须检查原始 `-1743`。 |
| native | `native_signed_out` | 原生连接器没有账号登录态分类；空账户/日历/列表仍为 `ready`，主动 disconnect 只重置为 `unchecked` | `src/host/connectors/native/mail.ts:buildMailStatus`；`calendar.ts:buildCalendarStatus`；`reminders.ts:buildRemindersStatus`；`photos.ts:resetPhotosConnectorReadiness` | NOT-OBSERVABLE | 不要显示“账户已登出”。 |
| SaaS OAuth | `oauth_credentials_missing` | `store.tokens()` 为空，`getAccessToken` 抛出 `Connector OAuth tokens are not available` | `src/host/connectors/oauth/connectorAuth.ts:ConnectorAuth.getAccessToken`；`connectorOAuthStore.ts:ConnectorOAuthStore.tokens` | CONFIRMED | “本机没有可用 OAuth 凭据，请重新连接。” |
| SaaS OAuth | `oauth_refresh_state_missing` | 本地 access token 到期且缺 refresh token、discovery state 或 client information；三种精确错误文本分别抛出 | `src/host/connectors/oauth/connectorAuth.ts:ConnectorAuth.getAccessToken`、`isExpired` | CONFIRMED | “本机授权刷新状态不完整，请重新连接。”不要声称服务端撤销。 |
| SaaS OAuth | `oauth_scope_missing` | 已保存 scope 不覆盖请求 scope，抛出 `do not cover scope` | `src/host/connectors/oauth/connectorAuth.ts:ConnectorAuth.getAccessToken`、`scopeIncludes` | CONFIRMED | “已保存授权缺少所需权限范围，请重新授权。” |
| SaaS OAuth | `oauth_refresh_rejected` | 刷新端点返回 HTTP 400 `invalid_grant`，SDK 抛 `OAuthError`；旧 token 保留，未被覆盖 | `src/host/connectors/oauth/connectorAuth.ts:ConnectorAuth.getAccessToken`；`oauthFetch.ts:createConnectorOAuthFetch` | CONFIRMED | “授权服务拒绝了刷新请求，请重新连接。”不要进一步说过期或撤销。 |
| SaaS OAuth | `oauth_access_token_expired` | `isExpired` 只表示本地 access token 到期；正常刷新后仍可使用。刷新时的 `invalid_grant` 也可对应过期或撤销 | `src/host/connectors/oauth/connectorAuth.ts:ConnectorAuth.isExpired`、`getAccessToken` | AMBIGUOUS | 不要把本地到期或 `invalid_grant` 显示为“登录已过期”。 |
| SaaS OAuth | `oauth_token_revoked` | 撤销与过期等刷新拒绝原因可共用 HTTP 400 `invalid_grant`；host 未拆分 | `src/host/connectors/oauth/connectorAuth.ts:ConnectorAuth.getAccessToken` | AMBIGUOUS | 不要显示“授权被撤销”；只能使用 `oauth_refresh_rejected`。 |
| SaaS OAuth | `oauth_transport_failed` | `createConnectorOAuthFetch` 把超时与连接失败分别包装为超时/无法连接错误；网络、代理、DNS、对端不可用均可能 | `src/host/connectors/oauth/oauthFetch.ts:createConnectorOAuthFetch` | AMBIGUOUS | 不要声称登录失效、过期或撤销。 |

## 后续卡片的边界

可展示的 code 仅限表中的 CONFIRMED 行，而且文案不得超出该行的观测范围。尤其：`mcp_oauth_authorization_required` 只表示需要重新授权，不区分过期和撤销；`native_automation_permission_denied` 必须看到原始 `-1743`/`not authorized`，不能只看 `readiness:'failed'`；`oauth_refresh_rejected` 只表示刷新被拒绝。

不得把 `stale`、未分类 CLI 非零退出、普通 MCP 网络/会话错误、native 通用 `failed` 或 OAuth 传输错误翻译成 lost login。主动 disconnect/remove、禁用 MCP、idle reap 也都是本地生命周期动作，不是凭据失效信号。
