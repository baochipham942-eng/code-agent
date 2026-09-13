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
- `reconnectBackoffMs`：断开后的重连退避（毫秒）。缺省 1/2/4/8/16/30 秒并加抖动。

Relay 只见信封（route token、设备身份引用、seq、TTL）和密文负载；不执行任务、不存全量历史、不接收长期内容密钥。消息仅有界内存转发，断开不无限排队。命令语义仍走 CompanionGateway（幂等键穿透 relay 层）。撤销时 Host 发 `revoke` 帧，relay 同步断路。
