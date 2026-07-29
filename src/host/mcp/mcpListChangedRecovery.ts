import { SdkErrorCode } from '@modelcontextprotocol/client';
import type {
  Client,
  ListChangedHandlers,
  McpSubscription,
  Prompt,
  Resource,
  SubscriptionFilter,
  Tool,
} from '@modelcontextprotocol/client';
import { createLogger } from '../services/infra/logger';
import { MCP_RESPONSE_CACHE_DEFAULT_TTL_MS } from './mcpTransport';

const logger = createLogger('MCPListChangedRecovery');
const RELISTEN_BACKOFF_MS = [250, 1_000, 4_000] as const;

function mcpErrorCode(error: unknown): unknown {
  return error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;
}

async function delay(delayMs: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

export async function maintainListChangedSubscription(input: {
  serverName: string;
  client: Pick<Client, 'listen'>;
  initialSubscription: McpSubscription;
  shouldContinue: () => boolean;
  onUnavailable: () => void;
  sleep?: (delayMs: number) => Promise<void>;
}): Promise<void> {
  let subscription = input.initialSubscription;
  const sleep = input.sleep ?? delay;

  while (input.shouldContinue()) {
    const closeReason = await subscription.closed;
    if (closeReason === 'local' || !input.shouldContinue()) return;

    let recovered: McpSubscription | undefined;
    for (let attempt = 0; attempt < RELISTEN_BACKOFF_MS.length; attempt += 1) {
      const backoffMs = RELISTEN_BACKOFF_MS[attempt];
      if (backoffMs === undefined) break;
      await sleep(backoffMs);
      if (!input.shouldContinue()) return;
      try {
        recovered = await input.client.listen(subscription.honoredFilter as SubscriptionFilter);
        logger.info(`Restored MCP listChanged subscription for ${input.serverName}`, {
          closeReason,
          attempt: attempt + 1,
        });
        break;
      } catch (error) {
        if (mcpErrorCode(error) === SdkErrorCode.MethodNotSupportedByProtocolVersion) {
          // Legacy connections keep using unsolicited listChanged notifications.
          return;
        }
        logger.warn(`Failed to restore MCP listChanged subscription for ${input.serverName}`, {
          attempt: attempt + 1,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (!recovered) {
      logger.warn(`MCP listChanged notifications are unavailable for ${input.serverName}; falling back to TTL refresh`, {
        ttlMs: MCP_RESPONSE_CACHE_DEFAULT_TTL_MS,
      });
      input.onUnavailable();
      return;
    }
    subscription = recovered;
  }
}

export interface ListRefreshCallbacks {
  shouldContinue: () => boolean;
  applyTools: (tools: Tool[]) => void;
  applyResources: (resources: Resource[]) => void;
  applyPrompts: (prompts: Prompt[]) => void;
}

export function createMcpListChangedHandlers(
  serverName: string,
  callbacks: Omit<ListRefreshCallbacks, 'shouldContinue'>,
): ListChangedHandlers {
  return {
    tools: {
      onChanged: (error, tools) => {
        if (error || !tools) {
          logger.warn(`listChanged(tools) refresh failed for ${serverName}`, { error: error?.message });
          return;
        }
        callbacks.applyTools(tools);
      },
    },
    resources: {
      onChanged: (error, resources) => {
        if (error || !resources) {
          logger.warn(`listChanged(resources) refresh failed for ${serverName}`, { error: error?.message });
          return;
        }
        callbacks.applyResources(resources);
      },
    },
    prompts: {
      onChanged: (error, prompts) => {
        if (error || !prompts) {
          logger.warn(`listChanged(prompts) refresh failed for ${serverName}`, { error: error?.message });
          return;
        }
        callbacks.applyPrompts(prompts);
      },
    },
  };
}

export class McpListChangedRecovery {
  private readonly fallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

  monitor(serverName: string, client: Client, callbacks: ListRefreshCallbacks): void {
    const subscription = client.autoOpenedSubscription;
    if (!subscription) return;
    void maintainListChangedSubscription({
      serverName,
      client,
      initialSubscription: subscription,
      shouldContinue: callbacks.shouldContinue,
      onUnavailable: () => this.scheduleFallback(serverName, client, callbacks),
    }).catch((error) => {
      logger.warn(`MCP listChanged subscription monitor failed for ${serverName}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleFallback(serverName, client, callbacks);
    });
  }

  stop(serverName: string): void {
    const timer = this.fallbackTimers.get(serverName);
    if (timer) clearTimeout(timer);
    this.fallbackTimers.delete(serverName);
  }

  private scheduleFallback(
    serverName: string,
    client: Client,
    callbacks: ListRefreshCallbacks,
  ): void {
    if (this.fallbackTimers.has(serverName)) return;
    const refresh = async (): Promise<void> => {
      this.fallbackTimers.delete(serverName);
      if (!callbacks.shouldContinue()) return;
      await this.refreshFromOrigin(serverName, client, callbacks);
      if (!callbacks.shouldContinue()) return;
      const timer = setTimeout(() => void refresh(), MCP_RESPONSE_CACHE_DEFAULT_TTL_MS);
      this.fallbackTimers.set(serverName, timer);
    };
    const timer = setTimeout(() => void refresh(), MCP_RESPONSE_CACHE_DEFAULT_TTL_MS);
    this.fallbackTimers.set(serverName, timer);
  }

  private async refreshFromOrigin(
    serverName: string,
    client: Client,
    callbacks: ListRefreshCallbacks,
  ): Promise<void> {
    const capabilities = client.getServerCapabilities();
    const refreshes: Promise<void>[] = [];
    if (!capabilities || capabilities.tools) {
      refreshes.push(client.listTools(undefined, { cacheMode: 'refresh' })
        .then(({ tools }) => callbacks.applyTools(tools)));
    }
    if (!capabilities || capabilities.resources) {
      refreshes.push(client.listResources(undefined, { cacheMode: 'refresh' })
        .then(({ resources }) => callbacks.applyResources(resources)));
    }
    if (!capabilities || capabilities.prompts) {
      refreshes.push(client.listPrompts(undefined, { cacheMode: 'refresh' })
        .then(({ prompts }) => callbacks.applyPrompts(prompts)));
    }
    const outcomes = await Promise.allSettled(refreshes);
    const failures = outcomes.filter((outcome) => outcome.status === 'rejected');
    if (failures.length > 0) {
      logger.warn(`TTL fallback could not refresh every MCP list for ${serverName}`, {
        failures: failures.length,
      });
    }
  }
}
