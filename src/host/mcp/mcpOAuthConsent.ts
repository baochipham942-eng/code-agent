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

const MCP_OAUTH_CONSENT_TIMEOUT_MS = 2 * 60 * 1000;

const logger = createLogger('MCPOAuthConsent', { lane: 'mcp' });

type ConsentDecision = 'authorize' | 'decline';

const pendingConsents = new Map<string, {
  resolve: (result: { decision: ConsentDecision; timedOut: boolean }) => void;
  timeout: NodeJS.Timeout;
  request: MCPOAuthConsentRequest;
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
      pending.resolve({
        decision: response.action === 'authorize' ? 'authorize' : 'decline',
        timedOut: response.action === 'timeout',
      });
      logger.info('Received MCP OAuth consent response', {
        requestId: response.requestId,
        action: response.action,
      });
    },
  );
}

interface McpOAuthConsentResult {
  granted: boolean;
  timedOut: boolean;
  permissionDecision: 'allow' | 'deny';
  permissionDecisionReason: string;
}

export function cancelPendingMcpOAuthConsent(serverName: string): boolean {
  const entry = Array.from(pendingConsents.entries())
    .find(([, pending]) => pending.request.serverName === serverName);
  if (!entry) return false;

  const [requestId, pending] = entry;
  clearTimeout(pending.timeout);
  pendingConsents.delete(requestId);
  pending.resolve({ decision: 'decline', timedOut: false });
  logger.info('Cancelled pending MCP OAuth consent request', { requestId, serverName });
  return true;
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
  const isConnector = request.kind === 'connector';
  if (!mainWindow) {
    logger.warn('No window available for MCP OAuth consent, declining', {
      requestId,
      serverName: request.serverName,
    });
    const reason = isConnector
      ? '当前运行环境没有可投递的交互界面，SaaS 连接器 OAuth 授权已按无头规则安全拒绝。'
      : '当前运行环境没有可投递的交互界面，MCP OAuth 授权已按无头规则安全拒绝。';
    return { granted: false, timedOut: false, ...deniedDecisionMetadata(reason) };
  }

  const interactive = hasInteractiveUi();
  const headlessTimeoutMs = options.timeoutMs ?? MCP_OAUTH_CONSENT_TIMEOUT_MS;
  const timeoutMs = isConnector
    ? options.timeoutMs ?? INTERACTION_TIMEOUTS.CONNECTOR_OAUTH_CONSENT
    : interactive ? INTERACTION_TIMEOUTS.PARKED_APPROVAL : headlessTimeoutMs;
  const endPendingInteraction = beginPendingMcpInteraction(request.serverName);
  const consentPromise = new Promise<{ decision: ConsentDecision; timedOut: boolean }>((resolve) => {
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

    pendingConsents.set(requestId, { resolve, timeout, request: consentRequest });
  });

  mainWindow.webContents.send(IPC_CHANNELS.MCP_OAUTH_CONSENT_REQUEST, consentRequest);
  logger.info('Dispatched MCP OAuth consent request', {
    requestId,
    serverName: request.serverName,
    kind: request.kind ?? 'mcp',
    timeoutMs,
  });
  notifyDecisionNeeded({
    title: isConnector ? 'SaaS 连接器请求授权' : 'MCP 服务器请求授权',
    body: `${request.serverName} 请求打开授权页面`,
  });

  let consentResult: { decision: ConsentDecision; timedOut: boolean };
  try {
    consentResult = await consentPromise;
  } finally {
    endPendingInteraction();
  }

  if (consentResult.decision === 'authorize') {
    return {
      granted: true,
      timedOut: false,
      permissionDecision: 'allow',
      permissionDecisionReason: isConnector ? '用户已授权 SaaS 连接器 OAuth。' : '用户已授权 MCP OAuth。',
    };
  }

  const reason = consentResult.timedOut
    ? isConnector
      ? '等待 SaaS 连接器授权确认超时，已停止连接。请重新点击“连接”后再试。'
      : interactive
        ? '等待 MCP OAuth 授权超过 24 小时，停车请求已按安全兜底拒绝。'
      : headlessDecisionTimeoutReason(timeoutMs)
    : isConnector ? '用户拒绝了 SaaS 连接器 OAuth 授权。' : '用户拒绝了 MCP OAuth 授权。';
  return { granted: false, timedOut: consentResult.timedOut, ...deniedDecisionMetadata(reason) };
}
