import {
  isLocalHost,
  matchesHostList,
} from './managedBrowserHelpers';

export function validateBrowserWorkbenchUrl(
  url: string,
  policy: { allowedHosts: string[]; blockedHosts: string[] },
): { allowed: true } | { allowed: false; reason: string } {
  if (isBrowserWorkbenchUrlAllowed(url, policy)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `URL is blocked by Browser Workbench policy: ${url}`,
  };
}

export function isBrowserWorkbenchUrlAllowed(
  url: string,
  policy: { allowedHosts: string[]; blockedHosts: string[] },
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (['about:', 'data:', 'blob:'].includes(parsed.protocol)) {
    return true;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return false;
  }

  const host = parsed.hostname.toLowerCase();
  if (matchesHostList(host, policy.blockedHosts)) {
    return false;
  }
  if (policy.allowedHosts.length === 0) {
    return true;
  }
  return isLocalHost(host) || matchesHostList(host, policy.allowedHosts);
}
