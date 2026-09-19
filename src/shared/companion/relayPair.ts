import Noise, { type KeyPair } from 'noise-handshake';

/** 核对码派生/格式化在 relayPairVerify.ts（纯 JS，renderer 可引）；这里 re-export 保持既有消费方不破。 */
export { deriveRelayPairVerify, formatRelayPairVerify } from './relayPairVerify';

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
