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
  | 'inAppUnavailable'
  | 'webRepairNotice'
  | 'webRepairFixed'
  | 'webRepairRemaining';

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
    webRepairNotice: '网页交付物预览发现 {count} 个显示问题，正在自动修复…',
    webRepairFixed: '网页交付物的显示问题已自动修复',
    webRepairRemaining: '自动修复后网页交付物仍有 {count} 个显示问题',
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
    webRepairNotice: 'Found {count} display problem(s) in the web deliverable preview, repairing...',
    webRepairFixed: 'Display problem(s) in the web deliverable were fixed automatically',
    webRepairRemaining: '{count} display problem(s) remain in the web deliverable after auto-repair',
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
