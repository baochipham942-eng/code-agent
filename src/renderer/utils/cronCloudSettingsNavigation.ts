import { useAppStore } from '../stores/appStore';

const CRON_CLOUD_SETTINGS_SECTION_ID = 'cron-cloud-settings-section';

function focusCronCloudSection(): void {
  const section = document.getElementById(CRON_CLOUD_SETTINGS_SECTION_ID);
  if (!section) return;
  section.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  section.focus({ preventScroll: true });
}

/** Open the sole cloud scheduler (webhook delivery) configuration home and bring it into view. */
export function openCloudCronSettings(): void {
  useAppStore.getState().openSettingsTab('general');
  // GeneralSettings is lazy-loaded; same two-shot focus as openBudgetSettings.
  window.setTimeout(focusCronCloudSection, 0);
  window.setTimeout(focusCronCloudSection, 200);
}
