import type { Translations } from '../../../../i18n';

/**
 * IACT `[label](!send)` chip 点击后的发送文本：把 label 包进「用户表态」模板，
 * 不裸发原文。裸发会被模型当成独立新指令重跑一遍（2026-08-01 真机事故：agent
 * 建议项「你来手动打开浏览器看」被点击后原样发回，模型把它当指令又抓取一次网页）。
 * 展示气泡文本直接取本函数返回值（随发送内容，不搞暗差异）。
 */
export function buildIactChipSendText(t: Translations, label: string): string {
  return t.chatInput.iactChipConfirmation.replace('{label}', label);
}
