import type { messages } from '../i18n';

/**
 * 连接失败的分类诊断（fix4-② 三分类 + relay 档，N-MOBILE-RELAY-PHONE）：①超时/无响应
 * ②连接被拒绝 ③握手/身份校验失败 ④relay 路失败（LAN 与中继都没走通）。
 * 分类由连接层上抛的 connectionError 决定（nativeCompanion 把原生网络错误分成
 * COMPANION_CONNECTION_REFUSED / 其余网络失败，companionStore 再映射到 connectionError），
 * UI 按这里的分类给一句人话 + 决定**哪个动作当主按钮**，不再铺 Wi-Fi 说明书。
 *
 * `action` 只挑主次，**不决定渲染几个按钮**（2026-09-16 N-MOBILE-RESCAN-DEADLOCK）：
 * 原来这句写的是「一个主动作」，落地时被读成「只渲染一个按钮」——relay 被拒判 reconnect
 * 于是只给「重新连接」，而重连试的是配对时写死的地址，换网后必败，用户拿不到唯一能救的
 * 「重新扫码」，只能删 app 重装。连不上那一态现在恒定渲染扫码 + 重连 + 忘记这台电脑三个动作。
 */
export type ConnectionDiagnosis = { sentence: string; action: 'scan' | 'reconnect' };

export function connectionDiagnosis(
  text: ReturnType<typeof messages>,
  companion: { connectionError: string | null },
): ConnectionDiagnosis {
  const error = companion.connectionError;
  // ③ 握手/身份校验失败：配对被拒（hostKey 不认 / epoch 翻篇 / 设备被撤销）与二维码问题
  // 一样，重连救不回来，主动作是重新扫码。
  if (error === 'connectionRejected' || error === 'connectionQrInvalid' || error === 'connectionScanFailed') {
    return { sentence: text[error], action: 'scan' };
  }
  // ④ relay 档（N-MOBILE-RELAY-PHONE）：走到这里说明 LAN 已失败、relay 也失败——按 relay
  // 的失败原因给句子（连不上 / 路由被拒），主动作仍是重连：重连先试 LAN，再落 relay。
  if (error === 'connectionRelayUnavailable' || error === 'connectionRelayRejected') {
    return { sentence: text[error], action: 'reconnect' };
  }
  // ② 连接被拒绝：宿主可达但端口没人听——Neo 没在运行。
  if (error === 'connectionRefused') return { sentence: text.connectionRefused, action: 'reconnect' };
  // ① 超时/无响应（含其余网络失败）：不在同一网、电脑睡眠、地址漂了。
  return { sentence: text.connectionUnavailable, action: 'reconnect' };
}

/**
 * 「上次同步 x 分钟前」（fix4-②：已连接态要给一个可核对的同步时间，而不是裸的「已连接」）。
 * 没同步过返回 null——那时显示「已连接」本身，不编一个时间。
 */
export function lastSyncCopy(text: ReturnType<typeof messages>, lastSyncAt: number | null, now: number): string | null {
  if (lastSyncAt == null) return null;
  const minutes = Math.max(0, Math.floor((now - lastSyncAt) / 60_000));
  if (minutes < 1) return text.lastSyncJustNow;
  if (minutes < 60) return text.lastSyncMinutesAgo.replace('{n}', String(minutes));
  return text.lastSyncHoursAgo.replace('{n}', String(Math.floor(minutes / 60)));
}
