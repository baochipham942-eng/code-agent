import { sha256 } from './lanProtocol';

// 核对码派生与格式化单独成模块：桌面 renderer（CompanionPairRequestCard）只需要这两个纯 JS
// 函数。relayPair.ts 顶部 import 的 noise-handshake 会把 WASM（sodium）拽进桌面包——harness 的
// CSP（script-src 'self' 'unsafe-inline'，无 unsafe-eval）直接让 renderer 启动崩成黑页
// （N-COMPANION-RELAY-ACCOUNT-RECOVER CI 实证，Eval Harness Gate 全头红）。

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
