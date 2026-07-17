import { AppWindow, ipcHost } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import { createLogger } from '../services/infra/logger';
import type { MCPOAuthConsentRequest, MCPOAuthConsentResponse } from '../../shared/contract';

export const MCP_OAUTH_CONSENT_TIMEOUT_MS = 2 * 60 * 1000;

const logger = createLogger('MCPOAuthConsent');

type ConsentDecision = 'authorize' | 'decline';

const pendingConsents = new Map<string, {
  resolve: (decision: ConsentDecision) => void;
  timeout: NodeJS.Timeout;
}>();

let handlerRegistered = false;

function registerMcpOAuthConsentResponseHandler(): void {
  if (handlerRegistered) return;
  handlerRegistered = true;

  ipcHost.handle(
    IPC_CHANNELS.MCP_OAUTH_CONSENT_RESPONSE,
    async (_event, response: MCPOAuthConsentResponse) => {
      const pending = pendingConsents.get(response.requestId);
      if (!pending) {
        logger.warn('Received MCP OAuth consent response for unknown request', {
          requestId: response.requestId,
        });
        return;
      }

      clearTimeout(pending.timeout);
      pendingConsents.delete(response.requestId);
      pending.resolve(response.action);
      logger.info('Received MCP OAuth consent response', {
        requestId: response.requestId,
        action: response.action,
      });
    },
  );
}

export async function requestMcpOAuthConsent(
  request: Omit<MCPOAuthConsentRequest, 'requestId'>,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  registerMcpOAuthConsentResponseHandler();

  const requestId = `mcp-oauth-consent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const consentRequest: MCPOAuthConsentRequest = {
    requestId,
    ...request,
  };

  const mainWindow = AppWindow.getAllWindows()[0];
  if (!mainWindow) {
    logger.warn('No window available for MCP OAuth consent, declining', {
      requestId,
      serverName: request.serverName,
    });
    return false;
  }

  mainWindow.webContents.send(IPC_CHANNELS.MCP_OAUTH_CONSENT_REQUEST, consentRequest);

  const timeoutMs = options.timeoutMs ?? MCP_OAUTH_CONSENT_TIMEOUT_MS;
  const decision = await new Promise<ConsentDecision>((resolve) => {
    const timeout = setTimeout(() => {
      pendingConsents.delete(requestId);
      logger.warn('MCP OAuth consent timed out', {
        requestId,
        serverName: request.serverName,
        timeoutMs,
      });
      resolve('decline');
    }, timeoutMs);
    timeout.unref?.();

    pendingConsents.set(requestId, { resolve, timeout });
  });

  return decision === 'authorize';
}
