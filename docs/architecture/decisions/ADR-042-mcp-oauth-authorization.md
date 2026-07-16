# ADR-042 — 远程 MCP OAuth 浏览器授权(SDK OAuthClientProvider 接线)

- Status: accepted(五问拍板 2026-07-17:loopback 回调 / URL 变更废 token / 设置页管理入口 / consent 必显字段 / 未信任目录禁发起——全部批准)
- Date: 2026-07-17
- Related: ADR-041 之后;#413 E1 folder trust(前置);Grok Build 借鉴第三批侦察(E3);`@modelcontextprotocol/sdk@1.29.0`

## Context

主流 SaaS 官方远程 MCP(Notion/Linear/Sentry/Atlassian)全部走 OAuth 授权码流。Neo 当前远程 MCP 只支持配置里塞静态 `headers` token(`mcpTransport.ts:191` 只把 headers 进 requestInit;SSE 分支连 headers 都没传,`mcpTransport.ts:207`),没有任何 `authProvider` 接线——非程序员用户无法手工造 token,「连上你在用的 SaaS」整类能力缺位,而这正是产物为主轴、对标 Manus 的核心场景。

侦察实核了 SDK 1.29.0 的能力边界:`client/auth` 已内置 RFC 9728/8414 发现、DCR、PKCE S256、token exchange/refresh、401→auth() 自动流(`streamableHttp.js:312-334`);宿主必须补的是 redirect URL、系统浏览器打开、client/tokens/verifier/discovery 持久化、**state 校验**(SDK 只把 state 放进授权 URL,`finishAuth` 不回传校验)和 loopback 回调 server(SDK 只有 example 级实现,无生产导出)。

## Decision

采用**方案 A:纯 SDK `OAuthClientProvider` 接线**,不自研协议层。新增 `mcpOAuthProvider`(per-server)+ `mcpOAuthCoordinator`,在 `createTransport()` 对 `http-streamable` 配置注入 `authProvider`;完整流:401 → SDK auth() → Neo consent 弹窗 → `shell.openExternal` 打开系统浏览器 → loopback 回调 → state 对账 → `finishAuth(code)` → reconnect。

五项安全/产品边界(已拍板):

1. **回调 = loopback 随机端口**(P0)。自定义 scheme/deep link 本批不做(Tauri 当前无 scheme 注册,牵涉打包分发);回调 server 按 flow 一次性起、随机可用端口、绑定 flow id + server identity + state,不匹配一律拒绝,端口占用可重试。
2. **server URL 变更即废旧 token**。token 按 `getServerIdentity()` digest(含 serverUrl)为 key 隔离,URL 变了 identity 变,旧 token 不复用。
3. **设置页 per-server 管理入口**:连接状态 / 重连 / 登出 / 删除 token;删除 token 后下次连接重新触发 OAuth。
4. **consent 弹窗必显**:server 名 + canonical server URL + 配置来源(user/project/capability-center)+ 请求 scope + authorization server + redirect host。只显名字防不了 spoof。
5. **未信任目录禁止发起 OAuth**(沿用 E1 fail-closed)。OAuth flow 只允许来自已加载进 MCPClient 的配置;project/local 配置未过 folder trust 根本不加载(`mcpConfigFile.ts:169-179`),天然不能触发;folder identity 漂移回落 untrusted 时同样阻断。

存储:token/client info/verifier/discovery state 走 SecureStorage,独立前缀 `mcp-oauth:<serverIdentity>:<kind>`,与模型 provider key(`apikey.*`)语义隔离。

consent 交互复用 MCP elicitation 的 pending map + timeout 阻塞模式(`mcpElicitation.ts:26-141`),不复用 FolderTrustDialog 的轮询式状态模型(它是 renderer 主动 get/set,不是 host 可 await 的请求-决策)。

SSE 不做 OAuth:SSE transport 已 deprecated 且 Neo 现有 SSE headers 都没接线;先修 headers 直通(独立小修),OAuth 只覆盖 http-streamable。

## 工作量切分(P0 五刀)

1. Provider + SecureStorage:per-server `OAuthClientProvider` 实现,读写按 serverIdentity 隔离。
2. transport 接线:`createTransport()` 对 OAuth-enabled 远程配置注入 authProvider;验证点 = 401 进 SDK auth() 而非普通 connection failed。
3. loopback 回调 + state 校验:验证点 = state 不匹配拒绝、端口占用重试。
4. consent UI + 浏览器打开:验证点 = renderer 决策能 unblock host flow,超时 cancel。
5. 设置页管理入口:验证点 = 删 token 后下次连接重新走授权。

## Consequences

- Neo 获得「连你在用的 SaaS」能力,协议复杂度全压在 SDK,宿主代码面收敛在 provider/coordinator/UI 三块。
- 新增常驻攻击面 = 一次性 loopback server + consent 弹窗;由 state 对账、flow 绑定、E1 信任门、字段全显四层收口。
- SDK 升级需盯 `client/auth` 行为变化(401 重试/upscope 语义),接线测试要钉住「成功认证后仍 401 抛 StreamableHTTPError 防循环」这一形状。
- 配置 schema 需加 OAuth 开关字段(如 `auth: 'oauth'`),`mcp_add_server` 工具与文档同步。
