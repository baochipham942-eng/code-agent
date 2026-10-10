// ============================================================================
// Channel Listen Registry — 群监听绑定的进程内注册表（N-TRIGGER-GROUP-LISTEN）
// ----------------------------------------------------------------------------
// 准入门（inboundAccess/checkInboundAccess）需要知道「这个 (accountId, chatId)
// 是否有显式监听绑定」，但准入门不该反向依赖 CronService。这里只放一个可注入
// 的 resolver 槽：CronService 初始化时注入（enabled event 任务 + 显式 chatId
// 绑定才算数），关闭时注销。未注入 = 恒 false —— fail-closed：宁可继续把未 @
// 的群消息拒之门外，也不悄悄放监听事件进来。
// ============================================================================

export type ChannelListenResolver = (accountId: string, chatId: string) => boolean;

let resolver: ChannelListenResolver | undefined;

/** 注入/注销监听绑定解析器；传 undefined 注销（此后 hasChannelListenBinding 恒 false）。 */
export function setChannelListenResolver(next: ChannelListenResolver | undefined): void {
  resolver = next;
}

/** (accountId, chatId) 是否有显式监听绑定；未注入 resolver 时恒 false（fail-closed）。 */
export function hasChannelListenBinding(accountId: string, chatId: string): boolean {
  return resolver ? resolver(accountId, chatId) : false;
}
