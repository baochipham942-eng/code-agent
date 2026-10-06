// ADR-081 协议版本闸（纯判定，无 IO）：携带 environmentSelection 的消息必须带
// environment-selection/1。缺字段或版本不符 → 这一轮不开始，宿主只回稳定码
// ENVIRONMENT_PROTOCOL_UNSUPPORTED，不静默落回本机执行。不带 environmentSelection
// 的消息原样放行（默认本机，行为不变）。

import {
  ENVIRONMENT_PROTOCOL_UNSUPPORTED,
  ENVIRONMENT_SELECTION_PROTOCOL_VERSION,
} from '../../shared/contract/executionEnvironment';

export type EnvironmentProtocolCheck =
  | { supported: true }
  | { supported: false; errorCode: typeof ENVIRONMENT_PROTOCOL_UNSUPPORTED };

export function checkEnvironmentProtocol(body: unknown): EnvironmentProtocolCheck {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { supported: true };
  }
  if (!('environmentSelection' in body)) {
    return { supported: true };
  }
  return (body as { protocolVersion?: unknown }).protocolVersion === ENVIRONMENT_SELECTION_PROTOCOL_VERSION
    ? { supported: true }
    : { supported: false, errorCode: ENVIRONMENT_PROTOCOL_UNSUPPORTED };
}
