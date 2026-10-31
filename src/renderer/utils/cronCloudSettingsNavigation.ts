import { useAppStore } from '../stores/appStore';

const CRON_CLOUD_SETTINGS_SECTION_ID = 'cron-cloud-settings-section';

function focusCronCloudSection(): void {
  // 0/200ms 两段定时器可能晚于使用它的环境（jsdom 测试卸载）才 fire；
  // 生产 document 恒在不受影响，早退只把迟到的 fire 变成 no-op。
  if (typeof document === 'undefined') return;
  const section = document.getElementById(CRON_CLOUD_SETTINGS_SECTION_ID);
  if (!section) return;
  section.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  section.focus({ preventScroll: true });
}

/** Open the sole cloud scheduler (webhook delivery) configuration home and bring it into view. */
export function openCloudCronSettings(): void {
  // 带返回落点：用户关掉设置（X / Esc）时直接回自动化页，编辑器凭暂存草稿重开。
  useAppStore.getState().openSettingsWithReturn('general', 'cronCenter');
  // GeneralSettings is lazy-loaded; same two-shot focus as openBudgetSettings.
  window.setTimeout(focusCronCloudSection, 0);
  window.setTimeout(focusCronCloudSection, 200);
}
