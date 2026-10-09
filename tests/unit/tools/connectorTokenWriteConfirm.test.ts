// ============================================================================
// http_request 连接器令牌写确认（N-HTTPREQ-CONNECTOR-TOKEN-CONFIRM）行为级测试
// ----------------------------------------------------------------------------
// 真实 ToolExecutor + 真实分类器 + mock providerRegistry / Jev 分类档
// （toolExecutor.peerOrigin / parkingBeforeAutoApprove 同款 harness）。覆盖门：
// - (a) 分类器确定性规则 C1b：POST/PUT/PATCH/DELETE 到已连接主机 → ask + trustBoundary，
//       先于 LLM 档；GET/HEAD/OPTIONS 与未连接主机的 POST 保持 main 基线（fallback ask）
// - (b) 三条自动放行路线全部失效：分类器/LLM approve、settings autoApprove.network /
//       devModeAutoApprove（真实 OrchestratorPermissionIsland）、renderer allow-always /
//       session 权限记忆（真实 permissionStore）
// - (c) 审批负载带连接器身份 + 「授权将附加到本次请求」声明 + connectorTokenAttached
// - (d) skill preApprovedTools 不得跳过分类
// ============================================================================

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/host/services/infra/logger', () => {
  const fake = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: vi.fn(() => fake), logger: fake, default: fake };
});

vi.mock('../../../src/host/services/infra/notificationService', () => ({
  notificationService: { notifyNeedsInput: vi.fn() },
}));

const connectorEnv = vi.hoisted(() => ({
  provider: undefined as undefined | { id: string; displayName: string },
}));

// 与真实 findConnectedOAuthProviderForHost 同口径：按 hostname 匹配已连接描述符。
vi.mock('../../../src/host/connectors/oauth/providerRegistry', () => ({
  findConnectedOAuthProviderForHost: vi.fn((hostname: string) => (
    hostname.trim().toLowerCase() === 'open.feishu.cn' && connectorEnv.provider
      ? connectorEnv.provider
      : undefined
  )),
  getOAuthAuthorizationHeader: vi.fn(async () => 'Bearer probe-token'),
}));

const jevState = vi.hoisted(() => ({ approve: false }));

vi.mock('../../../src/host/tools/permissionClassifierJev', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/tools/permissionClassifierJev')>();
  return {
    ...original,
    classifyByJev: vi.fn(async (...args: Parameters<typeof original.classifyByJev>) => {
      if (jevState.approve) {
        return {
          decision: 'approve' as const,
          reason: 'jev test approve',
          confidence: 1,
          cached: false,
        };
      }
      return original.classifyByJev(...args);
    }),
  };
});

import { getToolCache } from '../../../src/host/services/infra/toolCache';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';
import type { PermissionRequestData } from '../../../src/host/tools/types';
import { PermissionClassifier, getPermissionClassifier } from '../../../src/host/tools/permissionClassifier';
import { resetPolicyEnforcer } from '../../../src/host/security/policyEnforcer';
import { getPolicyEngine, resetPolicyEngine } from '../../../src/host/permissions/policyEngine';
import { resetPermissionModeManager } from '../../../src/host/permissions/modes';
import { OrchestratorPermissionIsland } from '../../../src/host/agent/orchestratorPermissions';
import type { AppSettings, PermissionAskResult } from '../../../src/shared/contract';
import type { PendingApprovalRepository } from '../../../src/host/services/core/repositories/PendingApprovalRepository';
import { usePermissionStore } from '../../../src/renderer/stores/permissionStore';
import type { PermissionRequestForMemory } from '../../../src/renderer/stores/permissionStore';

const CONNECTED_URL = 'https://open.feishu.cn/open-apis/wiki/v2/node';
const UNCONNECTED_URL = 'https://api.example-unconnected.test/v1/things';
const FETCHED = new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });

describe('http_request 连接器令牌写确认', () => {
  let workspace: string;
  let permissionRequests: PermissionRequestData[];
  let sid = 0;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'connector-token-write-'));
    permissionRequests = [];
    connectorEnv.provider = { id: 'feishu', displayName: '飞书' };
    jevState.approve = false;
    getToolCache().clear();
    resetPolicyEnforcer();
    resetPolicyEngine();
    getPolicyEngine();
    resetPermissionModeManager();
    getPermissionClassifier().clearCache();
    usePermissionStore.getState().clearPersistentMemory();
    usePermissionStore.getState().clearSessionMemory();
  });

  afterEach(async () => {
    // 单例分类器恢复默认档（route-1 用例会以 enableLlm=true 重建）。
    getPermissionClassifier({ enableLlm: false });
    getPermissionClassifier().clearCache();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  function buildExecutor(): ToolExecutor {
    const executor = new ToolExecutor({
      workingDirectory: workspace,
      requestPermission: async (request) => {
        permissionRequests.push(request);
        return false;
      },
    });
    executor.setAuditEnabled(false);
    return executor;
  }

  function sessionId(label: string): string {
    sid += 1;
    return `connector-token-${label}-${sid}`;
  }

  // --------------------------------------------------------------------------
  // (a) 分类器确定性规则 C1b
  // --------------------------------------------------------------------------

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    '分类器对已连接主机的 %s 判 ask + trustBoundary，且不进 LLM 档',
    async (method) => {
      const jevSystemOne = vi.fn(async () => {
        throw new Error('connector token write must not reach the Jev classifier');
      });
      const classifier = new PermissionClassifier({ enableLlm: true, jevSystemOne });

      const result = await classifier.classify(
        'http_request',
        { url: CONNECTED_URL, method },
        { workingDirectory: workspace, permissionLevel: 'network' },
      );

      expect(result).toMatchObject({
        decision: 'ask',
        confidence: 1,
        trustBoundary: true,
        traceStep: { rule: 'C1b: connector_token_write', result: 'ask' },
      });
      expect(result.reason).toContain('飞书');
      expect(result.reason).toContain('授权将附加到本次请求上');
      expect(jevSystemOne).not.toHaveBeenCalled();
    },
  );

  it('小写 method 同样命中（工具侧 upper-case 后注入令牌，判定同口径）', async () => {
    const result = await new PermissionClassifier().classify(
      'http_request',
      { url: CONNECTED_URL, method: 'post' },
      { workingDirectory: workspace, permissionLevel: 'network' },
    );
    expect(result).toMatchObject({ decision: 'ask', trustBoundary: true });
  });

  it.each([
    ['malformed url', { url: 'open.feishu.cn/open-apis', method: 'POST' }],
    ['missing url', { method: 'POST' }],
    ['non-string url', { url: 42, method: 'POST' }],
  ])('畸形参数不抛：%s', async (_label, args) => {
    const result = await new PermissionClassifier().classify(
      'http_request',
      args,
      { workingDirectory: workspace, permissionLevel: 'network' },
    );
    expect(result.decision).toBe('ask');
    expect(result.trustBoundary).toBeUndefined();
  });

  it('action=guide 不进确认门（只读回指南，不注入令牌）', async () => {
    const result = await new PermissionClassifier().classify(
      'http_request',
      { url: CONNECTED_URL, method: 'POST', action: 'guide' },
      { workingDirectory: workspace, permissionLevel: 'network' },
    );
    expect(result).toMatchObject({ decision: 'ask', riskUnknown: true });
    expect(result.trustBoundary).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  // (b) 三条自动放行路线全部失效（① 的三个用例）
  // --------------------------------------------------------------------------

  it('路线 1（分类器/LLM approve）：Jev 档愿意 approve 也压不住，仍出 forceConfirm 卡', async () => {
    jevState.approve = true;
    getPermissionClassifier({ enableLlm: true }); // 单例重建为 LLM 档开启
    const executor = buildExecutor();

    await executor.execute(
      'http_request',
      { url: CONNECTED_URL, method: 'POST' },
      { sessionId: sessionId('llm-approve') },
    );

    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBe(true);
    expect(permissionRequests[0].decisionTrace?.steps.at(-2)?.rule).toBe('C1b: connector_token_write');
  });

  it('路线 1 对照：未连接主机的 POST 被 Jev approve 直通（证明 mock 真会放行）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => FETCHED));
    try {
      jevState.approve = true;
      getPermissionClassifier({ enableLlm: true });
      const executor = buildExecutor();

      const result = await executor.execute(
        'http_request',
        { url: UNCONNECTED_URL, method: 'POST' },
        { sessionId: sessionId('llm-approve-control') },
      );

      expect(permissionRequests).toHaveLength(0);
      expect(result.success).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('路线 2（settings autoApprove.network / devModeAutoApprove）：真实审批岛不再秒批', async () => {
    const executor = buildExecutor();
    await executor.execute(
      'http_request',
      { url: CONNECTED_URL, method: 'POST' },
      { sessionId: sessionId('island') },
    );
    expect(permissionRequests).toHaveLength(1);
    const captured = permissionRequests[0];

    const settings = (overrides: Partial<AppSettings['permissions']>): AppSettings => ({
      permissions: {
        autoApprove: { read: false, write: false, execute: false, network: false },
        blockedCommands: [],
        devModeAutoApprove: false,
        ...overrides,
      },
    } as AppSettings);
    const makeIsland = (permissionSettings: Partial<AppSettings['permissions']>) =>
      new OrchestratorPermissionIsland({
        getSettings: () => settings(permissionSettings),
        isDevModeAutoApproveEnabled: () => permissionSettings.devModeAutoApprove === true,
        getExecutionTopology: () => 'main' as const,
        hasApprovalUi: () => false,
        onEvent: vi.fn(),
        injectedPendingApprovalRepo: {
          insert: vi.fn(),
          resolve: vi.fn(() => 1),
        } as unknown as PendingApprovalRepository,
      });

    // forceConfirm=true：autoApprove.network=true 与 devModeAutoApprove 都不得自动放行
    expect(await isStillPending(makeIsland({ autoApprove: { read: false, write: false, execute: false, network: true } }).requestPermission({ ...captured, sessionId: sessionId('island-net') }))).toBe(true);
    expect(await isStillPending(makeIsland({ devModeAutoApprove: true }).requestPermission({ ...captured, sessionId: sessionId('island-dev') }))).toBe(true);

    // 对照：同一请求去掉 forceConfirm 后两条路线都秒批（证明开关真的开着）
    const stripped = { ...captured, forceConfirm: undefined };
    await expect(makeIsland({ autoApprove: { read: false, write: false, execute: false, network: true } }).requestPermission({ ...stripped, sessionId: sessionId('island-net-ctrl') }))
      .resolves.toEqual({ approved: true, approvalSource: 'auto-approve-level' });
    await expect(makeIsland({ devModeAutoApprove: true }).requestPermission({ ...stripped, sessionId: sessionId('island-dev-ctrl') }))
      .resolves.toEqual({ approved: true, approvalSource: 'dev-auto-approve' });
  });

  it('路线 3（renderer allow-always / session 权限记忆）：forceConfirm 让记忆不直发', async () => {
    const executor = buildExecutor();
    await executor.execute(
      'http_request',
      { url: CONNECTED_URL, method: 'POST' },
      { sessionId: sessionId('memory') },
    );
    expect(permissionRequests).toHaveLength(1);
    const request = permissionRequests[0];

    // 预存 allow-always 记忆（键 = network:<hostname>，同主机的 GET 放行过就会命中）
    const store = usePermissionStore.getState();
    const seed: PermissionRequestForMemory = {
      id: 'seed',
      tool: 'http_request',
      type: 'network',
      details: { url: CONNECTED_URL },
    };
    store.saveMemory(seed, 'always');
    const memoryRequest: PermissionRequestForMemory = {
      id: 'captured',
      tool: request.tool,
      // host 侧 type 并集比 renderer 宽（多 directory_access）；本用例只会是 network，
      // 与 PermissionCard.normalizeRequest 的收窄同款。
      type: request.type as PermissionRequestForMemory['type'],
      details: { url: String(request.details.url) },
    };

    // PermissionCard 的记忆直发门（PermissionCard.tsx：forceConfirm !== true 才查记忆）
    const memoryResult = request.forceConfirm === true ? null : store.checkMemory(memoryRequest);
    expect(request.forceConfirm).toBe(true);
    expect(memoryResult).toBeNull();

    // 对照：同一请求去掉 forceConfirm 后记忆命中（证明记忆条目真实存在、本会直发）
    expect(usePermissionStore.getState().checkMemory(memoryRequest)).toBe('always');
    usePermissionStore.getState().clearPersistentMemory();

    // session 记忆同理
    store.saveMemory(seed, 'session');
    expect(request.forceConfirm === true ? null : usePermissionStore.getState().checkMemory(memoryRequest)).toBeNull();
    expect(usePermissionStore.getState().checkMemory(memoryRequest)).toBe('session');
  });

  // --------------------------------------------------------------------------
  // (c) 审批负载：连接器身份 + 令牌附着声明 + connectorTokenAttached
  // --------------------------------------------------------------------------

  it('审批卡负载带 connector.external_write 边界、连接器名与 zh/en 附着声明', async () => {
    const executor = buildExecutor();
    await executor.execute(
      'http_request',
      { url: CONNECTED_URL, method: 'POST' },
      { sessionId: sessionId('payload') },
    );

    expect(permissionRequests).toHaveLength(1);
    const request = permissionRequests[0];
    expect(request.type).toBe('network');
    expect(request.details.connectorTokenAttached).toBe(true);
    expect(request.boundary?.id).toBe('connector.external_write');
    expect(request.boundary?.connectorName).toBe('飞书');
    expect(request.boundary?.connectorNameEn).toBe('飞书');
    expect(request.reason).toContain('飞书');
    expect(request.reason).toContain('你的授权将附加到本次请求上');
    expect(request.boundary?.reasonEn).toContain('attach your authorization to this request');
    expect(request.forceConfirm).toBe(true);
  });

  // --------------------------------------------------------------------------
  // (d) skill 预授权 + main 基线（GET/HEAD/OPTIONS、未连接 POST）
  // --------------------------------------------------------------------------

  it('skill preApprovedTools 含 http_request 仍出 forceConfirm 卡（不得跳过分类）', async () => {
    const executor = buildExecutor();
    await executor.execute(
      'http_request',
      { url: CONNECTED_URL, method: 'POST' },
      { sessionId: sessionId('preapproved'), preApprovedTools: new Set(['http_request']) },
    );
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBe(true);
    expect(permissionRequests[0].details.connectorTokenAttached).toBe(true);
  });

  it('skill 预授权对照：GET 到同一主机照常被预授权直通', async () => {
    const executor = buildExecutor();
    const result = await executor.execute(
      'http_request',
      { url: CONNECTED_URL },
      { sessionId: sessionId('preapproved-ctrl'), preApprovedTools: new Set(['http_request']) },
    );
    // 预授权生效 = 权限层放行（零卡片），调用进到工具自身的连接器指南门（main 行为）
    expect(permissionRequests).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('Read the connector guide');
  });

  it.each(['GET', 'HEAD', 'OPTIONS'])('基线：已连接主机的 %s 与 main 同形（fallback ask、无 forceConfirm、通用边界）', async (method) => {
    const classifier = new PermissionClassifier({ enableLlm: false });
    const direct = await classifier.classify(
      'http_request',
      { url: CONNECTED_URL, method },
      { workingDirectory: workspace, permissionLevel: 'network' },
    );
    // main 基线（2026-10-06 在未改动树上实测捕获）
    expect(direct).toMatchObject({
      decision: 'ask',
      confidence: 0,
      riskUnknown: true,
      traceStep: { rule: 'fallback', result: 'ask' },
    });
    expect(direct.trustBoundary).toBeUndefined();

    const executor = buildExecutor();
    await executor.execute(
      'http_request',
      { url: CONNECTED_URL, method },
      { sessionId: sessionId(`baseline-${method}`) },
    );
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBeUndefined();
    expect(permissionRequests[0].details.connectorTokenAttached).toBeUndefined();
    expect(permissionRequests[0].boundary?.id).toBe('network.web_request');
  });

  it('基线：未连接主机的 POST 与 main 同形', async () => {
    connectorEnv.provider = undefined;
    const classifier = new PermissionClassifier({ enableLlm: false });
    const direct = await classifier.classify(
      'http_request',
      { url: UNCONNECTED_URL, method: 'POST' },
      { workingDirectory: workspace, permissionLevel: 'network' },
    );
    expect(direct).toMatchObject({ decision: 'ask', confidence: 0, riskUnknown: true });
    expect(direct.trustBoundary).toBeUndefined();

    const executor = buildExecutor();
    await executor.execute(
      'http_request',
      { url: UNCONNECTED_URL, method: 'POST' },
      { sessionId: sessionId('baseline-unconnected') },
    );
    expect(permissionRequests).toHaveLength(1);
    expect(permissionRequests[0].forceConfirm).toBeUndefined();
    expect(permissionRequests[0].details.connectorTokenAttached).toBeUndefined();
    expect(permissionRequests[0].boundary?.id).toBe('network.web_request');
  });
});

function isStillPending(promise: Promise<PermissionAskResult>): Promise<boolean> {
  const pending = Symbol('pending');
  return Promise.race([promise, Promise.resolve(pending)]).then((result) => result === pending);
}
