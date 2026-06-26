export type PreviewHealthLocale = 'zh' | 'en';

export type PreviewHealthMessageKey =
  | 'skipped'
  | 'routeInAppPassed'
  | 'routeInAppFindings'
  | 'routeFallback'
  | 'routeSelfStartedPassed'
  | 'inspectedViewports'
  | 'unableToRun'
  | 'webServerUnavailable'
  | 'inAppUnavailable';

const messages: Record<PreviewHealthLocale, Record<PreviewHealthMessageKey, string>> = {
  zh: {
    skipped: 'artifact preview health 已跳过：{reason}',
    routeInAppPassed: 'artifact preview health 已通过 in-app browser 路径',
    routeInAppFindings: 'artifact preview health 已通过 in-app browser 路径完成检测',
    routeFallback: 'artifact preview health 因 {reason} 降级到 self-started Chrome',
    routeSelfStartedPassed: 'artifact preview health 已通过 {provider} 路径',
    inspectedViewports: 'artifact preview health 已检查 {count} 个 viewport',
    unableToRun: 'artifact preview health 无法运行：{reason}',
    webServerUnavailable: 'webServer 不可用：{reason}',
    inAppUnavailable: 'in-app browser 不可用：{reason}',
  },
  en: {
    skipped: 'artifact preview health skipped: {reason}',
    routeInAppPassed: 'artifact preview health passed via in-app browser',
    routeInAppFindings: 'artifact preview health inspected via in-app browser',
    routeFallback: 'artifact preview health fell back to self-started Chrome because {reason}',
    routeSelfStartedPassed: 'artifact preview health passed via {provider}',
    inspectedViewports: 'artifact preview health inspected {count} viewport(s)',
    unableToRun: 'Unable to run artifact preview health: {reason}',
    webServerUnavailable: 'webServer unavailable: {reason}',
    inAppUnavailable: 'in-app browser unavailable: {reason}',
  },
};

export function normalizePreviewHealthLocale(locale?: string | null): PreviewHealthLocale {
  return locale?.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

export function formatPreviewHealthMessage(
  key: PreviewHealthMessageKey,
  params: Record<string, string | number> = {},
  locale?: string | null,
): string {
  const template = messages[normalizePreviewHealthLocale(locale)][key];
  return template.replace(/\{([^}]+)\}/g, (_match, name: string) => String(params[name] ?? ''));
}
