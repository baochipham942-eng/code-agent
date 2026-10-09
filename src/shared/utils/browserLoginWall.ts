/**
 * Strict login-wall evidence shared by the managed browser and the JEV step.
 * A bare login link is deliberately insufficient: the page must also expose a
 * password field or a form while its visible copy says that authentication is
 * required.
 */

export const CRON_LOGIN_WALL_STOP = 'CRON_LOGIN_WALL_STOP' as const;

const LOGIN_WALL_COPY = /登录后继续|请先登录|请登录|需要登录|sign in to continue|log in to continue|please sign in|please log in|login required|sign in required|not signed in|authentication required|needs login/i;

export interface BrowserLoginWallEvidence {
  title?: string;
  headings?: readonly string[];
  visibleText?: string;
  passwordInputPresent: boolean;
  loginFormPresent: boolean;
}

export function isBrowserLoginWall(evidence: BrowserLoginWallEvidence): boolean {
  const primary = [
    evidence.title ?? '',
    ...(evidence.headings ?? []),
    evidence.visibleText ?? '',
  ].join('\n');
  return LOGIN_WALL_COPY.test(primary)
    && (evidence.passwordInputPresent || evidence.loginFormPresent);
}

export function siteOriginFromUrl(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function buildCronLoginWallStopCode(siteOrigin: string): string {
  return `${CRON_LOGIN_WALL_STOP}|${siteOriginFromUrl(siteOrigin)}`;
}

export function parseCronLoginWallStop(error: unknown): { siteOrigin: string } | undefined {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.startsWith(`${CRON_LOGIN_WALL_STOP}|`)) return undefined;
  const rawOrigin = message.slice(CRON_LOGIN_WALL_STOP.length + 1).split(';', 1)[0].trim();
  if (!rawOrigin) return undefined;
  return { siteOrigin: siteOriginFromUrl(rawOrigin) };
}
