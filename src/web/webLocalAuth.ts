import type { HandlerFn } from '../main/platform';
import type { AuthStatus, AuthUser } from '../shared/contract';
import { IPC_DOMAINS } from '../shared/ipc';

const LOCAL_WEB_AUTH_TEST_USER: AuthUser = {
  id: 'local-web-test-user',
  email: 'local-web-test-user@code-agent.local',
  username: 'local-web-test-user',
  nickname: 'Local Web Test User',
  isAdmin: true,
};

type DomainIpcRequest = {
  action: string;
  payload?: unknown;
  requestId?: string;
};

type DomainAuthHandler = (event: unknown, request?: DomainIpcRequest) => unknown | Promise<unknown>;

export function shouldUseLocalWebAuthStatus(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CODE_AGENT_E2E === '1' || env.CODE_AGENT_ENABLE_DEV_API === 'true';
}

export function getLocalWebAuthStatus(): AuthStatus {
  return {
    isAuthenticated: true,
    user: { ...LOCAL_WEB_AUTH_TEST_USER },
    isLoading: false,
    sessionTrustState: 'verified',
    authBackendAvailable: true,
    hasCachedAdminClaim: false,
  };
}

export function installLocalWebAuthStatusHandler(
  handlerMap: Map<string, HandlerFn>,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!shouldUseLocalWebAuthStatus(env)) {
    return false;
  }

  const originalAuthHandler = handlerMap.get(IPC_DOMAINS.AUTH) as DomainAuthHandler | undefined;
  handlerMap.set(IPC_DOMAINS.AUTH, async (event: unknown, request?: DomainIpcRequest) => {
    if (request?.action === 'getStatus') {
      return {
        success: true,
        data: getLocalWebAuthStatus(),
      };
    }

    if (originalAuthHandler) {
      return originalAuthHandler(event, request);
    }

    return {
      success: false,
      error: {
        code: 'AUTH_HANDLER_UNAVAILABLE',
        message: 'Auth handler unavailable in local web auth mode',
      },
    };
  });

  return true;
}
