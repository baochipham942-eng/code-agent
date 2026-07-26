import { VOICE_DEV_FLAG_KEY } from '@shared/constants';

/**
 * Phase 0 spike 的隐藏开关。在 app 里开 devtools 执行
 * `localStorage.setItem('code-agent:voice-spike', '1')` 后刷新即可看到面板。
 * Phase 1 换成正式设置项时删掉。
 */
export function isVoiceSpikeEnabled(): boolean {
  // 打包态没有 devtools，localStorage 改不了，所以也认 host 按 .env 注入的全局。
  if ((window as unknown as Record<string, unknown>).__CODE_AGENT_VOICE_SPIKE__ === true) return true;
  try {
    return window.localStorage.getItem(VOICE_DEV_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}
