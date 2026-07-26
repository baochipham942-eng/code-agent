import { VOICE_DEV_FLAG_KEY } from '@shared/constants';

/**
 * Phase 0 spike 的隐藏开关。在 app 里开 devtools 执行
 * `localStorage.setItem('code-agent:voice-spike', '1')` 后刷新即可看到面板。
 * Phase 1 换成正式设置项时删掉。
 */
export function isVoiceSpikeEnabled(): boolean {
  try {
    return window.localStorage.getItem(VOICE_DEV_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}
