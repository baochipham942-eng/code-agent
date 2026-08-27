/**
 * 发送动作与助手侧本地占位的时序不变量：占位必须在 send 真正返回之前就建立，
 * 一旦发送被拒（鉴权/模型配置不通）再撤销。放在 utils 而不是 ChatView 内，
 * 是为了让它有真实的生产消费方——测试不算消费方（knip production 档）。
 */
export async function sendWithImmediateAssistantFeedback(options: {
  showFeedback: () => void;
  clearFeedback: () => void;
  send: () => Promise<boolean>;
}): Promise<boolean> {
  options.showFeedback();
  try {
    const sent = await options.send();
    if (!sent) options.clearFeedback();
    return sent;
  } catch (error) {
    options.clearFeedback();
    throw error;
  }
}
