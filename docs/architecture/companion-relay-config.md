# Companion relay 配置模板

跨网 relay 由电脑 **主动出站** 拨号，电脑不监听公网。本文件是配置模板和契约说明，不是部署手册。未申请证书、域名或 Sealos 资源。

默认关闭。数据目录没有 `companion-relay.json`、或 `enabled` 不是 `true`、或 `credentialRef` 在钥匙串里解不到值时，Host 行为与现在完全一致（只有 LAN）。

把下面的 JSON 放到 `~/.code-agent/companion-relay.json`（或当前数据目录）。凭据写入钥匙串服务 `dev.neo.companion.relay.v1`，账号为 `credentialRef`。文件里只放引用，不放密钥。

```json
{
  "v": 1,
  "enabled": false,
  "url": "wss://relay.example.invalid/companion",
  "credentialRef": "companion-relay",
  "reconnectBackoffMs": [1000, 2000, 4000, 8000, 16000, 30000]
}
```

- `v`：协议版本，预留字段；当前只接受 `1`。
- `url`：受信 relay 的 WSS 地址。非环回必须 `wss:`；环回 `ws:` 仅给本地 fake relay。
- `credentialRef`：路由凭据引用，短 TTL，不是长期内容密钥。拨号时走 WebSocket `Authorization` 头，不放进 URL。
- `caFile`：可选。私有 CA 的 PEM 路径，**只作用于本机中继拨号**（追加到 Node 系统根，不替换、不改全局 TLS）。绝对路径按原样读；相对路径相对数据目录解析。读不到或内容不含 `BEGIN CERTIFICATE` 时 fail-closed，不拿这份配置去拨号。
- `reconnectBackoffMs`：断开后的重连退避（毫秒）。缺省 1/2/4/8/16/30 秒并加抖动。

Relay 只见信封（route token、设备身份引用、seq、TTL）和密文负载；不执行任务、不存全量历史、不接收长期内容密钥。消息仅有界内存转发，断开不无限排队。命令语义仍走 CompanionGateway（幂等键穿透 relay 层）。撤销时 Host 发 `revoke` 帧，relay 同步断路。

## 手机侧凭据怎么携带

Host 拨 relay 继续用 `Authorization: Bearer <credential>` 头（能设头的运行时）。手机的 WebView WebSocket 设不了请求头（平台限制），生产反代也不注入凭据，所以手机把共享凭据放进 WebSocket 子协议（`src/shared/contract/companionRelay.ts`，两端共用同一对编解码函数）：

- 拨号时固定发两项子协议：协议名 `neo-relay.v1` + 凭据项 `neo-relay-auth.<base64url>`。
- 编码规则：凭据先 `trim()`，取 UTF-8 字节做无 padding 的 base64url，拼在前缀后面。生产凭据里有 `=` 这类不合法的协议 token 字符，必须编码后才能进 `Sec-WebSocket-Protocol`。
- 服务端鉴权顺序：先看 `Authorization` 头，没有再从子协议里找带前缀的项，解码后与配置凭据做常量时间比较。无凭据、错凭据、编码非法一律 `auth_rejected` 并断开；日志与统计里只有来源标记（header / subprotocol / none），不出现凭据或它的编码。
- 服务端 `handleProtocols` 只回选固定协议名 `neo-relay.v1`，绝不回选或回显凭据项。这一步必须做：浏览器在「发了子协议、服务端却没选」时会直接断开连接。

## routeToken 怎么派生、什么时候失效

routeToken 不再随机铸造，改由 Host 持久身份确定性派生（`src/host/services/companion/companionRelayRouteToken.ts`）：

- 派生规则：`HMAC-SHA256(key, "neo-relay-route.v1|" + namespace + "|" + deviceId + "|" + scopeEpoch)` 取 base64url；其中 `key = sha256("neo-relay-route-key.v1" || secretKey)`，`secretKey` 是 `loadLanIdentity` 返回的身份密钥。`namespace` 当前固定 `"local"`，是给以后「中继绑账号」预留的维度——换 namespace 即整批换 token。
- 好处：Host 重启（同一身份、同一配对库）后 token 不变，手机缓存的 relay 路由不必先回到同一 Wi-Fi 刷新；Host 重连后按同一批 token 重新注册。
- 失效语义：设备行的 `scopeEpoch` 变了，派生结果跟着变；被撤销的设备不在 `pairedDevices()` 里，Host 不会再为它派生或注册 token，旧 token 对应的 route 到 TTL（60s）自然过期。


## 排障：看宿主日志里 Companion relay 开头的行

Host 侧 loader / 拨号把每条跳过或失败打成一行（凭据、Authorization 头、密钥片段都不会进日志）：

| 日志 | 含义 |
|---|---|
| `Companion relay config file missing: <绝对路径>` | 数据目录里没有 `companion-relay.json`。路径就是当时解析出的完整配置文件路径，用来判断数据目录对不对。 |
| `Companion relay config file unreadable: <错误码>: <绝对路径>` | 配置文件存在但读不了（如 `EACCES` 权限、`EISDIR` 是目录）。只有 `ENOENT` 才记成 missing。 |
| `Companion relay config JSON parse failed: <绝对路径>` | 配置文件不是合法 JSON。 |
| `Companion relay config schema invalid: <zod path>` | 字段不合法或多了未知键。只带 issue 的 path，不带值。 |
| `Companion relay config enabled is not true` | `enabled` 不是 `true`，保持只走 LAN。 |
| `Companion relay config missing url` / `missing credentialRef` | 已启用但缺拨号字段。 |
| `Companion relay config url invalid: COMPANION_RELAY_INVALID_URL` 或 `COMPANION_RELAY_INSECURE_URL` | URL 解析失败，或非环回用了明文 `ws:`。 |
| `Companion relay caFile unreadable: <路径>` / `caFile invalid: <路径>` | CA 文件读不到，或内容不含 `BEGIN CERTIFICATE`。 |
| `Companion relay keytar unavailable` | `loadKeytar` 返回 null，钥匙串模块不可用。 |
| `Companion relay credential missing from keychain` | 钥匙串里没有这个 `credentialRef`。 |
| `Companion relay credential too short: length=<n>` | 凭据短于下限。只打长度，不打值。 |
| `Companion relay keytar error: <message 首行>` | `getPassword` 抛错。 |
| `Companion relay identity load failed: <message 首行>` | `loadIdentity` 抛错。 |
| `Companion relay connected: <url>` | 拨号成功。 |
| `Companion relay dial failed: <错误码>; reconnect in <ms>ms` | 拨号失败或连接关闭。错误码来自 `error` / `unexpected-response`（如 `UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`ECONNREFUSED`、`HTTP 401`）。同一错误码连续出现只打第一次；错误码变了或中间成功连上过才再打。 |
| `Companion relay disconnected: <错误码>; reconnect in <ms>ms` | 已连上的连接被中继或网络断开（不是拨号失败），随后按退避重连。 |
| `Companion relay dial-out skipped` | `startCompanionRelayIfConfigured` 本身抛错（带 error message）。 |
