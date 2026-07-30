import type { VoiceWorkFailureMarker } from '../../../shared/contract/voice';

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
export function describeWorkFailure(
  rawDetail?: string,
  marker?: VoiceWorkFailureMarker,
): WorkFailureDescription {
  const detail = rawDetail?.trim();
  if (marker?.code === 'MODEL_AUTH') {
    // 屏幕上点名是哪个模型（用户要照着它去设置里找），耳朵里不念——
    // provider/model 是英文 id，念出来是一串噪音，且屏幕上本来就有。
    const which = marker.model
      ? `（${marker.provider ? `${marker.provider}/` : ''}${marker.model}）`
      : marker.provider ? `（${marker.provider}）` : '';
    return {
      screen: `执行任务的模型${which}还没有配置 API Key，去 设置 → 模型 配置后重试`,
      spoken: '执行任务的模型还没有配置 API Key，这件事没有完成。请在屏幕上打开 设置 → 模型 配置后重试。',
      ...(detail ? { detail } : {}),
    };
  }
  if (marker?.code === 'PROJECT_SOURCE_TRUST') {
    const copy = {
      source_missing: {
        screen: '项目文件夹已被删除或移动，请重新选择位置后再试',
        spoken: '项目文件夹已被删除或移动，这件事没有完成。请在屏幕上重新选择位置后再试。',
      },
      identity_changed: {
        screen: '这个位置的文件夹已经变了，请重新确认授权后再试',
        spoken: '这个位置的文件夹已经变了，这件事没有完成。请在屏幕上重新确认授权后再试。',
      },
      not_trusted: {
        screen: '项目文件夹还没有授权，请先完成授权再试',
        spoken: '项目文件夹还没有授权，这件事没有完成。请先在屏幕上完成授权再试。',
      },
    }[marker.kind];
    return { ...copy, ...(detail ? { detail } : {}) };
  }
  return {
    screen: '执行时出了问题，没有完成',
    spoken: '执行时出了问题，没有完成。详情在屏幕上。',
    ...(detail ? { detail } : {}),
  };
}
