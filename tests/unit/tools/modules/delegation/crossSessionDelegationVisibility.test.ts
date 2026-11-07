import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import { ToolRegistry } from '../../../../../src/host/tools/registry';
import { registerMigratedTools } from '../../../../../src/host/tools/modules';
import { getProtocolRegistry, resetProtocolRegistry } from '../../../../../src/host/tools/protocolRegistry';
import {
  getAllToolDefinitions,
  getCoreToolDefinitions,
  getDeferredToolsSummary,
  withDesignCanvasTools,
} from '../../../../../src/host/tools/dispatch/toolDefinitions';
import { CORE_TOOLS, DEFERRED_TOOLS_META } from '../../../../../src/host/services/toolSearch/deferredTools';
import { isCrossSessionDelegationEnabled } from '../../../../../src/host/services/delegation/crossSessionDelegationFlag';
import { applySchema } from '../../../../../src/host/services/core/database/schema';
import { filterToolsByRunPolicy } from '../../../../../src/host/agent/runtime/toolRunPolicy';
import { getTextForegroundToolNamesForPrompt } from '../../../../../src/host/app/sessionCommandCenterBrain';

vi.mock('../../../../../src/host/mcp', () => ({
  getMCPClient: () => ({ getToolDefinitions: () => [] }),
}));

const DELEGATION_TOOL_NAMES = ['delegate_session', 'list_session_candidates'] as const;

// 本单之前（origin/main e6067f5f9）的文字前台 12 工具：flag 关时前台面必须原样，
// 模型可见字节零变化。
const PRE_CHANGE_TEXT_FOREGROUND_TOOL_NAMES = [
  'spawn_agent',
  'ListDirectory',
  'delegate_task',
  'steer_task',
  'cancel_task',
  'task_status',
  'Write',
  'Glob',
  'Read',
  'Edit',
  'Grep',
  'AskUserQuestion',
] as const;

// 不命中任何连接器意图的英文委派 prompt（getNativeConnectorToolNamesForIntent 零副作用，
// 不触 configService/connector registry）。
const FOREGROUND_ALLOWLIST_PROMPT = 'please delegate this to another session';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  applySchema(db, { info() {}, warn() {}, error() {}, debug() {} } as never);
  return db;
}

afterEach(() => {
  delete process.env.CODE_AGENT_CROSS_SESSION_DELEGATION;
  resetProtocolRegistry();
});

describe('crossSessionDelegation visibility', () => {
  it('flag off: both names absent from registry, core, deferred metadata, all-definitions and summary', () => {
    expect(isCrossSessionDelegationEnabled()).toBe(false);
    const registry = new ToolRegistry();
    registerMigratedTools(registry, 'linux', false);
    expect(registry.has('delegate_session')).toBe(false);
    expect(registry.has('list_session_candidates')).toBe(false);
    expect(CORE_TOOLS).not.toContain('delegate_session');
    expect(DEFERRED_TOOLS_META.map((meta) => meta.name)).not.toContain('list_session_candidates');

    // 生产装配路径（webServer → getProtocolRegistry → registerMigratedTools 默认参）
    resetProtocolRegistry();
    expect(getProtocolRegistry().has('delegate_session')).toBe(false);
    expect(getAllToolDefinitions().map((tool) => tool.name)).not.toContain('delegate_session');
    expect(getAllToolDefinitions().map((tool) => tool.name)).not.toContain('list_session_candidates');
    expect(getCoreToolDefinitions().map((tool) => tool.name)).not.toContain('delegate_session');
    const summary = getDeferredToolsSummary();
    expect(summary).not.toContain('delegate_session');
    expect(summary).not.toContain('list_session_candidates');
    // 关flag时逐轮注入是恒等函数（模型可见工具表零污染）
    const tools = getAllToolDefinitions();
    expect(withDesignCanvasTools(tools, undefined, false)).toBe(tools);
  });

  it('flag on: registered in the protocol registry, injected once per turn, never added to core/deferred tables', () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    resetProtocolRegistry();
    const registry = getProtocolRegistry();
    expect(registry.has('delegate_session')).toBe(true);
    expect(registry.has('list_session_candidates')).toBe(true);
    expect(getAllToolDefinitions().map((tool) => tool.name)).toEqual(
      expect.arrayContaining([...DELEGATION_TOOL_NAMES]),
    );
    // 静态表永远不收（决策：not in CORE_TOOLS, not in DEFERRED_TOOLS_META, ever）
    expect(CORE_TOOLS).not.toContain('delegate_session');
    expect(DEFERRED_TOOLS_META.map((meta) => meta.name)).not.toContain('delegate_session');
    expect(getDeferredToolsSummary()).not.toContain('delegate_session');

    const injected = withDesignCanvasTools([], undefined, true);
    expect(injected.map((tool) => tool.name)).toEqual([...DELEGATION_TOOL_NAMES]);
    // 非重入：已注入的表再过一遍不重复（与画布注入同一去重规矩）
    expect(withDesignCanvasTools(injected, undefined, true)).toHaveLength(DELEGATION_TOOL_NAMES.length);
  });

  it('flag on: both delegation names enter the text-foreground allowlist and survive the inference.ts assembly + run policy', () => {
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '1';
    resetProtocolRegistry();

    // ① 前台 allowlist（web routes/agent.ts 与桌面 withSessionCommandCenterBrain 同源）
    const allowlist = getTextForegroundToolNamesForPrompt(FOREGROUND_ALLOWLIST_PROMPT);
    expect(allowlist).toEqual(expect.arrayContaining([...DELEGATION_TOOL_NAMES]));

    // ② 复刻 inference.ts 的组装次序：基础表（core + loaded deferred）→
    //    withDesignCanvasTools(…, isCrossSessionDelegationEnabled()) → run policy 收窄。
    //    toolScope / skillToolBoundary 未设时 workbench-scope 与 strict-skill 两个过滤器
    //    恒等（workbenchToolScope.ts / skillBoundaryScope.ts 的无 scope 早退），略去不改变判定。
    const injected = withDesignCanvasTools(getAllToolDefinitions(), undefined, true);
    const ctx = {
      messages: [{ role: 'user', content: FOREGROUND_ALLOWLIST_PROMPT }],
      allowedToolNames: allowlist,
    } as never;
    const kept = filterToolsByRunPolicy(injected, ctx).map((tool) => tool.name);
    expect(kept).toContain('delegate_session');
    expect(kept).toContain('list_session_candidates');
  });

  it('flag off: foreground allowlist unchanged — neither delegation name present and the list equals the pre-change 12', () => {
    expect(isCrossSessionDelegationEnabled()).toBe(false);
    resetProtocolRegistry();
    const names = getTextForegroundToolNamesForPrompt(FOREGROUND_ALLOWLIST_PROMPT);
    expect(names).not.toContain('delegate_session');
    expect(names).not.toContain('list_session_candidates');
    expect([...names].sort()).toEqual([...PRE_CHANGE_TEXT_FOREGROUND_TOOL_NAMES].sort());
  });

  it('force-registered while off: both handlers reject FEATURE_DISABLED and write zero rows', async () => {
    const db = openDb();
    const registry = new ToolRegistry();
    registerMigratedTools(registry, 'linux', true);
    expect(registry.has('delegate_session')).toBe(true);
    process.env.CODE_AGENT_CROSS_SESSION_DELEGATION = '0';
    const delegationRuntime = {
      getDb: () => db,
      listSessions: () => [{ id: 'target', title: 'Target', updatedAt: 1, sessionType: 'chat' }],
      getRuns: () => [],
      getRun: () => undefined,
      now: () => 1,
    };
    const ctx = {
      sessionId: 'origin', turnId: 'turn-1', workingDir: '/tmp', workspace: '/tmp',
      abortSignal: new AbortController().signal,
      logger: { debug() {}, info() {}, warn() {}, error() {} }, emit() {},
      delegationRuntime,
    };
    const allow = async () => ({ allow: true as const });
    const delegate = await registry.resolve('delegate_session');
    const delegated = await delegate.execute({ action: 'delegate_existing', candidateRef: 'ref', text: 'x' }, ctx, allow);
    expect(delegated).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' });
    const lister = await registry.resolve('list_session_candidates');
    const listed = await lister.execute({}, ctx, allow);
    expect(listed).toMatchObject({ ok: false, code: 'FEATURE_DISABLED' });
    expect(db.prepare('SELECT count(*) AS count FROM session_delegations').get()).toMatchObject({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM queued_inputs').get()).toMatchObject({ count: 0 });
    expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toMatchObject({ count: 0 });
    db.close();
  });
});
