import { isPrivateIPv4, validateLanEndpoint } from '../../../../src/shared/companion/lanProtocol';

/**
 * mDNS 重解析治旧 IP（fix4-⑤，爸拍板的根因修）。绑定里的 endpoint 是配对那一刻的私网
 * IPv4 字面量，电脑换网/新租约后它就死了，重连死磕它等于让用户重新扫码。altEndpoint 里的
 * `主机名.local` 不随网漂，重连先把它重新解析成当前 IPv4 再拨；解析不到（老绑定只有 IP、
 * 解析失败/超时）回退旧地址，行为不劣化。
 */

/**
 * 解析结果换算成新 endpoint。地址为空、与旧地址相同、不是私网 IPv4（mDNS 名被抢注也
 * 解析不出私网地址；端点校验本来就只认私网字面量）都不换——返回 null 让调用方用旧地址。
 * 只替换地址，port 与 altEndpoint 原样保留：解析不改变身份，配对语义不动。
 * （不导出：只有本模块的 mdnsRefreshedEndpoint 消费，语义经它测。）
 */
function reResolvedEndpoint<T extends { endpoint: string; altEndpoint?: string }>(
  target: T,
  address: string | null,
): T | null {
  if (!address || !isPrivateIPv4(address)) return null;
  let original: URL;
  try { original = new URL(target.endpoint); } catch { return null; }
  if (original.hostname === address) return null;
  // 拼好的端点过一遍协议的同一道校验（ai-review Nit）：地址/端口规则将来变化时，
  // 这里不会拼出一条 validateLanEndpoint 不认的 endpoint 出去。
  const endpoint = validateLanEndpoint(`http://${address}:${original.port}`);
  return { ...target, endpoint };
}

/**
 * 用原生 mDNS 解析能力（companion 口的 resolveHost，实现见 lanDns.ts + NeoLanDnsPlugin /
 * LanDnsPlugin）刷新绑定地址。没有 altEndpoint、没有该口、名字不是 .local、解析失败/超时，
 * 一律返回 null——回退旧 IP。
 */
export async function mdnsRefreshedEndpoint<T extends { endpoint: string; altEndpoint?: string }>(
  port: { resolveHost?(host: string): Promise<string | null> } | undefined,
  target: T,
): Promise<T | null> {
  if (!target.altEndpoint || !port?.resolveHost) return null;
  let host: string;
  try { host = new URL(target.altEndpoint).hostname; } catch { return null; }
  if (!host.toLowerCase().endsWith('.local')) return null;
  try { return reResolvedEndpoint(target, await port.resolveHost(host)); }
  catch { return null; }
}
