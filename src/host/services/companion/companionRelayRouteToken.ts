import { createHash, createHmac } from 'node:crypto';

/** routeToken 派生的域分隔标签（N-COMPANION-RELAY-PHONE-AUTH），两端常量与消息格式钉死。 */
const ROUTE_KEY_INFO = 'neo-relay-route-key.v1';
const ROUTE_TOKEN_INFO = 'neo-relay-route.v1';

/**
 * Host 侧 routeToken 的确定性派生：同一持久身份 + 同一设备行（deviceId + scopeEpoch）永远
 * 得到同一个 token，Host 重启不再换 token（此前 randomBytes 只存内存，手机缓存的路由随每次
 * 重启失效）。输出 base64url（43 字符），落在 CompanionRelayRoute 契约的 routeToken 字符集
 * 与长度约束内。
 *
 * 失效语义：epoch 变了 token 跟着变；被撤销的设备不在 pairedDevices() 里，bindPairedDevices
 * 不会再为它铸 token，旧 token 的 route 到 TTL 自然过期。
 *
 * @param secretKey Host 持久身份密钥（loadLanIdentity 的 KeyPair.secretKey）
 * @param namespace 先固定 "local"——给以后「中继绑账号」预留的维度，换 namespace 即整批换 token
 */
export function deriveCompanionRelayRouteToken(
  secretKey: Uint8Array,
  deviceId: string,
  scopeEpoch: number,
  namespace = 'local',
): string {
  const key = createHash('sha256').update(Buffer.concat([
    Buffer.from(ROUTE_KEY_INFO, 'utf8'),
    Buffer.from(secretKey),
  ])).digest();
  const message = `${ROUTE_TOKEN_INFO}|${namespace}|${deviceId}|${scopeEpoch}`;
  return createHmac('sha256', key).update(message, 'utf8').digest('base64url');
}
