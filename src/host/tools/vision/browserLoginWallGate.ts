import type { ToolContext, ToolExecutionResult } from '../types';
import { getPermissionModeManager } from '../../permissions/modes';
import { noteUnattendedRunTerminal } from '../../agent/unattendedApprovalTerminal';
import {
  buildCronLoginWallStopCode,
  isBrowserLoginWall,
  siteOriginFromUrl,
} from '../../../shared/utils/browserLoginWall';
import type { PageContent } from '../../services/infra/browser/types';

interface LoginWallBrowserService {
  getPageContent(tabId?: string): Promise<PageContent>;
}

export interface BrowserLoginWallGateInput {
  browserService: LoginWallBrowserService;
  tabId?: string;
  context: Pick<ToolContext, 'sessionId' | 'forceFinalResponse'>;
  pageContent?: PageContent;
}

/**
 * Unattended cron runs must stop at a real login wall. Interactive runs return
 * null and retain the existing model-handled behaviour.
 */
export async function enforceBrowserLoginWallStop(
  input: BrowserLoginWallGateInput,
): Promise<ToolExecutionResult | null> {
  const sessionId = input.context.sessionId;
  if (!sessionId || !getPermissionModeManager().isUnattendedSession(sessionId)) return null;

  let content: PageContent;
  try {
    content = input.pageContent ?? await input.browserService.getPageContent(input.tabId);
  } catch {
    return null;
  }

  const loginWall = isBrowserLoginWall({
    title: content.title,
    visibleText: content.text,
    passwordInputPresent: content.passwordInputPresent === true,
    loginFormPresent: content.loginFormPresent === true,
  });
  if (!loginWall) return null;

  const siteOrigin = siteOriginFromUrl(content.url);
  const code = buildCronLoginWallStopCode(siteOrigin);
  noteUnattendedRunTerminal(sessionId, code);
  input.context.forceFinalResponse?.(
    'cron-login-wall-stop',
    `<force-final-response reason="cron-login-wall-stop">Stop this unattended run. The user must log in to ${siteOrigin} again before the next scheduled run.</force-final-response>`,
  );
  return {
    success: false,
    error: `${code}; stop this unattended run and tell the user to log in again.`,
    metadata: {
      code: 'CRON_LOGIN_WALL_STOP',
      siteOrigin,
      stopRun: true,
      forceFinalResponse: true,
      userActionRequired: true,
    },
  };
}
