export interface WorkFailureDescription {
  spoken: string;
  screen: string;
  detail?: string;
}

/**
 * 执行异常 → 用户可见失败说明的单一出口。
 *
 * 未知异常不猜类型：主文案只陈述结果，原文留在屏幕详情里，绝不进耳朵。
 * 可识别的结构化错误由生产者带稳定标记，后续分支只认标记、不解析英文 message。
 */
export function describeWorkFailure(rawDetail?: string): WorkFailureDescription {
  const detail = rawDetail?.trim();
  return {
    screen: '执行时出了问题，没有完成',
    spoken: '执行时出了问题，没有完成。详情在屏幕上。',
    ...(detail ? { detail } : {}),
  };
}
