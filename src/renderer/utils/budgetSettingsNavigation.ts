import { useAppStore } from '../stores/appStore';

const BUDGET_SETTINGS_SECTION_ID = 'budget-settings-section';

function focusBudgetSection(): void {
  // 0/200ms 两段定时器可能晚于使用它的环境（jsdom 测试卸载）才 fire；
  // 生产 document 恒在不受影响，早退只把迟到的 fire 变成 no-op。
  if (typeof document === 'undefined') return;
  const section = document.getElementById(BUDGET_SETTINGS_SECTION_ID);
  if (!section) return;
  section.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  section.focus({ preventScroll: true });
}

/** Open the sole budget configuration home and bring its section into view. */
export function openBudgetSettings(): void {
  useAppStore.getState().openSettingsTab('general');
  // GeneralSettings is lazy-loaded. The second attempt covers the tab mount
  // without leaving routing state or a one-off anchor in the global store.
  window.setTimeout(focusBudgetSection, 0);
  window.setTimeout(focusBudgetSection, 200);
}

