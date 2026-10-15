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
  | 'webRepairRemaining'
  | 'webRepairUnavailable'
  | 'blank_body_text'
  | 'horizontal_overflow'
  | 'console_error'
  | 'page_error'
  | 'broken_image'
  | 'missing_main_element'
  | 'primary_button_not_visible'
  | 'responsive_breakpoint_failure';

const messages: Record<PreviewHealthLocale, Record<PreviewHealthMessageKey, string>> = {
  zh: {
    blank_body_text: '页面空白',
    horizontal_overflow: '内容超出页面宽度',
    console_error: '页面运行报错',
    page_error: '页面脚本出错',
    broken_image: '图片无法显示',
    missing_main_element: '缺少主要内容',
    primary_button_not_visible: '主要按钮不可见',
    responsive_breakpoint_failure: '部分屏幕尺寸下显示异常',
    webRepairUnavailable: '未能体检这个网页（预览检查不可用）',

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
    webRepairFixed: '网页显示问题已修好',
    webRepairRemaining: '网页仍有 {count} 个问题：{categories}',
  },
  en: {
    blank_body_text: 'blank page',
    horizontal_overflow: 'content wider than the page',
    console_error: 'page reports errors',
    page_error: 'page script errors',
    broken_image: 'images cannot be displayed',
    missing_main_element: 'main content missing',
    primary_button_not_visible: 'main button not visible',
    responsive_breakpoint_failure: 'display problems at some screen sizes',
    webRepairUnavailable: 'Could not check this web page (preview check unavailable)',

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
    webRepairRemaining: '{count} display problem(s) remain in the web page: {categories}',
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
