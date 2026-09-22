type CapacitorGlobal = { getPlatform?: () => string };

function capacitorPlatform(): string {
  const cap = (globalThis as { Capacitor?: CapacitorGlobal }).Capacitor;
  const name = cap?.getPlatform?.();
  return typeof name === 'string' && name.length > 0 ? name : 'web';
}

/**
 * Android WebView cannot inline PDF. iOS WKWebView can, via a blob URL in iframe/embed.
 * Capacitor platform wins (same getPlatform() the rest of the mobile shell uses);
 * on web, UA distinguishes Android Chrome from iOS Safari / desktop.
 */
export function canInlinePdf(
  platform: string = capacitorPlatform(),
  userAgent: string = typeof navigator === 'undefined' ? '' : navigator.userAgent,
): boolean {
  if (platform === 'android') return false;
  if (platform === 'ios') return true;
  return !/Android/i.test(userAgent);
}
