// ============================================================================
// Channel Outbound Mask（N-OUTBOUND-SENSITIVE-GUARD）
// ----------------------------------------------------------------------------
// 通道出站正文（模型写给 IM 的回复文本）在离开本机前过一次 shape-only 掩码
// （guardOutboundText：密钥/SSN/卡号/大陆身份证号；邮箱、路径、带 query 的
// URL 原样可读）。收口在 ChannelManager：getResponseCallback 返回的回调与
// sendMessage 都从这里包一道，通道插件（Feishu/Telegram/Api/通用）无感知。
// 掩码不留本地副本：会话记录仍是原文，出站只发掩码后文本。
// ============================================================================

import type { ChannelResponseCallback } from './channelInterface';
import { guardOutboundText } from '../security/sensitiveDataGuard';

export function maskOutboundChannelText(content: string): string {
  return guardOutboundText(content).text;
}

/**
 * 包装通道响应回调：sendText/editMessage 的正文出站前掩码，
 * 其余能力（typing/sendStream/sendCard）原样透传（本单范围只收口文本出口）。
 */
export function maskChannelResponseCallback(
  callback: ChannelResponseCallback,
): ChannelResponseCallback {
  const masked: ChannelResponseCallback = {
    ...callback,
    sendText: (content: string) => callback.sendText(maskOutboundChannelText(content)),
  };
  if (callback.editMessage) {
    const editMessage = callback.editMessage;
    masked.editMessage = (messageId: string, content: string) =>
      editMessage(messageId, maskOutboundChannelText(content));
  }
  return masked;
}
