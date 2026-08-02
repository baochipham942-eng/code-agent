import { randomUUID } from 'node:crypto';
import type { SurfaceConversationSnapshotV1 } from '../../../shared/contract/surfaceExecution';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../shared/contract/surfaceExecution';
import { getApplicationRunRegistry } from '../../app/applicationRunRegistry';
import type { RunHandle } from '../../runtime/runContext';
import type { RunRegistry } from '../../runtime/runRegistry';
import {
  getManagedBrowserProviderAdapter,
  type ManagedBrowserProviderAdapter,
} from './ManagedBrowserProviderAdapter';
import {
  getSurfaceExecutionRuntime,
  type SurfaceExecutionRuntime,
  type SurfaceRuntimeIdentityV1,
} from './SurfaceExecutionRuntime';


interface UserBrowserRun {
  handle: RunHandle;
  identity: SurfaceRuntimeIdentityV1;
}

export interface OpenUserBrowserLinkInput {
  conversationId: string;
  url: string;
  workspace: string;
}

export interface UserBrowserLinkResult {
  conversationId: string;
  runId: string;
  surfaceSessionId: string;
  snapshot: SurfaceConversationSnapshotV1;
}

type UserBrowserRuntime = Pick<SurfaceExecutionRuntime, 'endRun' | 'snapshotConversation'>;
type UserBrowserAdapter = Pick<ManagedBrowserProviderAdapter, 'execute'>;

function requireHttpUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('User browser links only accept http(s) URLs.');
  }
  return parsed.href;
}

export class UserBrowserLinkService {
  private readonly runs = new Map<string, UserBrowserRun>();

  constructor(
    private readonly registry: RunRegistry = getApplicationRunRegistry(),
    private readonly runtime: UserBrowserRuntime = getSurfaceExecutionRuntime(),
    private readonly adapter: UserBrowserAdapter = getManagedBrowserProviderAdapter(),
  ) {}

  async open(input: OpenUserBrowserLinkInput): Promise<UserBrowserLinkResult> {
    const conversationId = input.conversationId.trim();
    const workspace = input.workspace.trim();
    if (!conversationId || !workspace) {
      throw new Error('User browser navigation requires conversationId and workspace.');
    }
    const url = requireHttpUrl(input.url);
    let run = this.runs.get(conversationId);
    if (!run) {
      const handle = this.registry.startAuxiliary({
        runId: `user-browser-link:${randomUUID()}`,
        sessionId: conversationId,
        workspace,
      });
      run = {
        handle,
        identity: {
          conversationId,
          runId: handle.context.runId,
          agentId: SURFACE_USER_BROWSER_AGENT_ID,
        },
      };
      this.runs.set(conversationId, run);
    }

    let result;
    try {
      result = await this.adapter.execute({
        identity: run.identity,
        operationId: `user-browser-link:navigate:${randomUUID()}`,
        action: 'navigate',
        params: { action: 'navigate', url },
        async executeProvider(_signal, browserService) {
          const activeTab = browserService.getActiveTab();
          if (activeTab) await browserService.navigate(url, activeTab.id);
          else await browserService.newTab(url);
          return { success: true, output: `Navigated to ${url}` };
        },
      });
    } catch (error) {
      await this.finish(conversationId, run, 'user').catch(() => undefined);
      throw error;
    }

    if (!result.success) {
      const message = result.error || 'User browser navigation failed.';
      await this.finish(conversationId, run, 'user').catch(() => undefined);
      throw new Error(message);
    }
    const surfaceSessionId = typeof result.metadata?.surfaceSessionId === 'string'
      ? result.metadata.surfaceSessionId
      : '';
    if (!surfaceSessionId) {
      await this.finish(conversationId, run, 'user').catch(() => undefined);
      throw new Error('User browser navigation did not create a Surface session.');
    }
    return {
      conversationId,
      runId: run.identity.runId,
      surfaceSessionId,
      snapshot: this.runtime.snapshotConversation(conversationId),
    };
  }

  async end(
    conversationId: string,
    reason: 'user' | 'session-switch' = 'user',
  ): Promise<SurfaceConversationSnapshotV1 | null> {
    const normalized = conversationId.trim();
    const run = this.runs.get(normalized);
    if (!run) return null;
    await this.finish(normalized, run, reason);
    return this.runtime.snapshotConversation(normalized);
  }

  private async finish(
    conversationId: string,
    run: UserBrowserRun,
    reason: 'user' | 'session-switch',
  ): Promise<void> {
    if (this.runs.get(conversationId) !== run) return;
    this.runs.delete(conversationId);
    let cancellationError: unknown;
    try {
      await run.handle.cancel(reason);
    } catch (error) {
      cancellationError = error;
    }
    try {
      await this.runtime.endRun(run.identity);
    } finally {
      this.registry.unregister(run.identity.runId, run.handle);
    }
    if (cancellationError) throw cancellationError;
  }
}

let userBrowserLinkService: UserBrowserLinkService | null = null;

export function getUserBrowserLinkService(): UserBrowserLinkService {
  userBrowserLinkService ??= new UserBrowserLinkService();
  return userBrowserLinkService;
}

export function resetUserBrowserLinkServiceForTests(): void {
  userBrowserLinkService = null;
}
