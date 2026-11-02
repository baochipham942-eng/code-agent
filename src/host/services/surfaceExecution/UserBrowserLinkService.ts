import { randomUUID } from 'node:crypto';
import type { SurfaceConversationSnapshotV1 } from '../../../shared/contract/surfaceExecution';
import { SURFACE_USER_BROWSER_AGENT_ID } from '../../../shared/contract/surfaceExecution';
import {
  validateUserBrowserInputPayload,
  type UserBrowserInputPayload,
} from '../../../shared/utils/userBrowserInputPayload';
import { getApplicationRunRegistry } from '../../app/applicationRunRegistry';
import type { RunHandle } from '../../runtime/runContext';
import type { RunRegistry } from '../../runtime/runRegistry';
import { dispatchUserBrowserInputOnPage } from '../infra/browser/userBrowserInputDispatch';
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

export type UserBrowserHistoryAction = 'back' | 'forward' | 'reload';

export interface ControlUserBrowserHistoryInput {
  conversationId: string;
  workspace: string;
  action: UserBrowserHistoryAction;
}

export interface DispatchUserBrowserInputInput {
  conversationId: string;
  workspace: string;
  /** 原始 payload；服务端再走白名单校验，禁止任意 CDP 直通 */
  input: unknown;
}

export interface SetUserBrowserViewportInput {
  conversationId: string;
  workspace: string;
  width: number;
  height: number;
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

function browserActionForInput(payload: UserBrowserInputPayload): string {
  switch (payload.kind) {
    case 'click':
      return 'click';
    case 'wheel':
      return 'scroll';
    case 'key':
      return 'press_key';
    case 'insertText':
      return 'type';
    case 'drag':
      return 'drag';
    default: {
      const _exhaustive: never = payload;
      throw new Error(`Unsupported input kind: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export class UserBrowserLinkService {
  private readonly runs = new Map<string, UserBrowserRun>();

  constructor(
    private readonly registry: RunRegistry = getApplicationRunRegistry(),
    private readonly runtime: UserBrowserRuntime = getSurfaceExecutionRuntime(),
    private readonly adapter: UserBrowserAdapter = getManagedBrowserProviderAdapter(),
  ) {}

  private ensureRun(conversationId: string, workspace: string): UserBrowserRun {
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
    return run;
  }

  async open(input: OpenUserBrowserLinkInput): Promise<UserBrowserLinkResult> {
    const conversationId = input.conversationId.trim();
    const workspace = input.workspace.trim();
    if (!conversationId || !workspace) {
      throw new Error('User browser navigation requires conversationId and workspace.');
    }
    const url = requireHttpUrl(input.url);
    const run = this.ensureRun(conversationId, workspace);

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

  async history(input: ControlUserBrowserHistoryInput): Promise<SurfaceConversationSnapshotV1> {
    const conversationId = input.conversationId.trim();
    const workspace = input.workspace.trim();
    if (!conversationId || !workspace) {
      throw new Error('User browser history control requires conversationId and workspace.');
    }
    const action = input.action;
    if (action !== 'back' && action !== 'forward' && action !== 'reload') {
      throw new Error(`Unsupported browser history action: ${String(action)}`);
    }

    const run = this.ensureRun(conversationId, workspace);

    const result = await this.adapter.execute({
      identity: run.identity,
      operationId: `user-browser-link:${action}:${randomUUID()}`,
      action,
      params: { action },
      async executeProvider(_signal, browserService) {
        const activeTab = browserService.getActiveTab();
        if (!activeTab) throw new Error('No active browser tab.');
        if (action === 'back') await browserService.goBack(activeTab.id);
        else if (action === 'forward') await browserService.goForward(activeTab.id);
        else await browserService.reload(activeTab.id);
        return { success: true, output: `Browser ${action}` };
      },
    });

    if (!result.success) {
      throw new Error(result.error || `User browser ${action} failed.`);
    }
    return this.runtime.snapshotConversation(conversationId);
  }

  /**
   * 面板 stage CSS 尺寸上报 → 托管浏览器 setViewport（R4 视口跟随，根治 letterbox）。
   */
  async setViewport(
    input: SetUserBrowserViewportInput,
  ): Promise<SurfaceConversationSnapshotV1> {
    const conversationId = input.conversationId.trim();
    const workspace = input.workspace.trim();
    if (!conversationId || !workspace) {
      throw new Error('User browser viewport requires conversationId and workspace.');
    }
    const width = Number(input.width);
    const height = Number(input.height);
    if (!Number.isFinite(width) || !Number.isFinite(height) || width < 1 || height < 1) {
      throw new Error('User browser viewport requires positive finite width/height.');
    }
    const run = this.ensureRun(conversationId, workspace);
    const result = await this.adapter.execute({
      identity: run.identity,
      operationId: `user-browser-link:set_viewport:${randomUUID()}`,
      action: 'set_viewport',
      params: { action: 'set_viewport', width, height },
      async executeProvider(_signal, browserService) {
        await browserService.setViewport(width, height);
        return { success: true, output: `Viewport ${Math.round(width)}x${Math.round(height)}` };
      },
    });
    if (!result.success) {
      throw new Error(result.error || 'User browser setViewport failed.');
    }
    return this.runtime.snapshotConversation(conversationId);
  }

  /**
   * 用户在实时画面上的点击/滚轮/键盘/拖拽透传。
   * 会话归属：必须带 conversationId + workspace；与 history 同链路走 user-browser-link run，
   * 与 agent 共享物理窗（ManagedBrowserProviderAdapter ensureBinding 共享语义）。
   */
  async dispatchUserInput(
    input: DispatchUserBrowserInputInput,
  ): Promise<SurfaceConversationSnapshotV1> {
    const conversationId = input.conversationId.trim();
    const workspace = input.workspace.trim();
    if (!conversationId || !workspace) {
      throw new Error('User browser input requires conversationId and workspace.');
    }

    const validated = validateUserBrowserInputPayload(input.input);
    if (!validated.ok) {
      throw new Error(validated.error);
    }
    const payload = validated.payload;
    const action = browserActionForInput(payload);
    const run = this.ensureRun(conversationId, workspace);

    const result = await this.adapter.execute({
      identity: run.identity,
      operationId: `user-browser-link:input:${payload.kind}:${randomUUID()}`,
      action,
      // 只传白名单字段摘要给 runtime 记账；真正执行走 dispatch 白名单实现，无 CDP 方法字段。
      params: { action, kind: payload.kind },
      async executeProvider(_signal, browserService) {
        const activeTab = browserService.getActiveTab();
        if (!activeTab) throw new Error('No active browser tab.');
        const viewport = browserService.getSessionState().viewport;
        // 二次校验：用真实视口收紧坐标上界（防渲染层伪造超大坐标）
        const again = validateUserBrowserInputPayload(payload, {
          viewportWidth: viewport?.width,
          viewportHeight: viewport?.height,
        });
        if (!again.ok) throw new Error(again.error);
        await dispatchUserBrowserInputOnPage(activeTab.page, again.payload);
        return { success: true, output: `User browser ${payload.kind}` };
      },
    });

    if (!result.success) {
      throw new Error(result.error || 'User browser input failed.');
    }
    return this.runtime.snapshotConversation(conversationId);
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
