import { VOICE_DEV_FLAG_KEY } from '@shared/constants';

/**
 * Phase 0 spike 的隐藏开关，dev-only：只在 dev 构建（import.meta.env.DEV）下可达，
 * 打包/生产构建直接返回 false，调试挂件不外泄。
 * dev 里在 app 开 devtools 执行 `localStorage.setItem('code-agent:voice-spike', '1')`
 * 后刷新即可看到面板。Phase 1 换成正式设置项时删掉。
 */
export function isVoiceSpikeEnabled(): boolean {
  if (!import.meta.env.DEV) return false;
  // dev 下也认 host 按 .env 注入的全局，省去手动开 devtools。
  if ((window as unknown as Record<string, unknown>).__CODE_AGENT_VOICE_SPIKE__ === true) return true;
  try {
    return window.localStorage.getItem(VOICE_DEV_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}
