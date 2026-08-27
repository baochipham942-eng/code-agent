import { AppWindow, hasInteractiveUi, ipcHost } from '../platform';
import { IPC_CHANNELS } from '../../shared/ipc';
import { INTERACTION_TIMEOUTS } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';
import type { MCPOAuthConsentRequest, MCPOAuthConsentResponse } from '../../shared/contract';
import {
  deniedDecisionMetadata,
  headlessDecisionTimeoutReason,
  markDecisionRequestExpired,
  notifyDecisionNeeded,
  notifyIfLateDecisionResponse,
} from '../permissions/userDecision';
import { beginPendingMcpInteraction } from './mcpPendingInteraction';

export const MCP_OAUTH_CONSENT_TIMEOUT_MS = 2 * 60 * 1000;

const logger = createLogger('MCPOAuthConsent', { lane: 'mcp' });

type ConsentDecision = 'authorize' | 'decline';

const pendingConsents = new Map<string, {
  resolve: (result: { decision: ConsentDecision; timedOut: boolean }) => void;
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
        notifyIfLateDecisionResponse(response.requestId);
        logger.warn('Received MCP OAuth consent response for unknown request', {
          requestId: response.requestId,
        });
        return;
      }

      clearTimeout(pending.timeout);
      pendingConsents.delete(response.requestId);
      pending.resolve({ decision: response.action, timedOut: false });
      logger.info('Received MCP OAuth consent response', {
        requestId: response.requestId,
        action: response.action,
      });
    },
  );
}

interface McpOAuthConsentResult {
  granted: boolean;
  permissionDecision: 'allow' | 'deny';
  permissionDecisionReason: string;
}

export async function requestMcpOAuthConsent(
  request: Omit<MCPOAuthConsentRequest, 'requestId'>,
  options: { timeoutMs?: number } = {},
): Promise<McpOAuthConsentResult> {
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
    const reason = '当前运行环境没有可投递的交互界面，MCP OAuth 授权已按无头规则安全拒绝。';
    return { granted: false, ...deniedDecisionMetadata(reason) };
  }

  mainWindow.webContents.send(IPC_CHANNELS.MCP_OAUTH_CONSENT_REQUEST, consentRequest);
  notifyDecisionNeeded({
    title: 'MCP 服务器请求授权',
    body: `${request.serverName} 请求打开授权页面`,
  });

  const interactive = hasInteractiveUi();
  const headlessTimeoutMs = options.timeoutMs ?? MCP_OAUTH_CONSENT_TIMEOUT_MS;
  const timeoutMs = interactive ? INTERACTION_TIMEOUTS.PARKED_APPROVAL : headlessTimeoutMs;
  const endPendingInteraction = beginPendingMcpInteraction(request.serverName);
  let consentResult: { decision: ConsentDecision; timedOut: boolean };
  try {
    consentResult = await new Promise<{ decision: ConsentDecision; timedOut: boolean }>((resolve) => {
      const timeout = setTimeout(() => {
        pendingConsents.delete(requestId);
        markDecisionRequestExpired(requestId, 'MCP OAuth 授权请求');
        logger.warn('MCP OAuth consent timed out', {
          requestId,
          serverName: request.serverName,
          timeoutMs,
        });
        resolve({ decision: 'decline', timedOut: true });
      }, timeoutMs);
      timeout.unref?.();

      pendingConsents.set(requestId, { resolve, timeout });
    });
  } finally {
    endPendingInteraction();
  }

  if (consentResult.decision === 'authorize') {
    return {
      granted: true,
      permissionDecision: 'allow',
      permissionDecisionReason: '用户已授权 MCP OAuth。',
    };
  }

  const reason = consentResult.timedOut
    ? interactive
      ? '等待 MCP OAuth 授权超过 24 小时，停车请求已按安全兜底拒绝。'
      : headlessDecisionTimeoutReason(timeoutMs)
    : '用户拒绝了 MCP OAuth 授权。';
  return { granted: false, ...deniedDecisionMetadata(reason) };
}
