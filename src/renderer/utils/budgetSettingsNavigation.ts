import { useAppStore } from '../stores/appStore';

const BUDGET_SETTINGS_SECTION_ID = 'budget-settings-section';

function focusBudgetSection(): void {
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

