import Noise, { type KeyPair } from 'noise-handshake';
import { sha256 } from './lanProtocol';

/**
 * relay 找回配对（N-COMPANION-RELAY-ACCOUNT-RECOVER）的握手与核对码派生。
 *
 * 与 LAN 两条配对路径（XXpsk0 邀请配对 / IK resume）共用同一把 Host 持久身份密钥，prologue
 * 是它们之间的域分隔：relay 配对没有邀请 psk——身份信任来自两道门，手机以 Neo 账号鉴权进
 * relay（连接主人 = acct:<sub>），电脑上的人核对 4 位码后点同意（D2）。纯 XX 三消息：
 * 手机 →e（pair-request）→ 电脑 ←e,ee,se,s（同意后 pair-result）→ 手机 →s,se（续帧），
 * 电脑在第三条消息落地后才认得手机的静态公钥，设备登记随之发生在那一刻（同意守卫）。
 */
const RELAY_PAIR_PROLOGUE = 'neo-companion/relay-pair/v1';

/** 纯 XX：initiator 不带 remoteStatic（XX 起手互不知道对方静态公钥，与 IK 的 resume 不同）。 */
export function createRelayPairHandshake(initiator: boolean, identity: KeyPair): Noise {
  const noise = new Noise('XX', initiator, identity);
  noise.initialise(new TextEncoder().encode(RELAY_PAIR_PROLOGUE));
  return noise;
}

/** 核对码的域分隔标签：与 LAN 邀请的 deriveInvitationVerify（psk‖hostKey）分属两套派生。 */
const RELAY_PAIR_VERIFY_DOMAIN = new TextEncoder().encode('neo-companion/relay-pair-verify/v1');

/**
 * 4 位核对码：从 XX 握手材料——第一条消息里的手机临时公钥——派生。两端在电脑点同意之前就
 * 都拿得到这份材料（手机发出即有，电脑收到即有），所以卡片与手机屏能各算各的还必然一致；
 * 每次配对尝试的临时公钥都是新的，码跟着换。绝不允许独立随机——两端对不上核对就失去意义。
 */
export function deriveRelayPairVerify(initiatorEphemeral: Uint8Array): string {
  const material = new Uint8Array(RELAY_PAIR_VERIFY_DOMAIN.length + initiatorEphemeral.length);
  material.set(RELAY_PAIR_VERIFY_DOMAIN, 0);
  material.set(initiatorEphemeral, RELAY_PAIR_VERIFY_DOMAIN.length);
  const n = new DataView(sha256(material).buffer).getUint32(0);
  return String(n % 10_000).padStart(4, '0');
}

/** S6 稿形状：'4719' → '4 7 1 9'（电脑卡片与手机两处共用同一格式）。 */
export function formatRelayPairVerify(code: string): string {
  return code.split('').join(' ');
}
