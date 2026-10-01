import type { AppshotErrorEvent } from '@shared/contract/appshot';
import type { Translations } from '../i18n';

export function getAppshotErrorMessage(payload: AppshotErrorEvent, t: Translations): string {
  const detail = payload.reasonCode === 'app_closed' && payload.appName
    ? t.inputAddMenu.attachLastAppClosed.replace('{appName}', payload.appName)
    : payload.reasonCode === 'finder_desktop'
      ? t.inputAddMenu.attachLastAppFinderDesktop
      : payload.message || payload.code || t.chatInput.unknownError;
  return `${t.inputAddMenu.appshotFailedPrefix}${detail}`;
}
